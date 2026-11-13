/**
 * The server's plan review resolution: which step has a review
 * running, and the stance its instructions are worded for.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  DEFAULT_BOARD_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardState,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  planReviewInstructions,
  resolveCardPlanReview,
  runningPlanReviewStep,
} from "./planReview.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const cardId = BoardCardId.make("card-1");

const card = (overrides: Partial<BoardCard> = {}): BoardCard => ({
  id: cardId,
  key: "T3-1",
  cardNumber: 1,
  projectId: ProjectId.make("project-1"),
  labels: [],
  stage: BoardStageId.make("planning"),
  orderKey: "m",
  title: "Card",
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  sourcePlanId: null,
  group: null,
  threadLinks: [],
  attachments: [],
  externalRef: null,
  humanInLoop: null,
  reviewOverrides: null,
  modelOverrides: null,
  splitRationale: null,
  baseBranch: null,
  scheduledStartAt: null,
  autoPlanSetting: null,
  autoBuildSetting: null,
  autoMergeSetting: null,
  autoMergeHold: null,
  mergeStrategy: null,
  pinnedWorkerId: null,
  placedWorkerId: null,
  workerMove: null,
  placementOrphaned: null,
  ci: null,
  ciLastOutcome: null,
  ciRoundTrips: 0,
  resources: null,
  worktree: null,
  pullRequest: null,
  pullRequestHistory: [],
  pullRequestFloor: null,
  blocked: false,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const state = (overrides: Partial<BoardCardStepState> = {}): BoardCardStepState => ({
  cardId,
  stepId: "planning",
  stepLabel: null,
  stageLabel: "Planning",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  lastNudgeAt: null,
  prompt: "",
  providerInstanceId: ProviderInstanceId.make("claude"),
  model: "opus",
  mode: "plan",
  runtimeMode: "approval-required",
  humanInLoop: true,
  maxAttempts: 3,
  timeoutMs: 1000,
  baseTipAtRoundStart: null,
  lastError: null,
  threadId: ThreadId.make("thread-1"),
  status: "running",
  slotHeld: false,
  forceStart: false,
  queuedBy: null,
  queuedDetail: null,
  startedAt: NOW,
  updatedAt: NOW,
  planReviewStartedAt: NOW,
  planReviewRounds: 2,
  ...overrides,
});

const boardOf = (c: BoardCard, s: BoardCardStepState): BoardState => ({
  cards: [c],
  stepStates: [s],
  nextCardNumberByProject: {},
});

const settings = DEFAULT_BOARD_SETTINGS;

describe("plan review on the server", () => {
  it("follows the Settings default until the card sets its own", () => {
    const board = boardOf(card(), state());
    assert.deepStrictEqual(resolveCardPlanReview({ board, card: card(), settings }), {
      enabled: false,
      rounds: 2,
    });
    const own = card({ planReview: { enabled: true, rounds: 6 } });
    assert.deepStrictEqual(resolveCardPlanReview({ board, card: own, settings }), {
      enabled: true,
      rounds: 6,
    });
    assert.strictEqual(BOARD_SEED_STAGE_IDS.planning, "planning");
  });

  it("a review runs only on a live planning step that started one, while it is on", () => {
    const on = card({ planReview: { enabled: true, rounds: 2 } });
    assert.isNotNull(runningPlanReviewStep({ board: boardOf(on, state()), card: on, settings }));
    const off = card({ planReview: { enabled: false, rounds: 2 } });
    assert.isNull(runningPlanReviewStep({ board: boardOf(off, state()), card: off, settings }));
    const { planReviewStartedAt: _a, planReviewRounds: _b, ...notStarted } = state();
    assert.isNull(runningPlanReviewStep({ board: boardOf(on, notStarted), card: on, settings }));
    const settled = state({ status: "succeeded" });
    assert.isNull(runningPlanReviewStep({ board: boardOf(on, settled), card: on, settings }));
    const building = state({ stepId: "building" });
    assert.isNull(runningPlanReviewStep({ board: boardOf(on, building), card: on, settings }));
  });

  it("a started review outlives the Settings default turning off; only the card's toggle stops it", () => {
    const inherited = card();
    assert.isFalse(
      resolveCardPlanReview({ board: boardOf(inherited, state()), card: inherited, settings })
        .enabled,
    );
    assert.isNotNull(
      runningPlanReviewStep({ board: boardOf(inherited, state()), card: inherited, settings }),
    );
  });

  it("words the instructions for a pending auto-plan as unattended", () => {
    const on = card({ planReview: { enabled: true, rounds: 2 } });
    const attended = planReviewInstructions({
      board: boardOf(on, state()),
      card: on,
      settings,
      state: state(),
    });
    assert.include(attended?.instructions ?? "", "sign-off");
    const autoPlanned = card({
      planReview: { enabled: true, rounds: 2 },
      autoPlan: { requestedAt: NOW, endedAt: null },
    });
    const unattended = planReviewInstructions({
      board: boardOf(autoPlanned, state()),
      card: autoPlanned,
      settings,
      state: state(),
    });
    assert.include(unattended?.instructions ?? "", "ask nothing");
    assert.strictEqual(unattended?.rounds, 2);
  });
});
