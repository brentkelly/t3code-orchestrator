/**
 * The model ladder for a step: the stage's own model, then the board's default, then the app's
 * text generation selection.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  boardCardStepState,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type BoardSettings,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  cardMoved,
  codexStep,
  makeBoardCard,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");
const sprintCard = () => makeBoardCard({ id: "card-1", stage: "sprint", orderKey: "m" });

const movedToPlanning = (sequence: number) =>
  cardMoved(
    makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" }),
    "sprint",
    "planning",
    sequence,
  );

const BOARD_DEFAULT = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
};

/** The shipped settings with Planning's own model cleared, so the stage has to
    fall back for its model exactly as an unconfigured one does. */
function planningWithoutModel(defaultModel: BoardSettings["defaultModel"]): BoardSettings {
  const base = settingsWith({ building: [codexStep], planning: codexStep, globalMaxConcurrent: 3 });
  const planning = base.pipeline[BOARD_SEED_STAGE_IDS.planning];
  assert.isDefined(planning);
  return {
    ...base,
    defaultModel,
    pipeline: {
      ...base.pipeline,
      [BOARD_SEED_STAGE_IDS.planning]: { ...planning!, model: null },
    },
  };
}

it.effect("a stage with no model of its own runs on the board's default", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: planningWithoutModel(BOARD_DEFAULT),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));

        // Frozen onto the run row, so the pair is resolved once at entry
        // rather than re-read while the card runs.
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.providerInstanceId, BOARD_DEFAULT.instanceId);
        assert.strictEqual(state?.model, BOARD_DEFAULT.model);
      }),
  ),
);

it.effect("the app's text-generation selection still governs when no default is set", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: planningWithoutModel(null),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));

        // The fallback behaviour, kept underneath: nobody who never sets a
        // board default sees their cards move.
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(
          state?.providerInstanceId,
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        );
        assert.strictEqual(
          state?.model,
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        );
      }),
  ),
);

it.effect("a stage that names its own model ignores the board default", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: {
        ...settingsWith({ building: [codexStep], planning: codexStep, globalMaxConcurrent: 3 }),
        defaultModel: BOARD_DEFAULT,
      },
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));

        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.providerInstanceId, codexStep.providerInstanceId);
      }),
  ),
);
