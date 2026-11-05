/**
 * T3O-44 — a CI pass whose run dies still reports, so the card never sits in
 * CI "running" with nothing behind it, and its slot comes back.
 */
import { BOARD_LOCAL_WORKER_ID, BoardCardId, CommandId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
