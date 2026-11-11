/**
 * The model ladder for a step: the stage's own model, then the board's default, then the card's
 * project's own default model, then the app's text generation selection.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  boardCardStepState,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type BoardSettings,
  type ProjectSettingsOverrides,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  cardMoved,
  projectId,
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

const PROJECT_DEFAULT = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5",
  options: [{ id: "effort", value: "high" }],
};

const projectDefaultOverride = (
  forProject: ProjectId,
): Record<ProjectId, ProjectSettingsOverrides> => {
  const overrides: Record<ProjectId, ProjectSettingsOverrides> = {};
  overrides[forProject] = { defaultModelSelection: PROJECT_DEFAULT };
  return overrides;
};

it.effect("with no board default, the card's project default model governs (T3O-74)", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: planningWithoutModel(null),
      serverSettings: { projectSettingsOverrides: projectDefaultOverride(projectId) },
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.providerInstanceId, PROJECT_DEFAULT.instanceId);
        assert.strictEqual(state?.model, PROJECT_DEFAULT.model);
        assert.deepStrictEqual(state?.modelOptions, PROJECT_DEFAULT.options);
      }),
  ),
);

it.effect("the environment's new-thread default and other projects' defaults are not tiers", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: planningWithoutModel(null),
      serverSettings: {
        defaultModelSelection: PROJECT_DEFAULT,
        projectSettingsOverrides: projectDefaultOverride(ProjectId.make("project-other")),
      },
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));
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

it.effect("the board default still outranks the project default", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: planningWithoutModel(BOARD_DEFAULT),
      serverSettings: { projectSettingsOverrides: projectDefaultOverride(projectId) },
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));
        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.model, BOARD_DEFAULT.model);
      }),
  ),
);
