/**
 * T3O-43 — auto-advance walks the card's own project's pipeline. A role-less
 * stage one project's `t3o.json` removes is skipped for that project's cards
 * only; every other project still stops there.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  resolveT3oProjectFile,
  type BoardState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardProjectConfig } from "./projectConfig/BoardProjectConfig.ts";
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
const FILE = { stages: { remove: ["qa"] } };
const source = { path: "/tmp/project-1/t3o.json", commitSha: null };

const baseBoard: BoardState = { cards: [], stages, nextCardNumberByProject: {} };
const config = resolveT3oProjectFile({
  raw: FILE,
  board: baseBoard,
  projectId,
  source,
  now: NOW,
}).config;

const ownCard = buildingCard("own", "m");
const otherCard = { ...buildingCard("other", "n"), projectId: otherProjectId };

it.effect("skips a stage removed for the card's project, and only for it", () =>
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
  ).pipe(
    Effect.provideService(BoardProjectConfig, {
      read: (root) =>
        Effect.succeed(
          root === "/tmp/project-1"
            ? { raw: FILE, warnings: [], source }
            : { raw: null, warnings: [], source: null },
        ),
    }),
  ),
);
