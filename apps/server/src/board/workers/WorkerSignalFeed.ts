/**
 * T3o (T3O-63): every worker's thread signals, on the central server.
 *
 * For each worker with a live connection the feed holds the worker's signal
 * stream open from where the board last got to, and on each batch:
 *
 * - applies its todo signals to the board's todo cache and moves the worker's
 *   cursor, in one transaction, so a crash re-reads at worst and never
 *   applies an older todo list over a newer one;
 * - publishes its signals, tagged with the worker, for the router's
 *   `observe`.
 *
 * A dropped connection resumes from the cursor when the worker is back, so
 * what happened meanwhile arrives once — not lost, not doubled. A worker the
 * board has never read starts at its log's head: a thread placed there was
 * spawned after this point.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { makeBoardSqlProjector } from "../projection.ts";
import type { ThreadSignal, TodoSignal } from "../ThreadGateway.ts";
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

export const makeWorkerSignalFeed = Effect.gen(function* () {
  const connections = yield* WorkerConnections;
  const store = yield* BoardRelayStore;
  const sql = yield* SqlClient.SqlClient;
  const projector = makeBoardSqlProjector(sql);
  const signals = yield* PubSub.unbounded<WorkerThreadSignal>();
  const todoChanges = yield* PubSub.unbounded<ThreadId>();

  const follow = (workerId: EnvironmentId, rpc: WorkerRpc) =>
    Effect.gen(function* () {
      let cursor = yield* store.signalCursor(workerId);
      if (cursor === null) {
        cursor = yield* rpc.gateway.todoLogHead;
        yield* store.saveSignalCursor(workerId, cursor);
      }
      yield* rpc.gateway.subscribeSignals(cursor).pipe(
        Stream.runForEach((batch) =>
          Effect.gen(function* () {
            // A redelivered position (a stream reopened mid-batch) is skipped.
            if (cursor !== null && batch.sequence <= cursor) return;
            const batchSignals = batch.signals.map(fromWireSignal);
            const todos = batchSignals.filter(isTodoSignal);
            yield* sql.withTransaction(
              Effect.forEach(todos, (signal) => projector.applyTodoSignal(signal), {
                discard: true,
              }).pipe(Effect.andThen(store.saveSignalCursor(workerId, batch.sequence))),
            );
            cursor = batch.sequence;
            for (const signal of todos) yield* PubSub.publish(todoChanges, signal.threadId);
            for (const signal of batchSignals) {
              yield* PubSub.publish(signals, { workerId, signal });
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
