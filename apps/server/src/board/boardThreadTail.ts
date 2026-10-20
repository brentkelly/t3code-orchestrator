/**
 * The board's todo cache feed (t3o-26 D3, T3O-56, T3O-58).
 *
 * The board's todo cache (`board_thread_todos`, t3o-18) is a projection of two
 * thread signals: `todos-changed` and `thread-deleted`. They come off the
 * thread gateway's durable todo log, which the tail follows itself — reading,
 * never writing — with its cursor in `boards.projection_state`.
 *
 * The cursor only moves inside the transaction that applies a relevant event,
 * and at the end of a catch-up. A crash therefore re-scans irrelevant events at
 * worst, never re-applies an older plan over a newer one.
 *
 * An event that fails to apply (or a catch-up that fails part-way) pins the
 * persisted cursor just before it for the rest of the run. The tail keeps going
 * so `drain` does not hang, and the next boot replays from the failure, in
 * order, so the newest plan still lands last.
 *
 * A database that has never had a cursor starts at upstream's head: a board
 * that has no cards cannot have linked any thread whose history it would miss.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { makeBoardEventStore } from "./boardEventStore.ts";
import { makeBoardSqlProjector } from "./projection.ts";
import { ThreadGateway, type TodoLogEntry } from "./ThreadGateway.ts";

/** The tail's cursor row in `boards.projection_state`, in the gateway's todo
    log positions. */
export const BOARD_THREAD_TAIL_PROJECTOR = "projection.board-thread-tail";

export interface BoardThreadTailShape {
  /** Threads whose cached todo list just changed, live. Each access is its own
      subscription. */
  readonly todoChanges: Stream.Stream<ThreadId>;
  /** A live todo-change subscription, attached when this effect returns. */
  readonly subscribeTodoChanges: Effect.Effect<Stream.Stream<ThreadId>, never, Scope.Scope>;
  /** Wait until every todo-log position written before the call is applied. */
  readonly drain: Effect.Effect<void>;
}

export class BoardThreadTail extends Context.Service<BoardThreadTail, BoardThreadTailShape>()(
  "t3/board/boardThreadTail",
) {}

export const makeBoardThreadTail = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* ThreadGateway;
  const store = makeBoardEventStore(sql);
  const projector = makeBoardSqlProjector(sql);
  const changes = yield* PubSub.unbounded<ThreadId>();

  // Subscribe before reading the head, so nothing committed after the head is
  // read can fall between the catch-up and the live tail.
  const live = yield* gateway.subscribeTodoLog;
  const head = yield* gateway.todoLogHead;
  const stored = yield* store.getWatermark(BOARD_THREAD_TAIL_PROJECTOR).pipe(Effect.orDie);
  // A cursor AHEAD of the log's head means the two files drifted apart — a
  // backup restored for one and not the other, or copies taken a moment apart.
  // Trusting it would skip every plan update until the log caught up with it,
  // so the tail resumes at the head instead and says so.
  if (stored !== null && stored > head) {
    yield* Effect.logWarning(
      "board thread tail cursor is ahead of the thread log; resuming at its head",
    ).pipe(Effect.annotateLogs({ cursor: stored, head }));
  }
  const cursor = stored === null || stored > head ? head : stored;
  const processed = yield* SubscriptionRef.make(cursor);
  // The last sequence before the first event that failed to apply, if any. The
  // persisted cursor never passes it, so the next boot retries from there.
  const pinnedAt = yield* Ref.make<number | null>(null);
  const pin = (sequence: number) =>
    Ref.update(pinnedAt, (pinned) => (pinned === null ? sequence : Math.min(pinned, sequence)));

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const saveCursor = (sequence: number) =>
    Effect.gen(function* () {
      const pinned = yield* Ref.get(pinnedAt);
      const at = yield* nowIso;
      yield* store.setWatermark(
        BOARD_THREAD_TAIL_PROJECTOR,
        pinned === null ? sequence : Math.min(pinned, sequence),
        at,
      );
    });

  const apply = (entry: TodoLogEntry) =>
    Effect.gen(function* () {
      if (entry.cursor <= (yield* SubscriptionRef.get(processed))) return;
      const signal = entry.signal;
      if (signal !== null) {
        const applied = yield* sql
          .withTransaction(
            projector.applyTodoSignal(signal).pipe(Effect.andThen(saveCursor(entry.cursor))),
          )
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("board thread tail failed to apply a signal", {
                signalType: signal.type,
                cursor: entry.cursor,
                cause,
              }).pipe(Effect.andThen(pin(entry.cursor - 1)), Effect.as(false)),
            ),
          );
        if (applied) yield* PubSub.publish(changes, signal.threadId);
      }
      yield* SubscriptionRef.set(processed, entry.cursor);
    });

  // Catch up through the head captured above, then persist the cursor once so
  // the next boot does not re-scan what was just read.
  if (cursor < head) {
    yield* Stream.runForEach(gateway.readTodoLog(cursor, head), apply).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board thread tail catch-up failed", { cause }).pipe(
          Effect.andThen(SubscriptionRef.get(processed)),
          Effect.flatMap(pin),
        ),
      ),
    );
    yield* SubscriptionRef.set(processed, head);
  }
  if (stored !== head) {
    yield* saveCursor(head).pipe(Effect.ignore);
  }

  yield* Effect.forkScoped(Stream.runForEach(live, apply));
  // Persist where the tail got to on shutdown, so a quiet stretch of irrelevant
  // positions is not re-scanned on the next boot.
  yield* Effect.addFinalizer(() =>
    SubscriptionRef.get(processed).pipe(Effect.flatMap(saveCursor), Effect.ignore),
  );

  const drain = Effect.gen(function* () {
    const target = yield* gateway.todoLogHead;
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
