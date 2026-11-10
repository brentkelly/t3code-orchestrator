/**
 * The board has its own log and sequence, so it streams separately from the
 * orchestration shell (one stream with two counters would drop deltas). Resume
 * follows v1 shell semantics; the todo subscription attaches before any read.
 */
import {
  BoardSnapshotError,
  isLocalOnlyBoardWorkers,
  type BoardCardId,
  type BoardCardThreadShell,
  type BoardShellStreamEvent,
  type BoardShellStreamItem,
  BoardWorkersState,
  type BoardSubscribeBoardInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { BoardEngine } from "./BoardEngine.ts";
import { BoardQueries } from "./BoardQueries.ts";
import { BoardThreadTail } from "./boardThreadTail.ts";
import type { BoardQueriesShape } from "./projection.ts";
import { boardShellStreamEvent, type BoardEvent } from "./projector.ts";
import { BoardWorkers } from "./workers/BoardWorkers.ts";

/**
 * Replaying more board events than this costs more than one snapshot: each
 * replayed link change is a `card-threads` read, and a snapshot is a handful of
 * bounded table scans. Matches the orchestration shell's own bound.
 */
const BOARD_RESUME_MAX_GAP = 1_000;

/** The coalescing window, matching the orchestration shell's. */
const BOARD_STREAM_WINDOW = Duration.millis(50);
const BOARD_STREAM_MAX_CHUNK = 512;

/** One input to the board stream: a committed board event, or a linked
    thread's todo list changing (the read-only upstream tail). */
export type BoardStreamInput =
  | { readonly kind: "board"; readonly event: BoardEvent }
  | { readonly kind: "todo"; readonly threadId: ThreadId };

/**
 * Board deltas pass through uncollapsed: they omit keys they cannot see, so
 * dropping one would lose a change. `card-threads` is refetched once per touched
 * card per window, stamped with the head and applied without the sequence guard.
 */
// Untraced: runs for every coalesced stream window of every board client.
export const boardStreamWindowDeltas = Effect.fnUntraced(function* (
  inputs: Iterable<BoardStreamInput>,
  deps: {
    readonly queries: Pick<BoardQueriesShape, "boardCardThreads" | "boardCardIdForThread">;
    readonly latestSequence: Effect.Effect<number>;
    /** The worker summary, re-sent after a window that changed the registry
        (T3O-62). Absent in suites that are not about workers. */
    readonly workersState?: Effect.Effect<BoardWorkersState>;
  },
) {
  const deltas: BoardShellStreamEvent[] = [];
  const touchedCards = new Set<BoardCardId>();
  const touchedThreads = new Set<ThreadId>();
  let touchedWorkers = false;
  for (const input of inputs) {
    if (input.kind === "todo") {
      touchedThreads.add(input.threadId);
      continue;
    }
    const delta = boardShellStreamEvent(input.event);
    if (Option.isSome(delta)) deltas.push(delta.value);
    if (
      input.event.type === "board.worker-registered" ||
      input.event.type === "board.worker-removed" ||
      input.event.type === "board.default-worker-set"
    ) {
      touchedWorkers = true;
    }
    // A card's link set changing is what the `card-threads` delta carries. An
    // unarchived card is back on the board without the thread entries its
    // archive's `card-removed` dropped.
    if (
      input.event.type === "board.card-thread-linked" ||
      input.event.type === "board.card-thread-unlinked" ||
      input.event.type === "board.card-unarchived"
    ) {
      touchedCards.add(input.event.payload.cardId);
    }
  }
  // A todo list changed (or its thread was deleted, which drops the row while
  // the link stays live): find the card it belongs to.
  for (const threadId of touchedThreads) {
    const cardId = yield* deps.queries
      .boardCardIdForThread(threadId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (cardId !== null) touchedCards.add(cardId);
  }
  // A registry change replayed from the log (or live) carries no delta of
  // its own: the summary mixes in runtime status, so it is read whole.
  if (touchedWorkers && deps.workersState !== undefined) {
    deltas.push({
      kind: "workers",
      sequence: yield* deps.latestSequence,
      state: yield* deps.workersState,
    });
  }
  if (touchedCards.size === 0) return deltas;
  const sequence = yield* deps.latestSequence;
  for (const cardId of touchedCards) {
    const threads = yield* deps.queries.boardCardThreads(cardId).pipe(Effect.option);
    if (Option.isSome(threads)) {
      deltas.push({ kind: "card-threads", sequence, cardId, threads: threads.value });
    }
  }
  return deltas as ReadonlyArray<BoardShellStreamEvent>;
});

const sameWorkersState = Schema.toEquivalence(BoardWorkersState);

const toSnapshotError = (message: string) => (cause: unknown) =>
  new BoardSnapshotError({ message, cause });

/** One `card-threads` delta per card with a live link, stamped with the board
    head (the client applies `card-threads` unguarded). A card whose links were
    all removed while the client was away is covered by the replayed unlink. */
const cardThreadsResync = (
  queries: Pick<BoardQueriesShape, "boardAllCardThreads">,
  sequence: number,
): Effect.Effect<ReadonlyArray<BoardShellStreamItem>, BoardSnapshotError> =>
  queries.boardAllCardThreads().pipe(
    Effect.mapError(toSnapshotError("Failed to load the board's card threads.")),
    Effect.map((rows) => {
      const byCard = new Map<BoardCardId, BoardCardThreadShell[]>();
      for (const row of rows) {
        const threads = byCard.get(row.cardId);
        if (threads === undefined) byCard.set(row.cardId, [row]);
        else threads.push(row);
      }
      return Array.from(byCard, ([cardId, threads]): BoardShellStreamItem => ({
        kind: "card-threads",
        sequence,
        cardId,
        threads,
      }));
    }),
  );

/** One client's board stream. Requires a scope: the todo subscription lives as
    long as the stream does. `maxGap` exists for tests. */
export const subscribeBoard: (
  input: BoardSubscribeBoardInput,
  options?: { readonly maxGap?: number },
) => Effect.Effect<
  Stream.Stream<BoardShellStreamItem, BoardSnapshotError>,
  BoardSnapshotError,
  BoardEngine | BoardQueries | BoardThreadTail | BoardWorkers | Scope.Scope
> = Effect.fn("boardSubscription.subscribeBoard")(function* (
  input: BoardSubscribeBoardInput,
  options?: { readonly maxGap?: number },
) {
  const engine = yield* BoardEngine;
  const queries = yield* BoardQueries;
  const threadTail = yield* BoardThreadTail;
  const workers = yield* BoardWorkers;
  const todoChanges = yield* threadTail.subscribeTodoChanges;

  // T3O-62: the worker summary is runtime state as much as log state, so it
  // rides beside the log's deltas as a whole-state `workers` item, stamped
  // with the board head and applied unguarded (like `card-threads`).
  const workersItem = (state: BoardWorkersState) =>
    engine.latestSequence.pipe(
      Effect.map((sequence): BoardShellStreamItem => ({ kind: "workers", sequence, state })),
    );
  // `states` opens with the summary as it is when the stream starts, so a
  // change between the opening read and that subscription still reaches the
  // client; anything equal to what the client already holds is not re-sent.
  const workerDeltas = (sent: BoardWorkersState) =>
    Stream.concat(Stream.make(sent), workers.states).pipe(
      Stream.changesWith(sameWorkersState),
      Stream.drop(1),
      Stream.mapEffect(workersItem),
    );

  const deltasAfter = (
    afterSequence: number,
    sentWorkers: BoardWorkersState,
  ): Stream.Stream<BoardShellStreamItem, BoardSnapshotError> =>
    Stream.merge(
      engine
        .streamBoardEvents({ afterSequence })
        .pipe(Stream.map((event): BoardStreamInput => ({ kind: "board", event }))),
      todoChanges.pipe(Stream.map((threadId): BoardStreamInput => ({ kind: "todo", threadId }))),
    ).pipe(
      Stream.groupedWithin(BOARD_STREAM_MAX_CHUNK, BOARD_STREAM_WINDOW),
      Stream.mapEffect((window) =>
        boardStreamWindowDeltas(window, {
          queries,
          latestSequence: engine.latestSequence,
          workersState: workers.state,
        }),
      ),
      Stream.flatMap((deltas) => Stream.fromIterable(deltas)),
      Stream.mapError(toSnapshotError("Failed to replay board events.")),
      Stream.merge(workerDeltas(sentWorkers)),
    );

  const afterSequence = input.afterSequence;
  if (afterSequence !== undefined) {
    const head = yield* engine.latestSequence;
    const maxGap = options?.maxGap ?? BOARD_RESUME_MAX_GAP;
    if (afterSequence <= head && head - afterSequence <= maxGap) {
      // Todo changes and thread deletions are not in the board log, so a
      // replay alone leaves the client's `card-threads` as they were when it
      // dropped. Re-send every card's link set first; the todo subscription
      // is already attached, so nothing landing after this read is lost.
      const resync = yield* cardThreadsResync(queries, head);
      // Worker status moved on while the client was away, and none of it is
      // in the log: send the whole summary again. A local-only board has
      // none to send, and a registry emptied meanwhile is in the replayed
      // log, which re-sends it.
      const workersNow = yield* workers.state;
      const workersResync = isLocalOnlyBoardWorkers(workersNow)
        ? []
        : [yield* workersItem(workersNow)];
      return Stream.concat(
        Stream.fromIterable([...resync, ...workersResync]),
        deltasAfter(afterSequence, workersNow),
      );
    }
  }

  const snapshot = yield* queries.boardShellSnapshot().pipe(
    Effect.tapError((cause) => Effect.logError("board snapshot load failed", { cause })),
    Effect.mapError(toSnapshotError("Failed to load the board snapshot.")),
  );
  const workersState = yield* workers.state;
  const opening: BoardShellStreamItem = {
    kind: "snapshot",
    // Absent on a local-only board, which is then exactly today's snapshot.
    snapshot: isLocalOnlyBoardWorkers(workersState)
      ? snapshot
      : { ...snapshot, workers: workersState },
  };
  return Stream.concat(Stream.make(opening), deltasAfter(snapshot.snapshotSequence, workersState));
});
