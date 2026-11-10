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

const passesWith = (
  runner: Parameters<typeof makeBoardCiPasses>[0]["runner"],
  finished: BoardCiPassFinished[],
) =>
  Effect.gen(function* () {
    const slots = yield* BoardStepSlots;
    const passes = yield* makeBoardCiPasses({
      runner,
      slots,
      dispatch: () => Effect.void,
      commandId: (tag) => Effect.succeed(CommandId.make(tag)),
      nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
      onFinished: (done) => Effect.sync(() => finished.push(done)),
    });
    return { passes, slots };
  });

const lintPass = (runId = "run-1") => ({
  cardId: BoardCardId.make("card-1"),
  runId,
  worktreePath: "/tmp/nowhere",
  workerId: BOARD_LOCAL_WORKER_ID,
  steps: [{ name: "Lint", command: "vp lint", timeoutMinutes: 1 }],
  limits: { global: 1, worker: null, perInstance: null },
});

it.effect("a finished pass stays current until its result is claimed, once, and settled", () =>
  Effect.gen(function* () {
    const finished: BoardCiPassFinished[] = [];
    const { passes, slots } = yield* passesWith(
      { run: () => Effect.succeed({ result: "failed", failedIndex: 0, exitCode: 2 }) },
      finished,
    );
    const card = BoardCardId.make("card-1");
    yield* passes.start(lintPass());
    yield* passes.awaitIdle;
    assert.lengthOf(finished, 1);
    const token = finished[0]!.token;
    // The fiber is gone and its slot is free, but the pass is not idle: its
    // result is still on its way to the reactor.
    assert.isFalse(passes.busy());
    assert.strictEqual(yield* slots.heldTotal, 0);
    assert.strictEqual(passes.current(card), "run-1");
    // A duplicate report, or one for another launch, claims nothing.
    assert.isFalse(passes.claim(card, token + 1));
    assert.isTrue(passes.claim(card, token));
    assert.isFalse(passes.claim(card, token));
    passes.settle(card, token);
    assert.isNull(passes.current(card));
  }).pipe(Effect.scoped, Effect.provide(BoardStepSlotsLive)),
);

it.effect("settling an old launch leaves the next segment's entry, which shares its run id", () =>
  Effect.gen(function* () {
    const finished: BoardCiPassFinished[] = [];
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const { passes } = yield* passesWith(
      {
        run: () =>
          (calls++ === 0 ? Effect.void : Deferred.await(release)).pipe(
            Effect.as({ result: "passed" as const, failedIndex: null }),
          ),
      },
      finished,
    );
    const card = BoardCardId.make("card-1");
    yield* passes.start(lintPass());
    yield* passes.awaitIdle;
    const first = finished[0]!.token;
    assert.isTrue(passes.claim(card, first));
    // The handler starts the next segment before its own entry is settled.
    yield* passes.start({ ...lintPass(), indexOffset: 1 });
    passes.settle(card, first);
    assert.strictEqual(passes.current(card), "run-1");
    assert.isTrue(passes.busy());
    // The first launch's duplicate can't take the live segment's entry.
    assert.isFalse(passes.claim(card, first));
    yield* Deferred.succeed(release, undefined);
    yield* passes.awaitIdle;
    assert.isTrue(passes.claim(card, finished[1]!.token));
  }).pipe(Effect.scoped, Effect.provide(BoardStepSlotsLive)),
);

it.effect(
  "an interrupt nobody asked for reports the pass unavailable; a cancel reports nothing",
  () =>
    Effect.gen(function* () {
      const finished: BoardCiPassFinished[] = [];
      const { passes, slots } = yield* passesWith(
        // What a worker client's closing scope does to the stream in flight.
        { run: () => Effect.interrupt },
        finished,
      );
      yield* passes.start(lintPass());
      yield* passes.awaitIdle;
      assert.lengthOf(finished, 1);
      assert.deepStrictEqual(finished[0]!.outcome, {
        result: "unavailable",
        failedIndex: null,
        detail: "The worker connection closed mid-run. Retry CI.",
      });
      assert.strictEqual(yield* slots.heldTotal, 0);

      const hung: BoardCiPassFinished[] = [];
      const { passes: hanging } = yield* passesWith({ run: () => Effect.never }, hung);
      yield* hanging.start(lintPass("run-2"));
      assert.strictEqual(yield* hanging.cancel(BoardCardId.make("card-1")), "run-2");
      yield* hanging.awaitIdle;
      assert.lengthOf(hung, 0);
    }).pipe(Effect.scoped, Effect.provide(BoardStepSlotsLive)),
);

it.effect("cancel never waits on the pass's fiber, and frees its slot at once", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const { passes, slots } = yield* passesWith(
      // A run whose teardown blocks, as a remote stream's close can.
      { run: () => Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(gate))) },
      [],
    );
    yield* passes.start(lintPass());
    yield* Effect.yieldNow;
    assert.strictEqual(yield* passes.cancel(BoardCardId.make("card-1")), "run-1");
    assert.strictEqual(yield* slots.heldTotal, 0);
    assert.isNull(passes.current(BoardCardId.make("card-1")));
    yield* Deferred.succeed(gate, undefined);
    yield* passes.awaitIdle;
  }).pipe(Effect.scoped, Effect.provide(BoardStepSlotsLive)),
);
