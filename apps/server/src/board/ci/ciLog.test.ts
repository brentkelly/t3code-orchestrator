// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reading a CI step's log (T3O-60): where a read starts, chunking, UTF-8
 * characters cut across reads, following growth, a log replaced under the
 * reader, the end rule, the worker's path guard and an old worker.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  BOARD_CI_LOG_CHUNK_BYTES,
  type BoardCardDetail,
  type BoardCiLogItem,
  type BoardCiPassStep,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  BOARD_CI_LOG_TAIL_BYTES,
  isBoardCiLogSettled,
  isSafeBoardCiLogTarget,
  readBoardCiLog,
  readBoardCiLogFile,
  utf8CompleteLength,
  type BoardCiLogDeps,
} from "./ciLog.ts";

const tempLog = (contents: string | Uint8Array = "") => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ci-log-"));
  const path = NodePath.join(dir, "0.log");
  NodeFS.writeFileSync(path, contents);
  return path;
};

const collect = (stream: Stream.Stream<BoardCiLogItem>) =>
  Stream.runCollect(stream).pipe(Effect.map((items) => [...items]));

const textOf = (items: ReadonlyArray<BoardCiLogItem>) =>
  items.map((item) => (item._tag === "chunk" ? item.text : "")).join("");

/** A followed read whose growth checks the test steps one at a time. */
const following = Effect.fn(function* (
  start: (poll: Effect.Effect<void>) => Stream.Stream<BoardCiLogItem>,
) {
  const ticks = yield* Queue.unbounded<void>();
  const items = yield* Queue.unbounded<BoardCiLogItem>();
  yield* start(Queue.take(ticks)).pipe(
    Stream.runForEach((item) => Queue.offer(items, item)),
    Effect.forkScoped,
  );
  return {
    next: Queue.take(items),
    tick: Queue.offer(ticks, undefined),
  };
});

it("finds the last whole UTF-8 character", () => {
  const bytes = Buffer.from("aé€😀", "utf8");
  assert.strictEqual(utf8CompleteLength(bytes), bytes.length);
  // Cut inside each multi-byte character: the partial sequence is held.
  assert.strictEqual(utf8CompleteLength(bytes.subarray(0, 2)), 1);
  assert.strictEqual(utf8CompleteLength(bytes.subarray(0, 5)), 3);
  assert.strictEqual(utf8CompleteLength(bytes.subarray(0, 8)), 6);
  assert.strictEqual(utf8CompleteLength(bytes.subarray(0, 9)), 6);
  assert.strictEqual(utf8CompleteLength(new Uint8Array(0)), 0);
});

it("lets a worker read only a plain run id and index", () => {
  assert.isTrue(isSafeBoardCiLogTarget("ci-run-1", 0));
  for (const runId of ["", ".", "..", "../x", "a/b", "a\\b", "a\0b", "x..y"]) {
    assert.isFalse(isSafeBoardCiLogTarget(runId, 0), runId);
  }
  assert.isFalse(isSafeBoardCiLogTarget("run", -1));
  assert.isFalse(isSafeBoardCiLogTarget("run", 1.5));
});

it.effect("reads a whole log from an offset in chunks of at most 1 MiB", () =>
  Effect.gen(function* () {
    const contents = "x".repeat(BOARD_CI_LOG_CHUNK_BYTES * 2 + 10);
    const path = tempLog(contents);
    const items = yield* collect(readBoardCiLogFile(path, { fromOffset: 0, follow: false }));
    const chunks = items.filter((item) => item._tag === "chunk");
    assert.deepStrictEqual(
      chunks.map((chunk) => chunk.offset),
      [0, BOARD_CI_LOG_CHUNK_BYTES, BOARD_CI_LOG_CHUNK_BYTES * 2],
    );
    assert.strictEqual(textOf(items), contents);
    assert.deepStrictEqual(items.at(-1), { _tag: "end", size: contents.length });

    const later = yield* collect(readBoardCiLogFile(path, { fromOffset: 5, follow: false }));
    assert.strictEqual(textOf(later), contents.slice(5));
  }),
);

it.effect("starts a read with no offset at the last 256 KiB, on a line start", () =>
  Effect.gen(function* () {
    const line = `${"a".repeat(99)}\n`;
    const contents = line.repeat(5_000);
    const path = tempLog(contents);
    const items = yield* collect(readBoardCiLogFile(path, { follow: false }));
    const first = items[0]!;
    assert.strictEqual(first._tag, "chunk");
    const offset = first._tag === "chunk" ? first.offset : -1;
    assert.isAtLeast(offset, contents.length - BOARD_CI_LOG_TAIL_BYTES);
    assert.strictEqual(offset % line.length, 0, "it starts on a whole line");
    assert.strictEqual(textOf(items), contents.slice(offset));

    const small = yield* collect(readBoardCiLogFile(tempLog("one\ntwo\n"), { follow: false }));
    assert.deepStrictEqual(small[0], { _tag: "chunk", offset: 0, end: 8, text: "one\ntwo\n" });
  }),
);

it.effect("keeps a character cut by the chunk boundary whole, in the later chunk", () =>
  Effect.gen(function* () {
    const contents = `${"a".repeat(BOARD_CI_LOG_CHUNK_BYTES - 1)}é tail`;
    const items = yield* collect(
      readBoardCiLogFile(tempLog(contents), { fromOffset: 0, follow: false }),
    );
    const chunks = items.filter((item) => item._tag === "chunk");
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[1]!.offset, BOARD_CI_LOG_CHUNK_BYTES - 1);
    assert.isTrue(chunks[1]!.text.startsWith("é"));
    assert.strictEqual(textOf(items), contents);
  }),
);

it.effect("an invalid byte keeps every chunk's end on the file's real bytes", () =>
  Effect.gen(function* () {
    // 0xff decodes to U+FFFD, three bytes in UTF-8 for one in the file.
    const contents = Buffer.concat([Buffer.from("bad "), Buffer.from([0xff]), Buffer.from(" x\n")]);
    const items = yield* collect(
      readBoardCiLogFile(tempLog(contents), { fromOffset: 0, follow: false }),
    );
    assert.deepStrictEqual(items, [
      { _tag: "chunk", offset: 0, end: contents.length, text: "bad � x\n" },
      { _tag: "end", size: contents.length },
    ]);
  }),
);

it.effect("a missing log, or an offset past its end, is missing", () =>
  Effect.gen(function* () {
    const path = tempLog("short\n");
    const past = yield* collect(readBoardCiLogFile(path, { fromOffset: 99, follow: false }));
    assert.strictEqual(past[0]?._tag, "missing");
    const gone = yield* collect(
      readBoardCiLogFile(`${path}.nope`, { fromOffset: 0, follow: false }),
    );
    assert.strictEqual(gone.length, 1);
    assert.strictEqual(gone[0]?._tag, "missing");
  }),
);

it.effect("follows a growing log, holding a cut character, until it shrinks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = tempLog("one\n");
      const log = yield* following((poll) =>
        readBoardCiLogFile(path, { fromOffset: 0, follow: true, poll }),
      );
      assert.deepStrictEqual(yield* log.next, { _tag: "chunk", offset: 0, end: 4, text: "one\n" });

      const accent = Buffer.from("é", "utf8");
      NodeFS.appendFileSync(path, Buffer.concat([Buffer.from("two\n"), accent.subarray(0, 1)]));
      yield* log.tick;
      assert.deepStrictEqual(yield* log.next, { _tag: "chunk", offset: 4, end: 8, text: "two\n" });

      NodeFS.appendFileSync(path, Buffer.concat([accent.subarray(1), Buffer.from("\n")]));
      yield* log.tick;
      assert.deepStrictEqual(yield* log.next, { _tag: "chunk", offset: 8, end: 11, text: "é\n" });

      NodeFS.truncateSync(path, 2);
      yield* log.tick;
      assert.strictEqual((yield* log.next)._tag, "missing");
    }),
  ),
);

it.effect("a followed log that doesn't exist yet is waited for", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = `${tempLog()}.later`;
      const log = yield* following((poll) => readBoardCiLogFile(path, { follow: true, poll }));
      NodeFS.writeFileSync(path, "hello\n");
      yield* log.tick;
      assert.deepStrictEqual(yield* log.next, {
        _tag: "chunk",
        offset: 0,
        end: 6,
        text: "hello\n",
      });
    }),
  ),
);

it("a log stops growing once its step settles, its pass finishes or the card moves on", () => {
  const detail = (
    step: BoardCiPassStep["status"],
    extra: { finishedAt?: string; runId?: string },
  ) =>
    ({
      card: { ci: { runId: extra.runId ?? "run-1" } },
      ciPasses: [
        { runId: "run-1", finishedAt: extra.finishedAt ?? null, steps: [{ status: step }] },
      ],
    }) as unknown as BoardCardDetail;
  assert.isFalse(isBoardCiLogSettled(detail("running", {}), "run-1", 0));
  assert.isTrue(isBoardCiLogSettled(detail("failed", {}), "run-1", 0));
  assert.isTrue(
    isBoardCiLogSettled(detail("running", { finishedAt: "2026-11-10T00:00:00.000Z" }), "run-1", 0),
  );
  assert.isTrue(isBoardCiLogSettled(detail("running", { runId: "run-2" }), "run-1", 0));
  assert.isTrue(isBoardCiLogSettled(null, "run-1", 0));
});

/** A card whose pass `run-1` has one script step, logging into `logDir`. */
const cardDetail = (input: {
  readonly logDir: string;
  readonly status: BoardCiPassStep["status"];
  readonly placedWorkerId?: string;
  readonly kind?: BoardCiPassStep["kind"];
}) =>
  ({
    card: {
      ci: { runId: "run-1" },
      worktree: {
        status: "ready",
        path: NodePath.dirname(NodePath.dirname(NodePath.dirname(input.logDir))),
      },
      placedWorkerId: input.placedWorkerId ?? null,
      pinnedWorkerId: null,
    },
    ciPasses: [
      {
        runId: "run-1",
        finishedAt: null,
        logDir: input.logDir,
        steps: [
          { status: input.status, ...(input.kind === undefined ? {} : { kind: input.kind }) },
        ],
      },
    ],
  }) as unknown as BoardCardDetail;

const passLogDir = () => {
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ci-wt-"));
  const logDir = NodePath.join(worktree, ".t3", "ci", "run-1");
  NodeFS.mkdirSync(logDir, { recursive: true });
  return { worktree, logDir };
};

const readInput = { cardId: "card-1", runId: "run-1", index: 0, fromOffset: 0, follow: true };

it.effect("follows a running step, then reads the flushed rest and ends once it settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { logDir } = passLogDir();
      const path = NodePath.join(logDir, "0.log");
      NodeFS.writeFileSync(path, "first\n");
      let detail = cardDetail({ logDir, status: "running" });
      const changes = yield* Queue.unbounded<void>();
      const log = yield* following((poll) =>
        readBoardCiLog(
          {
            readDetail: () => Effect.succeed(detail),
            subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
            poll,
            worker: () => Effect.succeed(null),
          },
          readInput as never,
        ),
      );
      assert.deepStrictEqual(yield* log.next, {
        _tag: "chunk",
        offset: 0,
        end: 6,
        text: "first\n",
      });

      // The step settles with its last output flushed, before any poll sees it.
      NodeFS.appendFileSync(path, "last\n");
      detail = cardDetail({ logDir, status: "passed" });
      yield* Queue.offer(changes, undefined);
      assert.deepStrictEqual(yield* log.next, {
        _tag: "chunk",
        offset: 6,
        end: 11,
        text: "last\n",
      });
      assert.deepStrictEqual(yield* log.next, { _tag: "end", size: 11 });
    }),
  ),
);

it.effect("a log with an invalid byte still ends cleanly when its step settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { logDir } = passLogDir();
      const path = NodePath.join(logDir, "0.log");
      NodeFS.writeFileSync(path, Buffer.from([0x61, 0xff, 0x0a]));
      let detail = cardDetail({ logDir, status: "running" });
      const changes = yield* Queue.unbounded<void>();
      const log = yield* following((poll) =>
        readBoardCiLog(
          {
            readDetail: () => Effect.succeed(detail),
            subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
            poll,
            worker: () => Effect.succeed(null),
          },
          readInput as never,
        ),
      );
      assert.deepStrictEqual(yield* log.next, {
        _tag: "chunk",
        offset: 0,
        end: 3,
        text: "a�\n",
      });
      detail = cardDetail({ logDir, status: "failed" });
      yield* Queue.offer(changes, undefined);
      assert.deepStrictEqual(yield* log.next, { _tag: "end", size: 3 });
    }),
  ),
);

it.effect("a failed detail re-read keeps following rather than ending the log", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { logDir } = passLogDir();
      const path = NodePath.join(logDir, "0.log");
      NodeFS.writeFileSync(path, "first\n");
      let reads = 0;
      const failed = yield* Deferred.make<void>();
      const changes = yield* Queue.unbounded<void>();
      const log = yield* following((poll) =>
        readBoardCiLog(
          {
            readDetail: () => {
              reads++;
              if (reads === 2) {
                return Deferred.succeed(failed, undefined).pipe(
                  Effect.andThen(Effect.fail("board busy")),
                );
              }
              return Effect.succeed(
                cardDetail({ logDir, status: reads === 1 ? "running" : "passed" }),
              );
            },
            subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
            poll,
            worker: () => Effect.succeed(null),
          },
          readInput as never,
        ).pipe(Stream.orDie),
      );
      assert.strictEqual((yield* log.next)._tag, "chunk");
      yield* Queue.offer(changes, undefined);
      yield* Deferred.await(failed);
      for (const text of ["more\n", "again\n"]) {
        NodeFS.appendFileSync(path, text);
        yield* log.tick;
        const item = yield* log.next;
        assert.strictEqual(item._tag === "chunk" ? item.text : item._tag, text);
      }
      yield* Queue.offer(changes, undefined);
      assert.deepStrictEqual(yield* log.next, { _tag: "end", size: 17 });
    }),
  ),
);

it.effect("a settle committed while the first detail read runs still ends the follow", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { logDir } = passLogDir();
      NodeFS.writeFileSync(NodePath.join(logDir, "0.log"), "only\n");
      const board = yield* PubSub.unbounded<void>();
      let reads = 0;
      const log = yield* following((poll) =>
        readBoardCiLog(
          {
            // The step's settle event is published while each of the
            // first two reads is in flight, and both still see it running.
            readDetail: () =>
              Effect.gen(function* () {
                reads++;
                if (reads <= 2) {
                  yield* PubSub.publish(board, undefined);
                  return cardDetail({ logDir, status: "running" });
                }
                return cardDetail({ logDir, status: "passed" });
              }),
            subscribeChanges: PubSub.subscribe(board).pipe(Effect.map(Stream.fromSubscription)),
            poll,
            worker: () => Effect.succeed(null),
          },
          readInput as never,
        ),
      );
      assert.strictEqual((yield* log.next)._tag, "chunk");
      assert.deepStrictEqual(yield* log.next, { _tag: "end", size: 5 });
    }),
  ),
);

it.effect("reads a placed card's log from its worker, and an old worker's is missing", () =>
  Effect.gen(function* () {
    const { worktree, logDir } = passLogDir();
    const asked: unknown[] = [];
    const deps = (
      remote: (input: unknown) => Stream.Stream<BoardCiLogItem, unknown>,
    ): BoardCiLogDeps<never> => ({
      readDetail: () =>
        Effect.succeed(cardDetail({ logDir, status: "passed", placedWorkerId: "worker-1" })),
      subscribeChanges: Effect.succeed(Stream.empty),
      worker: () => Effect.succeed(remote),
    });
    const served = yield* collect(
      readBoardCiLog(
        deps((input) => {
          asked.push(input);
          return Stream.make<ReadonlyArray<BoardCiLogItem>>(
            { _tag: "chunk", offset: 0, end: 7, text: "remote\n" },
            { _tag: "end", size: 7 },
          );
        }),
        readInput as never,
      ),
    );
    assert.strictEqual(textOf(served), "remote\n");
    // A settled step is read once, never followed.
    assert.deepStrictEqual(asked, [
      { worktreePath: worktree, runId: "run-1", index: 0, follow: false, fromOffset: 0 },
    ]);

    const old = yield* collect(
      readBoardCiLog(
        deps(() => Stream.fail(new Error("unknown method"))),
        readInput as never,
      ),
    );
    assert.strictEqual(old.length, 1);
    assert.strictEqual(old[0]?._tag, "missing");
  }),
);

it.effect("names no log for a step that isn't a script", () =>
  Effect.gen(function* () {
    const { logDir } = passLogDir();
    const items = yield* collect(
      readBoardCiLog(
        {
          readDetail: () => Effect.succeed(cardDetail({ logDir, status: "passed", kind: "agent" })),
          subscribeChanges: Effect.succeed(Stream.empty),
          worker: () => Effect.succeed(null),
        },
        readInput as never,
      ),
    );
    assert.deepStrictEqual(
      items.map((item) => item._tag),
      ["missing"],
    );
  }),
);
