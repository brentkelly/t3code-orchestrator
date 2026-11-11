/**
 * Auto-advance walks the card's own project's pipeline. A
 * role-less stage one project switches off is skipped for that project's
 * cards only; every other project still stops there.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  withBoardProjectConfigVersion,
  type BoardState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  NOW,
  buildingCard,
  cardStage,
  codexStep,
  movedToBuilding,
  otherProjectId,
  projectId,
  settingsWith,
  stepCompleted,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const QA = BoardStageId.make("qa");
const stages = [
  ...BOARD_SEED_STAGES,
  {
    stageId: QA,
    label: "QA",
    role: null,
    orderKey: "k",
    createdAt: NOW,
    updatedAt: NOW,
    projectId: null,
  },
];
const baseBoard: BoardState = { cards: [], stages, nextCardNumberByProject: {} };
const config = withBoardProjectConfigVersion({
  ...EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  stageSwitches: { qa: false },
});

const ownCard = buildingCard("own", "m");
const otherCard = { ...buildingCard("other", "n"), projectId: otherProjectId };

it.effect("skips a stage switched off for the card's project, and only for it", () =>
  withGovernor(
    {
      board: {
        ...baseBoard,
        cards: [ownCard, otherCard],
        projectStageConfigs: { [projectId]: config },
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(ownCard, 1));
        yield* pumpDomain(stepCompleted(BoardCardId.make("own"), "succeeded", 2));
        assert.strictEqual(cardStage(yield* board, ownCard.id), BOARD_SEED_STAGE_IDS.review);

        yield* pumpDomain(movedToBuilding(otherCard, 3));
        yield* pumpDomain(stepCompleted(BoardCardId.make("other"), "succeeded", 4));
        assert.strictEqual(cardStage(yield* board, otherCard.id), QA);
      }),
  ),
);
