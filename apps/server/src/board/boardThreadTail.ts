/**
 * Feeds `board_thread_todos` from the gateway's durable todo log. The cursor
 * moves only inside the applying transaction, so a crash never re-applies an
 * older plan; a failed apply pins the persisted cursor before it so the next
 * boot replays from there in order. A first boot starts at the log head.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { makeBoardEventStore } from "./boardEventStore.ts";
import { makeBoardSqlProjector } from "./projection.ts";
import { ThreadGateway, type TodoLogEntry } from "./ThreadGateway.ts";
import { WorkerSignalFeed } from "./workers/WorkerSignalFeed.ts";

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

const makeBoardThreadTail = Effect.gen(function* () {
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
  // Untraced: saveCursor and apply run once per thread-log entry.
  const saveCursor = Effect.fnUntraced(function* (sequence: number) {
    const pinned = yield* Ref.get(pinnedAt);
    const at = yield* nowIso;
    yield* store.setWatermark(
      BOARD_THREAD_TAIL_PROJECTOR,
      pinned === null ? sequence : Math.min(pinned, sequence),
      at,
    );
  });

  const apply = Effect.fnUntraced(function* (entry: TodoLogEntry) {
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
  // T3o (T3O-63): the workers' todo signals are applied by their feed, with
  // its own cursor; their changes reach board clients here all the same.
  const feed = yield* Effect.serviceOption(WorkerSignalFeed);
  if (Option.isSome(feed)) {
    const remote = yield* feed.value.subscribeTodoChanges;
    yield* Effect.forkScoped(
      Stream.runForEach(remote, (threadId) => PubSub.publish(changes, threadId)),
    );
  }
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
