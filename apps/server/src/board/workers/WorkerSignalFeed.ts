/**
 * Every worker's thread signals on the central server. Todo signals and the
 * worker's cursor commit in one transaction, so a crash re-reads at worst and never
 * applies an older todo list over a newer one. A worker never read before starts
 * at its log's head.
 */
import { BOARD_WORKER_USAGE_PROTOCOL, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { makeBoardSqlProjector } from "../projection.ts";
import type { ThreadSignal, TodoSignal, UsageSignal } from "../ThreadGateway.ts";
import { BoardUsageRecorder } from "../usage/BoardUsageRecorder.ts";
import { markWorkerCardsPartial } from "../usage/boardUsageStore.ts";
import { BoardRelayStore } from "./BoardRelayStore.ts";
import { fromWireSignal } from "./gatewayWire.ts";
import { runPerOnlineWorker } from "./perOnlineWorker.ts";
import { WorkerConnections } from "./WorkerConnections.ts";
import type { WorkerRpc } from "./WorkerTransport.ts";

/** A signal and the worker it came from. */
export interface WorkerThreadSignal {
  readonly workerId: EnvironmentId;
  readonly signal: ThreadSignal;
}

export interface WorkerSignalFeedShape {
  /** Every worker's signals, live. Each access is its own subscription. */
  readonly signals: Stream.Stream<WorkerThreadSignal>;
  /** A live subscription, attached when this effect returns. */
  readonly subscribeSignals: Effect.Effect<Stream.Stream<WorkerThreadSignal>, never, Scope.Scope>;
  /** Threads whose cached todo list a worker's signal just changed. */
  readonly subscribeTodoChanges: Effect.Effect<Stream.Stream<ThreadId>, never, Scope.Scope>;
}

export class WorkerSignalFeed extends Context.Service<WorkerSignalFeed, WorkerSignalFeedShape>()(
  "t3/board/workers/WorkerSignalFeed",
) {}

const isTodoSignal = (signal: ThreadSignal): signal is TodoSignal =>
  signal.type === "todos-changed" || signal.type === "thread-deleted";

const isUsageSignal = (signal: ThreadSignal): signal is UsageSignal =>
  signal.type === "usage-recorded";

export const makeWorkerSignalFeed = Effect.gen(function* () {
  const connections = yield* WorkerConnections;
  const store = yield* BoardRelayStore;
  const sql = yield* SqlClient.SqlClient;
  const projector = makeBoardSqlProjector(sql);
  const signals = yield* PubSub.unbounded<WorkerThreadSignal>();
  const todoChanges = yield* PubSub.unbounded<ThreadId>();
  // T3o: a worker's finished turns, priced here (T3O-77). Absent in suites that are not
  // about usage, which then neither ask for nor store it.
  const recorder = yield* Effect.serviceOption(BoardUsageRecorder);

  // Untraced: it lasts as long as the worker's signal stream.
  const follow = Effect.fnUntraced(function* (workerId: EnvironmentId, rpc: WorkerRpc) {
    let cursor = yield* store.signalCursor(workerId);
    if (cursor === null) {
      cursor = yield* rpc.gateway.todoLogHead;
      yield* store.saveSignalCursor(workerId, cursor);
    }
    // An older worker sends no usage, so the cards it works on can only be a lower bound.
    // Re-marked on every batch: a card linked to one of its threads since starts here.
    const protocol = (yield* connections.current).get(workerId)?.status.protocolVersion ?? 0;
    const markPartial = Effect.gen(function* () {
      if (Option.isNone(recorder) || protocol >= BOARD_WORKER_USAGE_PROTOCOL) return;
      const marked = yield* markWorkerCardsPartial(sql, workerId).pipe(
        Effect.orElseSucceed(() => []),
      );
      for (const cardId of marked) yield* recorder.value.publish(cardId);
    });
    yield* markPartial;
    yield* rpc.gateway.subscribeSignals(cursor, Option.isSome(recorder)).pipe(
      Stream.runForEach((batch) =>
        Effect.gen(function* () {
          // A redelivered position (a stream reopened mid-batch) is skipped.
          if (cursor !== null && batch.sequence <= cursor) return;
          yield* markPartial;
          const batchSignals = batch.signals.map(fromWireSignal);
          const todos = batchSignals.filter(isTodoSignal);
          const usage = Option.isSome(recorder)
            ? yield* Effect.forEach(batchSignals.filter(isUsageSignal), recorder.value.price)
            : [];
          const storeUsage = Option.isSome(recorder)
            ? Effect.forEach(usage, recorder.value.store)
            : Effect.succeed([]);
          const usageCards = yield* sql.withTransaction(
            Effect.forEach(todos, (signal) => projector.applyTodoSignal(signal), {
              discard: true,
            }).pipe(
              Effect.andThen(storeUsage),
              Effect.tap(() => store.saveSignalCursor(workerId, batch.sequence)),
            ),
          );
          cursor = batch.sequence;
          for (const signal of todos) yield* PubSub.publish(todoChanges, signal.threadId);
          if (Option.isSome(recorder)) {
            for (const cardId of new Set(usageCards)) {
              if (cardId !== null) yield* recorder.value.publish(cardId);
            }
          }
          // Usage is the board's bookkeeping, never something the supervisor acts on.
          for (const signal of batchSignals) {
            if (!isUsageSignal(signal)) yield* PubSub.publish(signals, { workerId, signal });
          }
        }),
      ),
    );
  });

  yield* runPerOnlineWorker(connections, "signal feed", (workerId, rpc) =>
    follow(workerId, rpc).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board signal feed: a worker's signals stopped", { workerId, cause }),
      ),
    ),
  );

  return {
    get signals() {
      return Stream.fromPubSub(signals);
    },
    subscribeSignals: PubSub.subscribe(signals).pipe(Effect.map(Stream.fromSubscription)),
    subscribeTodoChanges: PubSub.subscribe(todoChanges).pipe(Effect.map(Stream.fromSubscription)),
  } satisfies WorkerSignalFeedShape;
});

export const WorkerSignalFeedLive = Layer.effect(WorkerSignalFeed, makeWorkerSignalFeed);

/** A feed that never hears from a worker — a board with none. */
export const emptyWorkerSignalFeed: WorkerSignalFeedShape = {
  signals: Stream.never,
  subscribeSignals: Effect.succeed(Stream.never),
  subscribeTodoChanges: Effect.succeed(Stream.never),
};
