/**
 * A CI pass on a placed worker (T3O-44, D21): progress streamed from the
 * worker's gateway is reported as the local runner reports it, and a worker
 * out of reach is "unavailable" rather than a CI failure.
 */
import { BoardWorkerCiProgress, BoardWorkerRunCiInput, EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { WorkerUnavailable, type WorkerConnectionsShape } from "../workers/WorkerConnections.ts";
import type { WorkerRpc } from "../workers/WorkerTransport.ts";
import type { BoardCiStepProgress } from "./BoardCiRunner.ts";
import { remoteCiRunBudgetMs, remoteCiRunner, toWireCiDone } from "./remoteCiRunner.ts";

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

it.effect("a pass the worker could not run arrives as unavailable, with its reason", () =>
  Effect.gen(function* () {
    const result = yield* remoteCiRunner(
      connected([
        toWireCiDone({
          result: "unavailable",
          failedIndex: null,
          detail: "CI couldn't write its logs.",
        }),
      ]),
      worker,
    ).run(request, () => Effect.void);
    assert.deepStrictEqual(result, {
      result: "unavailable",
      failedIndex: null,
      detail: "CI couldn't write its logs.",
    });
  }),
);

it.effect("a machine problem on the worker keeps its machine flag across the wire", () =>
  Effect.gen(function* () {
    const done = yield* Schema.decodeUnknownEffect(BoardWorkerCiProgress)(
      toWireCiDone({
        result: "unavailable",
        failedIndex: null,
        detail: "Disk nearly full on w1: 0.4 GiB free.",
        machine: true,
      }),
    );
    const result = yield* remoteCiRunner(connected([done]), worker).run(request, () => Effect.void);
    assert.deepStrictEqual(result, {
      result: "unavailable",
      failedIndex: null,
      detail: "Disk nearly full on w1: 0.4 GiB free.",
      machine: true,
    });
    // An older worker's `done` has no flag, and still decodes.
    assert.deepStrictEqual(
      yield* Schema.decodeUnknownEffect(BoardWorkerCiProgress)({
        _tag: "done",
        result: "unavailable",
        failedIndex: null,
        detail: "x",
      }),
      { _tag: "done", result: "unavailable", failedIndex: null, detail: "x" },
    );
  }),
);

it.effect("a worker that stays connected but never finishes is stopped at its budget", () =>
  Effect.gen(function* () {
    const steps = [
      { name: "Lint", command: "vp lint", timeoutMinutes: 5 },
      { name: "Types", command: "vp tsc", timeoutMinutes: 20, parallel: true },
      { name: "Test", command: "vp test", timeoutMinutes: 30 },
    ];
    // The longest step of each group, summed, plus ten minutes.
    assert.strictEqual(remoteCiRunBudgetMs(steps), (20 + 30 + 10) * 60_000);
    const silent = {
      get: () => Effect.succeed({ gateway: { runCi: () => Stream.never } } as unknown as WorkerRpc),
    } satisfies Pick<WorkerConnectionsShape, "get">;
    const fiber = yield* remoteCiRunner(silent, worker)
      .run({ ...request, steps }, () => Effect.void)
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("59 minutes");
    assert.isUndefined(fiber.pollUnsafe());
    yield* TestClock.adjust("1 minute");
    assert.deepStrictEqual(yield* Fiber.join(fiber), {
      result: "unavailable",
      failedIndex: null,
      detail: "The worker's CI run didn't finish within its time limits; stopped.",
    });
  }),
);

it.effect("a later segment's parallel steps, offset and result detail cross the wire intact", () =>
  Effect.gen(function* () {
    const sent: BoardWorkerRunCiInput[] = [];
    const reported = {
      ...step,
      parallel: true,
      result: { summary: "1 failed", failures: [{ title: "boom", file: "a.ts", line: 3 }] },
    };
    const wire = {
      get: () =>
        Effect.succeed({
          gateway: {
            runCi: (input: unknown) => {
              sent.push(Schema.decodeUnknownSync(BoardWorkerRunCiInput)(input));
              return Stream.fromIterable(
                [
                  { _tag: "step", index: 0, step: reported },
                  { _tag: "done", result: "failed", failedIndex: 0 },
                ].map((progress) => Schema.decodeUnknownSync(BoardWorkerCiProgress)(progress)),
              );
            },
          },
        } as unknown as WorkerRpc),
    } satisfies Pick<WorkerConnectionsShape, "get">;
    const seen: BoardCiStepProgress[] = [];
    yield* remoteCiRunner(wire, worker).run(
      {
        ...request,
        steps: [
          { name: "Lint", command: "vp lint", timeoutMinutes: 5 },
          { name: "Test", command: "vp test", timeoutMinutes: 5, parallel: true },
        ],
        indexOffset: 2,
      },
      (progress) => Effect.sync(() => seen.push(progress)),
    );
    assert.strictEqual(sent[0]?.indexOffset, 2);
    assert.strictEqual(sent[0]?.steps[1]?.parallel, true);
    assert.deepStrictEqual(seen, [{ index: 0, step: reported }]);
  }),
);
