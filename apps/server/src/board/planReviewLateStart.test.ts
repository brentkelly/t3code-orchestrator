/**
 * Plan review (T3O-39) in the supervisor: turned on after the plan was posted,
 * the review's instructions go to the planning thread as a turn.
 */
import {
  BOARD_PLAN_REVIEW_LATE_START_LEAD,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  boardPlanId,
  type BoardCard,
  type BoardCardStepState,
  type BoardPlan,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  NOW,
  cardMoved,
  codexStep,
  makeBoardCard,
  settingsWith,
  turnInterruptRequested,
  withGovernor,
  type HarnessCommand,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";

const settings = settingsWith({
  building: [codexStep],
  planning: codexStep,
  planningHumanInLoop: true,
  globalMaxConcurrent: 3,
});

const planningCard = (id: string): BoardCard => ({
  ...makeBoardCard({ id, stage: "planning", orderKey: "m" }),
  planReview: { enabled: true, rounds: 2 },
});

const plan = (cardId: string): BoardPlan => ({
  planId: boardPlanId(BoardCardId.make(cardId), "one"),
  cardId: BoardCardId.make(cardId),
  title: "Plan",
  summary: "one",
  dependsOn: [],
  ordinal: 0,
  locked: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const fixture = (id: string) => ({
  board: { cards: [planningCard(id)], plans: [plan(id)], nextCardNumberByProject: {} },
  settings,
});

const reviewStarted = (
  state: BoardCardStepState,
  sequence: number,
  turnedOnLate: boolean,
): HarnessEvent =>
  ({
    type: "board.plan-review-started",
    sequence,
    payload: {
      cardId: state.cardId,
      state: { ...state, planReviewStartedAt: NOW, planReviewRounds: 2 },
      ...(turnedOnLate ? { turnedOnLate: true } : {}),
    },
  }) as unknown as HarnessEvent;

const sends = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.filter(
    (command): command is Extract<HarnessCommand, { type: "thread.send" }> =>
      command.type === "thread.send",
  );

it.effect("turned on after the plan was posted, the review instructions go to the thread", () =>
  withGovernor(fixture("late"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("late");
      yield* pumpDomain(cardMoved(planningCard("late"), "sprint", "planning", 1));
      const state = boardCardStepState(yield* board, id);
      assert.strictEqual(state?.stepId, String(BOARD_SEED_STAGE_IDS.planning));
      const before = sends(yield* commands).length;

      yield* pumpDomain(reviewStarted(state!, 2, true));

      const after = sends(yield* commands);
      assert.strictEqual(after.length, before + 1);
      assert.strictEqual(after.at(-1)?.threadId, state!.threadId);
      assert.isTrue(after.at(-1)?.text.startsWith(BOARD_PLAN_REVIEW_LATE_START_LEAD));
      assert.include(after.at(-1)?.text, "up to 2 rounds");
    }),
  ),
);

it.effect("a review started by a tool call sends nothing: the tool result carries it", () =>
  withGovernor(fixture("tool"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      yield* pumpDomain(cardMoved(planningCard("tool"), "sprint", "planning", 1));
      const state = boardCardStepState(yield* board, BoardCardId.make("tool"));
      const before = sends(yield* commands).length;

      yield* pumpDomain(reviewStarted(state!, 2, false));

      assert.strictEqual(sends(yield* commands).length, before);
    }),
  ),
);

it.effect("a paused step is not told, so the turn cannot un-pause it", () =>
  withGovernor(fixture("paused"), ({ pumpDomain, board, commands }) =>
    Effect.gen(function* () {
      const id = BoardCardId.make("paused");
      yield* pumpDomain(cardMoved(planningCard("paused"), "sprint", "planning", 1));
      const state = boardCardStepState(yield* board, id);
      yield* pumpDomain(turnInterruptRequested(state!.threadId!, 2));
      const paused = boardCardStepState(yield* board, id);
      assert.strictEqual(paused?.status, "paused");
      const before = sends(yield* commands).length;

      yield* pumpDomain(reviewStarted(paused!, 3, true));

      assert.strictEqual(sends(yield* commands).length, before);
    }),
  ),
);
