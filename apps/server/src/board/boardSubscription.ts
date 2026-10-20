/**
 * `board.subscribeBoard` — the board's own client subscription (t3o-26 D4,
 * T3O-57).
 *
 * The board has its own log and its own sequence (T3O-56), so it cannot share
 * the orchestration shell's stream: the shell's client drops anything at or
 * below ONE snapshot sequence, and two counters in one stream would drop one
 * side's deltas wholesale. The board therefore has a stream of its own, with
 * v1 shell resume semantics:
 *
 * - no cursor, a cursor ahead of the log, or a gap over `BOARD_RESUME_MAX_GAP`:
 *   a full `BoardShellSnapshot`, then the live tail;
 * - a cursor inside the gap: every card's live `card-threads` (todo changes are
 *   not in the log), the board events after the cursor replayed from the log,
 *   then the live tail.
 *
 * Either way the tail is `BoardEngine.streamBoardEvents` from the cursor, which
 * hands over from the durable log to the live PubSub with no gap and no
 * duplicate. The todo-change subscription is attached BEFORE any read, so a
 * plan update landing while the snapshot loads still reaches the client.
 *
 * Deltas are coalesced per window (`boardStreamWindowDeltas`).
 */
import {
  BoardSnapshotError,
  type BoardCardId,
  type BoardCardThreadShell,
  type BoardShellStreamEvent,
  type BoardShellStreamItem,
  type BoardSubscribeBoardInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { BoardEngine } from "./BoardEngine.ts";
import { BoardQueries } from "./BoardQueries.ts";
import { BoardThreadTail } from "./boardThreadTail.ts";
import type { BoardQueriesShape } from "./projection.ts";
import { boardShellStreamEvent, type BoardEvent } from "./projector.ts";

/**
 * Replaying more board events than this costs more than one snapshot: each
 * replayed link change is a `card-threads` read, and a snapshot is a handful of
 * bounded table scans. Matches the orchestration shell's own bound.
 */
export const BOARD_RESUME_MAX_GAP = 1_000;

/** The coalescing window, matching the orchestration shell's. */
const BOARD_STREAM_WINDOW = Duration.millis(50);
const BOARD_STREAM_MAX_CHUNK = 512;

/** One input to the board stream: a committed board event, or a linked
    thread's todo list changing (the read-only upstream tail). */
export type BoardStreamInput =
  | { readonly kind: "board"; readonly event: BoardEvent }
  | { readonly kind: "todo"; readonly threadId: ThreadId };

/**
 * The deltas one coalescing window yields.
 *
 * Board deltas are built from their event's payload and pass through in
 * sequence order, uncollapsed: a card-carrying delta OMITS the keys it cannot
 * see (`briefHasImage`, the review slice…) and the client keeps its last value,
 * so dropping an earlier delta for the same card would lose a change the later
 * one does not repeat. Board events are human- and supervisor-paced, so there
 * is little to collapse anyway.
 *
 * `card-threads` is the refetch-shaped delta — the card's whole live link set,
 * read at emission — and its sources are the high-frequency ones: every
 * `turn.plan.updated` on a linked thread. A window therefore refetches each
 * touched card ONCE, after its board deltas, however many link changes and
 * plan updates landed in it. The refetch is stamped with the board head; the
 * client applies `card-threads` without the sequence guard, because it is
 * always a fresh read.
 */
export const boardStreamWindowDeltas = (
  inputs: Iterable<BoardStreamInput>,
  deps: {
    readonly queries: Pick<BoardQueriesShape, "boardCardThreads" | "boardCardIdForThread">;
    readonly latestSequence: Effect.Effect<number>;
  },
): Effect.Effect<ReadonlyArray<BoardShellStreamEvent>> =>
  Effect.gen(function* () {
    const deltas: BoardShellStreamEvent[] = [];
    const touchedCards = new Set<BoardCardId>();
    const touchedThreads = new Set<ThreadId>();
    for (const input of inputs) {
      if (input.kind === "todo") {
        touchedThreads.add(input.threadId);
        continue;
      }
      const delta = boardShellStreamEvent(input.event);
      if (Option.isSome(delta)) deltas.push(delta.value);
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
    if (touchedCards.size === 0) return deltas;
    const sequence = yield* deps.latestSequence;
    for (const cardId of touchedCards) {
      const threads = yield* deps.queries.boardCardThreads(cardId).pipe(Effect.option);
      if (Option.isSome(threads)) {
        deltas.push({ kind: "card-threads", sequence, cardId, threads: threads.value });
      }
    }
    return deltas;
  });

const toSnapshotError = (message: string) => (cause: unknown) =>
  new BoardSnapshotError({ message, cause });

/** One `card-threads` delta per card with a live link, stamped with the board
    head (the client applies `card-threads` unguarded). A card whose links were
    all removed while the client was away is covered by the replayed unlink. */
export const cardThreadsResync = (
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
export const subscribeBoard = (
  input: BoardSubscribeBoardInput,
  options?: { readonly maxGap?: number },
): Effect.Effect<
  Stream.Stream<BoardShellStreamItem, BoardSnapshotError>,
  BoardSnapshotError,
  BoardEngine | BoardQueries | BoardThreadTail | Scope.Scope
> =>
  Effect.gen(function* () {
    const engine = yield* BoardEngine;
    const queries = yield* BoardQueries;
    const threadTail = yield* BoardThreadTail;
    const todoChanges = yield* threadTail.subscribeTodoChanges;

    const deltasAfter = (
      afterSequence: number,
    ): Stream.Stream<BoardShellStreamItem, BoardSnapshotError> =>
      Stream.merge(
        engine
          .streamBoardEvents({ afterSequence })
          .pipe(Stream.map((event): BoardStreamInput => ({ kind: "board", event }))),
        todoChanges.pipe(Stream.map((threadId): BoardStreamInput => ({ kind: "todo", threadId }))),
      ).pipe(
        Stream.groupedWithin(BOARD_STREAM_MAX_CHUNK, BOARD_STREAM_WINDOW),
        Stream.mapEffect((window) =>
          boardStreamWindowDeltas(window, { queries, latestSequence: engine.latestSequence }),
        ),
        Stream.flatMap((deltas) => Stream.fromIterable(deltas)),
        Stream.mapError(toSnapshotError("Failed to replay board events.")),
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
        return Stream.concat(Stream.fromIterable(resync), deltasAfter(afterSequence));
      }
    }

    const snapshot = yield* queries.boardShellSnapshot().pipe(
      Effect.tapError((cause) => Effect.logError("board snapshot load failed", { cause })),
      Effect.mapError(toSnapshotError("Failed to load the board snapshot.")),
    );
    const opening: BoardShellStreamItem = { kind: "snapshot", snapshot };
    return Stream.concat(Stream.make(opening), deltasAfter(snapshot.snapshotSequence));
  });
