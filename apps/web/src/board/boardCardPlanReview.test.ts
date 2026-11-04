import { BOARD_SEED_STAGES, BoardStageId, type BoardPlanReviewSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardCardPlanReviewView, nextBoardCardPlanReview } from "./boardCardPlanReview";

const planning = BoardStageId.make("planning");
const settings = (overrides: Partial<BoardPlanReviewSettings> = {}) => ({
  planReview: { enabledByDefault: false, defaultRounds: 2, prompt: null, ...overrides },
});

describe("boardCardPlanReviewView", () => {
  it("shows the section up to and including Planning, and hides it after", () => {
    for (const stage of ["backlog", "sprint", "planning"]) {
      expect(
        boardCardPlanReviewView({
          card: { stage: BoardStageId.make(stage) },
          isGroup: false,
          stages: BOARD_SEED_STAGES,
          planStageExecution: settings(),
        }),
      ).not.toBeNull();
    }
    for (const stage of ["ready", "building", "review", "done"]) {
      expect(
        boardCardPlanReviewView({
          card: { stage: BoardStageId.make(stage) },
          isGroup: false,
          stages: BOARD_SEED_STAGES,
          planStageExecution: settings(),
        }),
      ).toBeNull();
    }
  });

  it("hides the section on a group", () => {
    expect(
      boardCardPlanReviewView({
        card: { stage: planning },
        isGroup: true,
        stages: BOARD_SEED_STAGES,
        planStageExecution: settings(),
      }),
    ).toBeNull();
  });

  it("follows the Settings default until the card sets its own", () => {
    const inherited = boardCardPlanReviewView({
      card: { stage: planning },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings({ enabledByDefault: true, defaultRounds: 3 }),
    });
    expect(inherited).toMatchObject({ enabled: true, rounds: 3, summary: "3 rounds" });
    const own = boardCardPlanReviewView({
      card: { stage: planning, planReview: { enabled: false, rounds: 5 } },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings({ enabledByDefault: true, defaultRounds: 3 }),
    });
    expect(own).toMatchObject({ enabled: false, rounds: 5, summary: "Off" });
  });

  it("locks the rounds while a review is in progress on the planning step", () => {
    const view = boardCardPlanReviewView({
      card: { stage: planning, planReview: { enabled: true, rounds: 4 } },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings(),
      planReviewStarted: { rounds: 1 },
    });
    expect(view).toMatchObject({
      inProgress: true,
      rounds: 1,
      summary: "In progress · 1 round",
      canDecrease: false,
      canIncrease: false,
    });
  });

  it("does not report a review in progress once it is turned off", () => {
    const view = boardCardPlanReviewView({
      card: { stage: planning, planReview: { enabled: false, rounds: 2 } },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings(),
      planReviewStarted: { rounds: 2 },
    });
    expect(view).toMatchObject({ inProgress: false, summary: "Off" });
  });

  it("stops the stepper at 1 and 20", () => {
    const low = boardCardPlanReviewView({
      card: { stage: planning, planReview: { enabled: true, rounds: 1 } },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings(),
    });
    expect(low).toMatchObject({ canDecrease: false, canIncrease: true });
    const high = boardCardPlanReviewView({
      card: { stage: planning, planReview: { enabled: true, rounds: 20 } },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings(),
    });
    expect(high).toMatchObject({ canDecrease: true, canIncrease: false });
  });
});

describe("nextBoardCardPlanReview", () => {
  it("pins the card with the shown rounds when toggled", () => {
    expect(nextBoardCardPlanReview({ enabled: false, rounds: 3 }, { enabled: true })).toEqual({
      enabled: true,
      rounds: 3,
    });
  });

  it("clamps a typed round count into 1–20", () => {
    expect(nextBoardCardPlanReview({ enabled: true, rounds: 2 }, { rounds: 99 })).toEqual({
      enabled: true,
      rounds: 20,
    });
    expect(nextBoardCardPlanReview({ enabled: true, rounds: 2 }, { rounds: 0 })).toEqual({
      enabled: true,
      rounds: 1,
    });
  });
});
