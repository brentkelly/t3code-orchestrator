/**
 * A CI pass on a placed worker (T3O-44, D21): progress streamed from the
 * worker's gateway is reported as the local runner reports it, and a worker
 * out of reach is "unavailable" rather than a CI failure.
 */
import { EnvironmentId, type BoardWorkerCiProgress } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { WorkerUnavailable, type WorkerConnectionsShape } from "../workers/WorkerConnections.ts";
import type { WorkerRpc } from "../workers/WorkerTransport.ts";
import type { BoardCiStepProgress } from "./BoardCiRunner.ts";
import { remoteCiRunner } from "./remoteCiRunner.ts";

const worker = EnvironmentId.make("worker-1");
const request = {
  runId: "run-1",
  cwd: "/remote/wt",
  steps: [{ name: "Test", command: "vp test", timeoutMinutes: 5 }],
  logDir: "/remote/wt/.t3/ci/run-1",
};
const step = {
  name: "Test",
  command: "vp test",
  timeoutMinutes: 5,
  status: "failed" as const,
  startedAt: null,
  finishedAt: null,
  exitCode: 1,
  tail: "boom",
};

const connected = (progress: ReadonlyArray<BoardWorkerCiProgress>) =>
  ({
    get: () =>
      Effect.succeed({
        gateway: { runCi: () => Stream.fromIterable(progress) },
      } as unknown as WorkerRpc),
  }) satisfies Pick<WorkerConnectionsShape, "get">;

it.effect("reports the worker's step progress and its result", () =>
  Effect.gen(function* () {
    const seen: BoardCiStepProgress[] = [];
    const result = yield* remoteCiRunner(
      connected([
        { _tag: "step", index: 0, step },
        { _tag: "done", result: "failed", failedIndex: 0 },
      ]),
      worker,
    ).run(request, (progress) => Effect.sync(() => seen.push(progress)));
    assert.deepStrictEqual(result, { result: "failed", failedIndex: 0 });
    assert.deepStrictEqual(seen, [{ index: 0, step }]);
  }),
);

it.effect("a worker out of reach is unavailable, not a failed step", () =>
  Effect.gen(function* () {
    const result = yield* remoteCiRunner(
      {
        get: () =>
          Effect.fail(
            new WorkerUnavailable({ workerId: worker, state: "unknown", message: "offline" }),
          ),
      },
      worker,
    ).run(request, () => Effect.void);
    assert.strictEqual(result.result, "unavailable");
  }),
);
