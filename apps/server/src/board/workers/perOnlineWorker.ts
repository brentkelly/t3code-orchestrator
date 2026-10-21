/**
 * T3o (T3O-63): run something against every registered worker's live link,
 * again on each new link.
 *
 * The signal feed and the MCP relay both hold a stream open on each worker
 * for as long as its connection lasts, and open it again when the connection
 * manager redials. This is that loop, once: a fiber per registered worker
 * that waits for a link, runs, and runs again — at once on a new link, after
 * a backoff on the same one, so a transient failure on a healthy link does
 * not stop the feed until the next redial. A worker removed from the
 * registry has its fiber stopped.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { WorkerConnectionsShape } from "./WorkerConnections.ts";
import type { WorkerRpc } from "./WorkerTransport.ts";

/** The next link to this worker other than `last`, or null once the worker is
    no longer registered. Waits while it is offline. */
const nextLink = (
  connections: WorkerConnectionsShape,
  workerId: EnvironmentId,
  last: WorkerRpc | null,
) =>
  connections.states.pipe(
    Stream.mapEffect((runtime) =>
      runtime.has(workerId)
        ? connections.get(workerId).pipe(
            Effect.option,
            Effect.map((rpc) => ({ registered: true, rpc: Option.getOrNull(rpc) })),
          )
        : Effect.succeed({ registered: false, rpc: null }),
    ),
    Stream.filter((next) => !next.registered || (next.rpc !== null && next.rpc !== last)),
    Stream.runHead,
    Effect.map((next) => (Option.isSome(next) ? next.value.rpc : null)),
  );

/** The pause before a run that ended is run again on the same link: one
    second, doubling to thirty while it keeps ending. */
export const rerunDelay = (reruns: number): Duration.Duration =>
  Duration.seconds(Math.min(30, 2 ** Math.min(reruns, 5)));

export const runPerOnlineWorker = (
  connections: WorkerConnectionsShape,
  name: string,
  run: (workerId: EnvironmentId, rpc: WorkerRpc) => Effect.Effect<void>,
  delay: (reruns: number) => Duration.Duration = rerunDelay,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<EnvironmentId>();
    const started = new Set<EnvironmentId>();
    const loop = (workerId: EnvironmentId) =>
      Effect.gen(function* () {
        let last: WorkerRpc | null = null;
        let reruns = 0;
        while (true) {
          // A run that ended on a link still up is run on it again after a
          // pause; a new link (a redial) starts at once.
          const rpc: WorkerRpc | null =
            last === null
              ? yield* nextLink(connections, workerId, null)
              : yield* Effect.raceFirst(
                  nextLink(connections, workerId, last),
                  Effect.sleep(delay(reruns)).pipe(
                    Effect.andThen(nextLink(connections, workerId, null)),
                  ),
                );
          if (rpc === null) return;
          reruns = rpc === last ? reruns + 1 : 0;
          last = rpc;
          yield* run(workerId, rpc).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning(`board ${name}: a worker's run ended`, {
                  workerId,
                  cause: Cause.pretty(cause),
                }),
            ),
          );
        }
      });
    yield* connections.states.pipe(
      Stream.runForEach((runtime) =>
        Effect.gen(function* () {
          for (const workerId of runtime.keys()) {
            if (!(yield* FiberMap.has(fibers, workerId))) {
              started.add(workerId);
              yield* FiberMap.run(fibers, workerId, loop(workerId));
            }
          }
          for (const workerId of started) {
            if (runtime.has(workerId)) continue;
            started.delete(workerId);
            yield* FiberMap.remove(fibers, workerId);
          }
        }),
      ),
      Effect.forkScoped,
    );
  });
