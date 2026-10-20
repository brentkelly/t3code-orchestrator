/**
 * The board's read-only tail of upstream's thread events (t3o-26 D3, T3O-56).
 *
 * The board's todo cache (`board_thread_todos`, t3o-18) is a projection of two
 * upstream thread events: `thread.activity-appended` carrying a
 * `turn.plan.updated`, and `thread.deleted`. The board no longer rides
 * upstream's projection pipeline, so it follows upstream's log itself — reading,
 * never writing — with its cursor in `boards.projection_state`.
 *
 * The cursor only moves inside the transaction that applies a relevant event,
 * and at the end of a catch-up. A crash therefore re-scans irrelevant events at
 * worst, never re-applies an older plan over a newer one.
 *
 * A database that has never had a cursor starts at upstream's head: a board
 * that has no cards cannot have linked any thread whose history it would miss.
 */
import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeBoardEventStore } from "./boardEventStore.ts";
import { makeBoardSqlProjector } from "./projection.ts";

/** The tail's cursor row in `boards.projection_state`, in UPSTREAM sequences. */
export const BOARD_THREAD_TAIL_PROJECTOR = "projection.board-thread-tail";

export interface BoardThreadTailShape {
  /** Threads whose cached todo list just changed, live. Each access is its own
      subscription. */
  readonly todoChanges: Stream.Stream<ThreadId>;
  /** A live todo-change subscription, attached when this effect returns. */
  readonly subscribeTodoChanges: Effect.Effect<Stream.Stream<ThreadId>, never, Scope.Scope>;
  /** Wait until every upstream event committed before the call is applied. */
  readonly drain: Effect.Effect<void>;
}

export class BoardThreadTail extends Context.Service<BoardThreadTail, BoardThreadTailShape>()(
  "t3/board/boardThreadTail",
) {}

const isTodoEvent = (event: OrchestrationEvent): boolean =>
  (event.type === "thread.activity-appended" &&
    event.payload.activity.kind === "turn.plan.updated") ||
  event.type === "thread.deleted";

const todoThreadId = (event: OrchestrationEvent): ThreadId | null =>
  event.type === "thread.activity-appended" || event.type === "thread.deleted"
    ? event.payload.threadId
    : null;

export const makeBoardThreadTail = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const store = makeBoardEventStore(sql);
  const projector = makeBoardSqlProjector(sql);
  const changes = yield* PubSub.unbounded<ThreadId>();

  // Subscribe before reading the head, so nothing committed after the head is
  // read can fall between the catch-up and the live tail.
  const live = yield* engine.subscribeDomainEvents;
  const head = yield* engine.latestSequence;
  const stored = yield* store.getWatermark(BOARD_THREAD_TAIL_PROJECTOR).pipe(Effect.orDie);
  // A cursor AHEAD of upstream's head means the two files drifted apart — a
  // backup restored for one and not the other, or copies taken a moment apart.
  // Trusting it would skip every plan update until the log caught up with it,
  // so the tail resumes at the head instead and says so.
  if (stored !== null && stored > head) {
    yield* Effect.logWarning(
      "board thread tail cursor is ahead of upstream's log; resuming at its head",
    ).pipe(Effect.annotateLogs({ cursor: stored, head }));
  }
  const cursor = stored === null || stored > head ? head : stored;
  const processed = yield* SubscriptionRef.make(cursor);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const saveCursor = (sequence: number) =>
    nowIso.pipe(
      Effect.flatMap((at) => store.setWatermark(BOARD_THREAD_TAIL_PROJECTOR, sequence, at)),
    );

  const apply = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.sequence <= (yield* SubscriptionRef.get(processed))) return;
      if (isTodoEvent(event)) {
        yield* sql
          .withTransaction(
            projector.applyThreadEvent(event).pipe(Effect.andThen(saveCursor(event.sequence))),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("board thread tail failed to apply an event", {
                eventType: event.type,
                sequence: event.sequence,
                cause,
              }),
            ),
          );
        const threadId = todoThreadId(event);
        if (threadId !== null) yield* PubSub.publish(changes, threadId);
      }
      yield* SubscriptionRef.set(processed, event.sequence);
    });

  // Catch up through the head captured above, then persist the cursor once so
  // the next boot does not re-scan what was just read.
  if (cursor < head) {
    yield* Stream.runForEach(engine.readEvents(cursor, head - cursor), apply).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board thread tail catch-up failed", { cause }),
      ),
    );
    yield* SubscriptionRef.set(processed, head);
  }
  if (stored !== head) {
    yield* saveCursor(head).pipe(Effect.ignore);
  }

  yield* Effect.forkScoped(Stream.runForEach(live, apply));
  // Persist where the tail got to on shutdown, so a quiet stretch of irrelevant
  // events is not re-scanned on the next boot.
  yield* Effect.addFinalizer(() =>
    SubscriptionRef.get(processed).pipe(Effect.flatMap(saveCursor), Effect.ignore),
  );

  const drain = Effect.gen(function* () {
    const target = yield* engine.latestSequence;
    yield* SubscriptionRef.changes(processed).pipe(
      Stream.filter((sequence) => sequence >= target),
      Stream.runHead,
    );
  });

  return {
    get todoChanges() {
      return Stream.fromPubSub(changes);
    },
    subscribeTodoChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    drain,
  } satisfies BoardThreadTailShape;
});

export const BoardThreadTailLive = Layer.effect(BoardThreadTail, makeBoardThreadTail);
