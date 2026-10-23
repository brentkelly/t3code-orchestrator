/**
 * T3o (T3O-63): the per-worker loop behind the signal feed and the MCP relay.
 */
import { EnvironmentId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { runPerOnlineWorker } from "./perOnlineWorker.ts";
import type { WorkerConnectionsShape, WorkerRuntime } from "./WorkerConnections.ts";
import type { WorkerRpc } from "./WorkerTransport.ts";

const WORKER = EnvironmentId.make("env-w1");

/** One registered worker whose link stays up throughout. */
const steadyLink = (rpc: WorkerRpc): WorkerConnectionsShape => {
  const runtime: ReadonlyMap<EnvironmentId, WorkerRuntime> = new Map([
    [WORKER, {} as WorkerRuntime],
  ]);
  return {
    get: () => Effect.succeed(rpc),
    current: Effect.succeed(runtime),
    states: Stream.concat(Stream.make(runtime), Stream.never),
    changes: Stream.never,
    sync: () => Effect.void,
    restart: () => Effect.void,
    refresh: () => Effect.void,
    record: () => Effect.void,
  };
};

describe("runPerOnlineWorker", () => {
  it.effect("runs again on the same link after a run fails", () =>
    Effect.gen(function* () {
      const rpc = {} as WorkerRpc;
      const runs = yield* Queue.unbounded<number>();
      let count = 0;
      yield* runPerOnlineWorker(
        steadyLink(rpc),
        "test",
        (_workerId, link) =>
          Effect.gen(function* () {
            assert.strictEqual(link, rpc);
            count += 1;
            yield* Queue.offer(runs, count);
            // The first run fails transiently; the second holds its stream.
            if (count === 1) return yield* Effect.die("SQLITE_BUSY");
            return yield* Effect.never;
          }),
        () => Duration.zero,
      );
      assert.strictEqual(yield* Queue.take(runs), 1);
      assert.strictEqual(yield* Queue.take(runs), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("the backoff starts over after a run that lasted", () =>
    Effect.gen(function* () {
      const runs = yield* Queue.unbounded<number>();
      const pauses: Array<number> = [];
      const release = yield* Deferred.make<void>();
      let count = 0;
      yield* runPerOnlineWorker(
        steadyLink({} as WorkerRpc),
        "test",
        () =>
          Effect.gen(function* () {
            count += 1;
            yield* Queue.offer(runs, count);
            // The first run fails at once; the second holds a while, then fails.
            if (count === 2) yield* Deferred.await(release);
            if (count <= 2) return yield* Effect.die("stream error");
            return yield* Effect.never;
          }),
        (reruns) => {
          pauses.push(reruns);
          return Duration.seconds(1);
        },
      );
      assert.strictEqual(yield* Queue.take(runs), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.strictEqual(yield* Queue.take(runs), 2);
      yield* TestClock.adjust(Duration.seconds(10));
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.strictEqual(yield* Queue.take(runs), 3);
      assert.deepStrictEqual(pauses, [0, 0]);
    }).pipe(Effect.scoped),
  );
});
