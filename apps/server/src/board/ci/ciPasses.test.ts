/**
 * A CI pass whose run dies still reports, so the card never sits in
 * CI "running" with nothing behind it.
 */
import { BOARD_LOCAL_WORKER_ID, BoardCardId, EnvironmentId, CommandId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";

import { makeBoardCiPasses, type BoardCiPassFinished } from "./ciPasses.ts";

it.effect("a runner defect still reports the pass, as unavailable", () =>
  Effect.gen(function* () {
    const finished: BoardCiPassFinished[] = [];
    const passes = yield* makeBoardCiPasses({
      runner: { run: () => Effect.die(new Error("mkdir exploded")) },
      admit: () => Effect.succeed(true),
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
    });
    assert.isTrue(started);
    yield* passes.awaitIdle;
    assert.lengthOf(finished, 1);
    assert.strictEqual(finished[0]!.outcome.result, "unavailable");
    assert.isFalse(passes.busy());
  }).pipe(Effect.scoped),
);

it.effect("a pass whose card has no room queues, and admitting starts the ones that now do", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    // T3O-86: a light card's pass takes a grow claim first; worker A has no room yet.
    const room = new Set<string>(["worker-b"]);
    const passes = yield* makeBoardCiPasses({
      runner: {
        run: () =>
          Deferred.await(release).pipe(
            Effect.as({ result: "passed" as const, failedIndex: null, ranAll: true }),
          ),
      },
      admit: (request) => Effect.sync(() => room.has(request.workerId)),
      dispatch: () => Effect.void,
      commandId: (tag) => Effect.succeed(CommandId.make(tag)),
      nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
      onFinished: () => Effect.void,
    });
    const workerA = EnvironmentId.make("worker-a");
    const workerB = EnvironmentId.make("worker-b");
    const request = (card: string, workerId: EnvironmentId) => ({
      cardId: BoardCardId.make(card),
      runId: `run-${card}`,
      worktreePath: "/tmp/nowhere",
      workerId,
      steps: [{ name: "Lint", command: "vp lint", timeoutMinutes: 1 }],
    });
    assert.isFalse(yield* passes.start(request("a1", workerA)));
    assert.isTrue(yield* passes.start(request("b1", workerB)));
    assert.strictEqual(passes.current(BoardCardId.make("a1")), "run-a1");
    room.add("worker-a");
    yield* passes.admitQueued;
    assert.isTrue(passes.busy());
    yield* Deferred.succeed(release, undefined);
    yield* passes.awaitIdle;
  }).pipe(Effect.scoped),
);

const passesWith = (
  runner: Parameters<typeof makeBoardCiPasses>[0]["runner"],
  finished: BoardCiPassFinished[],
) =>
  Effect.gen(function* () {
    const passes = yield* makeBoardCiPasses({
      runner,
      admit: () => Effect.succeed(true),
      dispatch: () => Effect.void,
      commandId: (tag) => Effect.succeed(CommandId.make(tag)),
      nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
      onFinished: (done) => Effect.sync(() => finished.push(done)),
    });
    return { passes };
  });

const lintPass = (runId = "run-1") => ({
  cardId: BoardCardId.make("card-1"),
  runId,
  worktreePath: "/tmp/nowhere",
  workerId: BOARD_LOCAL_WORKER_ID,
  steps: [{ name: "Lint", command: "vp lint", timeoutMinutes: 1 }],
});

it.effect("a finished pass stays current until its result is claimed, once, and settled", () =>
  Effect.gen(function* () {
    const finished: BoardCiPassFinished[] = [];
    const { passes } = yield* passesWith(
      {
        run: () => Effect.succeed({ result: "failed", failedIndex: 0, ranAll: false, exitCode: 2 }),
      },
      finished,
    );
    const card = BoardCardId.make("card-1");
    yield* passes.start(lintPass());
    yield* passes.awaitIdle;
    assert.lengthOf(finished, 1);
    const token = finished[0]!.token;
    // The fiber is gone, but the pass is not idle: its result is still on its way to the
    // reactor.
    assert.isFalse(passes.busy());
    assert.strictEqual(passes.current(card), "run-1");
    // A duplicate report, or one for another launch, claims nothing.
    assert.isFalse(passes.claim(card, token + 1));
    assert.isTrue(passes.claim(card, token));
    assert.isFalse(passes.claim(card, token));
    passes.settle(card, token);
    assert.isNull(passes.current(card));
  }).pipe(Effect.scoped),
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
            Effect.as({ result: "passed" as const, failedIndex: null, ranAll: true }),
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
  }).pipe(Effect.scoped),
);

it.effect(
  "an interrupt nobody asked for reports the pass unavailable; a cancel reports nothing",
  () =>
    Effect.gen(function* () {
      const finished: BoardCiPassFinished[] = [];
      const { passes } = yield* passesWith(
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

      const hung: BoardCiPassFinished[] = [];
      const { passes: hanging } = yield* passesWith({ run: () => Effect.never }, hung);
      yield* hanging.start(lintPass("run-2"));
      assert.strictEqual(yield* hanging.cancel(BoardCardId.make("card-1")), "run-2");
      yield* hanging.awaitIdle;
      assert.lengthOf(hung, 0);
    }).pipe(Effect.scoped),
);

it.effect("cancel never waits on the pass's fiber", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const { passes } = yield* passesWith(
      // A run whose teardown blocks, as a remote stream's close can.
      { run: () => Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(gate))) },
      [],
    );
    yield* passes.start(lintPass());
    yield* Effect.yieldNow;
    assert.strictEqual(yield* passes.cancel(BoardCardId.make("card-1")), "run-1");
    assert.isNull(passes.current(BoardCardId.make("card-1")));
    yield* Deferred.succeed(gate, undefined);
    yield* passes.awaitIdle;
  }).pipe(Effect.scoped),
);
