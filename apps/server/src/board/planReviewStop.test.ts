/**
 * Plan review (T3O-39) in the supervisor: turning a running review off sends
 * the planning thread a wrap-up turn, except into a step a human paused.
 */
import {
  BOARD_PLAN_REVIEW_STOP_INSTRUCTION,
  BoardCardId,
  boardCardStepState,
  type BoardCardStepState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildingCard,
  codexStep,
  movedToBuilding,
  settingsWith,
  turnInterruptRequested,
  withGovernor,
  type HarnessCommand,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";

const oneCard = (id: string) => ({
  board: { cards: [buildingCard(id, "m")], nextCardNumberByProject: {} },
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
});

const reviewStopped = (state: BoardCardStepState, stepId: string, sequence: number): HarnessEvent =>
  ({
    type: "board.plan-review-stopped",
    sequence,
    payload: { cardId: state.cardId, stepId, threadId: state.threadId, state },
  }) as unknown as HarnessEvent;

const sends = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.filter(
    (command): command is Extract<HarnessCommand, { type: "thread.send" }> =>
      command.type === "thread.send",
  );

it.effect("turning a running review off tells the live thread to wrap up", () =>
  withGovernor(oneCard("stop-live"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      yield* pumpDomain(movedToBuilding(buildingCard("stop-live", "m"), 1));
      const state = boardCardStepState(yield* board, BoardCardId.make("stop-live"));
      assert.strictEqual(state?.status, "running");
      const before = sends(yield* commands).length;

      yield* pumpDomain(reviewStopped(state!, state!.stepId, 2));

      const after = sends(yield* commands);
      assert.strictEqual(after.length, before + 1);
      assert.strictEqual(after.at(-1)?.threadId, state!.threadId);
      assert.strictEqual(after.at(-1)?.text, BOARD_PLAN_REVIEW_STOP_INSTRUCTION);
    }),
  ),
);

it.effect("a paused step is not told, so the turn cannot un-pause it", () =>
  withGovernor(oneCard("stop-paused"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      yield* pumpDomain(movedToBuilding(buildingCard("stop-paused", "m"), 1));
      const state = boardCardStepState(yield* board, BoardCardId.make("stop-paused"));
      yield* pumpDomain(turnInterruptRequested(state!.threadId!, 2));
      assert.strictEqual(
        boardCardStepState(yield* board, BoardCardId.make("stop-paused"))?.status,
        "paused",
      );
      const before = sends(yield* commands).length;

      const paused = boardCardStepState(yield* board, BoardCardId.make("stop-paused"));
      yield* pumpDomain(reviewStopped(paused!, paused!.stepId, 3));

      assert.strictEqual(sends(yield* commands).length, before);
    }),
  ),
);

it.effect("a stop for a step that is no longer live sends nothing", () =>
  withGovernor(oneCard("stop-stale"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      yield* pumpDomain(movedToBuilding(buildingCard("stop-stale", "m"), 1));
      const state = boardCardStepState(yield* board, BoardCardId.make("stop-stale"));
      const before = sends(yield* commands).length;

      yield* pumpDomain(reviewStopped(state!, "planning", 2));

      assert.strictEqual(sends(yield* commands).length, before);
    }),
  ),
);
