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
  buildingCard,
  cardMoved,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  settingsWith,
  stepStatus,
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

// Since v0.1.8 the app's text-generation selection may name an API-only text generator, which
// cannot run an agent. The board never guesses another model: the step fails, saying how to fix it.
const TEXT_GENERATOR = ProviderInstanceId.make("openai-api");
const textGeneratorFallback = {
  textGenerationModelSelection: { instanceId: TEXT_GENERATOR, model: "gpt-5-mini" },
  textGenerators: {
    [TEXT_GENERATOR]: {
      kind: "openai",
      baseUrl: "https://api.example.test",
      apiKey: "",
      enabled: true,
    },
  },
} as never;

it.effect("a fallback that names an API-only text generator fails the step clearly", () =>
  withGovernor(
    {
      board: { cards: [sprintCard()], nextCardNumberByProject: {} },
      settings: planningWithoutModel(null),
      appSettings: textGeneratorFallback,
    },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(1));

        const state = boardCardStepState(yield* board, cardId);
        assert.strictEqual(state?.status, "stalled");
        assert.strictEqual(
          state?.lastError,
          "This stage resolves to a text-generation model, which can't run an agent: pick an agent model for the stage, or set a board default model in Settings → Board.",
        );
        assert.isUndefined((yield* commands).find((command) => command.type === "thread.spawn"));
      }),
  ),
);

it.effect("a build step on a text generator gives its slot back", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("card-a", "a")], nextCardNumberByProject: {} },
      settings: settingsWith({
        building: [{ ...codexStep, providerInstanceId: TEXT_GENERATOR }],
        globalMaxConcurrent: 1,
      }),
      appSettings: textGeneratorFallback,
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-a", "a"), 1));

        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-a")), "stalled");
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);
