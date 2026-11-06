/**
 * T3O-44 — a CI pass whose run dies still reports, so the card never sits in
 * CI "running" with nothing behind it, and its slot comes back.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardCardId,
  EnvironmentId,
  CommandId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";

import { BoardStepSlots, BoardStepSlotsLive } from "../BoardStepSlots.ts";
import { makeBoardCiPasses, type BoardCiPassFinished } from "./ciPasses.ts";

it.effect("a runner defect still reports the pass, as unavailable, and frees its slot", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    const finished: BoardCiPassFinished[] = [];
    const passes = yield* makeBoardCiPasses({
      runner: { run: () => Effect.die(new Error("mkdir exploded")) },
      slots,
      dispatch: () => Effect.void,
      commandId: (tag) => Effect.succeed(CommandId.make(tag)),
      nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
      onFinished: (done) => Effect.sync(() => finished.push(done)),
    });
    const started = yield* passes.start({
      cardId: BoardCardId.make("card-1"),
      runId: "run-1",
      worktreePath: "/tmp/nowhere",
      workerId: BOARD_LOCAL_WORKER_ID,
      steps: [{ name: "Lint", command: "vp lint", timeoutMinutes: 1 }],
      limits: { global: 1, worker: null, perInstance: null },
    });
    assert.isTrue(started);
    yield* passes.awaitIdle;
    assert.lengthOf(finished, 1);
    assert.strictEqual(finished[0]!.outcome.result, "unavailable");
    assert.strictEqual(yield* slots.heldTotal, 0);
  }).pipe(Effect.scoped, Effect.provide(BoardStepSlotsLive)),
);

it.effect("admitting queued passes skips one whose worker is full and starts the next", () =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    const release = yield* Deferred.make<void>();
    const passes = yield* makeBoardCiPasses({
      runner: {
        run: () =>
          Deferred.await(release).pipe(Effect.as({ result: "passed" as const, failedIndex: null })),
      },
      slots,
      dispatch: () => Effect.void,
      commandId: (tag) => Effect.succeed(CommandId.make(tag)),
      nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
      onFinished: () => Effect.void,
    });
    const workerA = EnvironmentId.make("worker-a");
    const workerB = EnvironmentId.make("worker-b");
    const limits = { global: 2, worker: 1, perInstance: null };
    const request = (card: string, workerId: EnvironmentId) => ({
      cardId: BoardCardId.make(card),
      runId: `run-${card}`,
      worktreePath: "/tmp/nowhere",
      workerId,
      steps: [{ name: "Lint", command: "vp lint", timeoutMinutes: 1 }],
      limits,
    });
    // An agent step on a third worker holds the board's other slot.
    const other = {
      workerId: EnvironmentId.make("worker-c"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    };
    assert.isTrue((yield* slots.acquire(other, limits)).admitted);

    assert.isTrue(yield* passes.start(request("a1", workerA)));
    assert.isFalse(yield* passes.start(request("a2", workerA)));
    assert.isFalse(yield* passes.start(request("b1", workerB)));

    yield* slots.release(other);
    yield* passes.admitQueued;

    assert.strictEqual(yield* slots.heldOnWorker(workerB), 1);
    assert.strictEqual(yield* slots.heldOnWorker(workerA), 1);
    yield* Deferred.succeed(release, undefined);
    yield* passes.awaitIdle;
  }).pipe(Effect.scoped, Effect.provide(BoardStepSlotsLive)),
);
