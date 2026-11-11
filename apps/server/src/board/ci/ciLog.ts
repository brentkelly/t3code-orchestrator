// @effect-diagnostics nodeBuiltinImport:off
/**
 * A CI step's log, `<logDir>/<index>.log`. Chunks are at most 1 MiB and cut on
 * UTF-8 boundaries, so each `offset` is the exact byte offset of its first
 * character. The client never names a path: the server finds it from the pass.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BOARD_CI_LOG_CHUNK_BYTES,
  BOARD_LOCAL_WORKER_ID,
  boardCardBoundWorkerId,
  type BoardCardDetail,
  type BoardCiLogItem,
  type BoardReadCiLogInput,
  type BoardWorkerReadCiLogInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { boardCiLogDir } from "./BoardCiRunner.ts";

/** How much of a log a read without an offset starts with. */
export const BOARD_CI_LOG_TAIL_BYTES = 256 * 1024;
/** How often a followed log is checked for growth. */
const BOARD_CI_LOG_POLL_MS = 500;

const NEWLINE = 0x0a;

/** The length of `bytes`' longest prefix that ends on a UTF-8 character
    boundary: a sequence cut short at the end is held for the next read. */
export function utf8CompleteLength(bytes: Uint8Array): number {
  const end = bytes.length;
  for (let back = 1; back <= Math.min(4, end); back++) {
    const byte = bytes[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? end - back : end;
  }
  return end;
}

/** A run id and index a worker may turn into a log path: one plain path
    segment each, never a separator or a parent. */
export function isSafeBoardCiLogTarget(runId: string, index: number): boolean {
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    runId.length > 0 &&
    runId !== "." &&
    !runId.includes("..") &&
    !/[/\\\0]/.test(runId)
  );
}

const missing = (reason: string): BoardCiLogItem => ({ _tag: "missing", reason });

/** The file's size, or null when it doesn't exist. */
const statSize = (path: string) =>
  Effect.tryPromise({
    try: () => NodeFS.promises.stat(path),
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.map((stats) => stats.size),
    Effect.orElseSucceed(() => null),
  );

const readBytes = (path: string, position: number, length: number) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await NodeFS.promises.open(path, "r");
      try {
        const buffer = new Uint8Array(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });

/** Where a read without an offset starts: the last 256 KiB, moved on to the
    start of its first whole line. */
const tailStart = Effect.fn("BoardCiLog.tailStart")(function* (path: string, size: number) {
  if (size <= BOARD_CI_LOG_TAIL_BYTES) return 0;
  const start = size - BOARD_CI_LOG_TAIL_BYTES;
  const window = yield* readBytes(path, start, Math.min(64 * 1024, size - start));
  const newline = window.indexOf(NEWLINE);
  return newline === -1 ? start : start + newline + 1;
});

const decoder = new TextDecoder();

/** Read one log file; see the module comment. Never fails: a file it can't
    read ends the stream with `missing`. */
export const readBoardCiLogFile = (
  path: string,
  options: {
    readonly fromOffset?: number | undefined;
    readonly follow: boolean;
    /** The wait between growth checks; tests step it by hand. */
    readonly poll?: Effect.Effect<void> | undefined;
  },
): Stream.Stream<BoardCiLogItem> =>
  Stream.callback<BoardCiLogItem>((queue) => {
    let position: number | null = null;
    let held: Uint8Array = new Uint8Array(0);

    /** Start reading a file of `size` bytes; false when the offset is past it. */
    const begin = Effect.fn("BoardCiLog.begin")(function* (size: number) {
      if (options.fromOffset !== undefined && options.fromOffset > size) return false;
      position = options.fromOffset ?? (yield* tailStart(path, size));
      return true;
    });

    // Untraced: runs on every poll tick of a followed log.
    const readTo = Effect.fnUntraced(function* (size: number) {
      while (position !== null && position < size) {
        const bytes = yield* readBytes(
          path,
          position,
          Math.min(BOARD_CI_LOG_CHUNK_BYTES, size - position),
        );
        if (bytes.length === 0) return;
        const offset = position - held.length;
        position += bytes.length;
        const combined = new Uint8Array(held.length + bytes.length);
        combined.set(held);
        combined.set(bytes, held.length);
        const complete = utf8CompleteLength(combined);
        held = combined.slice(complete);
        if (complete > 0) {
          yield* Queue.offer(queue, {
            _tag: "chunk",
            offset,
            end: offset + complete,
            text: decoder.decode(combined.subarray(0, complete)),
          });
        }
      }
    });

    const finish = (item: BoardCiLogItem) =>
      Queue.offer(queue, item).pipe(Effect.andThen(Queue.end(queue)));

    const once = Effect.gen(function* () {
      const size = yield* statSize(path);
      if (size === null) return yield* finish(missing("The log no longer exists."));
      if (!(yield* begin(size))) return yield* finish(missing("The log is shorter than that."));
      yield* readTo(size);
      const end = position ?? 0;
      if (held.length > 0) {
        yield* Queue.offer(queue, {
          _tag: "chunk",
          offset: end - held.length,
          end,
          text: decoder.decode(held),
        });
      }
      yield* finish({ _tag: "end", size: end });
    });

    // Follows until the reader closes the stream. A file not there yet is
    // waited for; one that shrinks or goes away was replaced under us.
    const follow = Effect.gen(function* () {
      for (;;) {
        const size = yield* statSize(path);
        if (size === null) {
          if (position !== null) return yield* finish(missing("The log no longer exists."));
        } else {
          if (position === null && !(yield* begin(size))) {
            return yield* finish(missing("The log is shorter than that."));
          }
          if (position !== null && size < position) {
            return yield* finish(missing("The log was replaced while it was being read."));
          }
          yield* readTo(size);
        }
        yield* options.poll ?? Effect.sleep(BOARD_CI_LOG_POLL_MS);
      }
    });

    return (options.follow ? follow : once).pipe(
      Effect.catch((message) => finish(missing(`The log couldn't be read: ${message}`))),
    );
  });

/**
 * Follow a log until `settled` completes, then read what's left and end.
 * Without `follow`, a single read to the end.
 */
const followBoardCiLogUntil = (input: {
  readonly read: (options: {
    readonly fromOffset?: number | undefined;
    readonly follow: boolean;
  }) => Stream.Stream<BoardCiLogItem>;
  readonly fromOffset?: number | undefined;
  readonly follow: boolean;
  readonly settled: Effect.Effect<void>;
}): Stream.Stream<BoardCiLogItem> => {
  if (!input.follow) return input.read({ fromOffset: input.fromOffset, follow: false });
  let next = input.fromOffset;
  let ended = false;
  const live = input.read({ fromOffset: input.fromOffset, follow: true }).pipe(
    Stream.tap((item) =>
      Effect.sync(() => {
        if (item._tag === "chunk") next = item.end;
        else ended = true;
      }),
    ),
    Stream.interruptWhen(input.settled),
  );
  return Stream.concat(
    live,
    Stream.suspend(() => (ended ? Stream.empty : input.read({ fromOffset: next, follow: false }))),
  );
};

/** Whether a step's log has stopped growing (the end rule): the step
    settled, its pass finished, or the card moved to another pass. */
export function isBoardCiLogSettled(
  detail: BoardCardDetail | null,
  runId: string,
  index: number,
): boolean {
  if (detail === null) return true;
  const pass = detail.ciPasses.find((candidate) => candidate.runId === runId);
  if (pass === undefined || pass.finishedAt !== null) return true;
  if (detail.card.ci?.runId !== runId) return true;
  const status = pass.steps[index]?.status;
  return status !== "running" && status !== "pending";
}

export interface BoardCiLogDeps<E> {
  readonly readDetail: (
    cardId: BoardReadCiLogInput["cardId"],
  ) => Effect.Effect<BoardCardDetail | null, E>;
  /** Subscribes, in the scope, to ticks whenever the board may have changed. */
  readonly subscribeChanges: Effect.Effect<Stream.Stream<unknown>, never, Scope.Scope>;
  /** The local reader's wait between growth checks; tests step it by hand. */
  readonly poll?: Effect.Effect<void>;
  /** A worker's log reader, or null when the worker can't be reached. */
  readonly worker: (
    workerId: EnvironmentId,
  ) => Effect.Effect<
    ((input: BoardWorkerReadCiLogInput) => Stream.Stream<BoardCiLogItem, unknown>) | null
  >;
}

/** The worktree a pass's `logDir` sits in, when it is the board's own
    `<worktree>/.t3/ci/<runId>` layout. */
const worktreeOfLogDir = (logDir: string, runId: string): string | null => {
  const worktree = NodePath.dirname(NodePath.dirname(NodePath.dirname(logDir)));
  return boardCiLogDir(worktree, runId) === NodePath.normalize(logDir) ? worktree : null;
};

/** `board.readCiLog`: see the module comment. */
export const readBoardCiLog = <E>(
  deps: BoardCiLogDeps<E>,
  input: BoardReadCiLogInput,
): Stream.Stream<BoardCiLogItem, E> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Attached before the first read, so a settle committed during it
      // still wakes the end rule (as `board.subscribeCard` does).
      const wake = yield* Queue.sliding<void>(1);
      if (input.follow === true) {
        const changes = yield* deps.subscribeChanges;
        yield* Effect.forkScoped(Stream.runForEach(changes, () => Queue.offer(wake, undefined)));
      }
      const detail = yield* deps.readDetail(input.cardId);
      if (detail === null) return Stream.make(missing("The card no longer exists."));
      const pass = detail.ciPasses.find((candidate) => candidate.runId === input.runId);
      const step = pass?.steps[input.index];
      if (pass === undefined || step === undefined) {
        return Stream.make(missing("That CI step isn't on this card."));
      }
      if ((step.kind ?? "script") !== "script") {
        return Stream.make(missing("Only script steps have a log."));
      }
      if (pass.logDir === null) return Stream.make(missing("This pass kept no logs."));
      const logDir = pass.logDir;

      const workerId = boardCardBoundWorkerId(detail.card) ?? BOARD_LOCAL_WORKER_ID;
      let read: (options: {
        readonly fromOffset?: number | undefined;
        readonly follow: boolean;
      }) => Stream.Stream<BoardCiLogItem>;
      if (workerId === BOARD_LOCAL_WORKER_ID) {
        const path = NodePath.join(logDir, `${input.index}.log`);
        read = (options) => readBoardCiLogFile(path, { ...options, poll: deps.poll });
      } else {
        const worktreePath = worktreeOfLogDir(logDir, input.runId);
        const remote = yield* deps.worker(workerId);
        if (worktreePath === null || remote === null) {
          return Stream.make(missing("The card's worker can't be reached."));
        }
        read = (options) =>
          remote({
            worktreePath,
            runId: input.runId,
            index: input.index,
            follow: options.follow,
            ...(options.fromOffset === undefined ? {} : { fromOffset: options.fromOffset }),
          }).pipe(
            // An old worker has no such method; any failure leaves no log to show.
            Stream.catchCause(() =>
              Stream.make(
                missing("The card's worker couldn't send the log. It may need updating."),
              ),
            ),
          );
      }

      const settledNow = isBoardCiLogSettled(detail, input.runId, input.index);
      // A burst of board changes landing during a re-read is one more wake.
      const settled = Stream.fromQueue(wake).pipe(
        // A failed re-read says nothing about the step: the follow goes on
        // until a later change reads cleanly.
        Stream.mapEffect(() =>
          deps.readDetail(input.cardId).pipe(
            Effect.map((latest) => isBoardCiLogSettled(latest, input.runId, input.index)),
            Effect.orElseSucceed(() => false),
          ),
        ),
        Stream.filter((settledNow) => settledNow),
        Stream.take(1),
        Stream.runDrain,
      );
      return followBoardCiLogUntil({
        read,
        fromOffset: input.fromOffset,
        follow: input.follow === true && !settledNow,
        settled,
      });
    }),
  );
