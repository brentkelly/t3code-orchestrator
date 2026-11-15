import { BOARD_SEED_STAGES, BoardStageId, type BoardPlanReviewSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardPlanReviewView,
  boardPlanReviewFinishedFromActivity,
  nextBoardCardPlanReview,
} from "./boardCardPlanReview";

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
    expect(inherited).toMatchObject({ enabled: true, rounds: 3, summary: "Waiting for plan" });
    const own = boardCardPlanReviewView({
      card: { stage: planning, planReview: { enabled: false, rounds: 5 } },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings({ enabledByDefault: true, defaultRounds: 3 }),
    });
    expect(own).toMatchObject({ enabled: false, rounds: 5, summary: "Off" });
  });

  it("keeps the rounds adjustable while a review is in progress, within 1 to 20", () => {
    const view = boardCardPlanReviewView({
      card: { stage: planning, planReview: { enabled: true, rounds: 4 } },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings(),
      planReviewStarted: { rounds: 1 },
    });
    expect(view).toMatchObject({
      phase: "reviewing",
      inProgress: true,
      rounds: 1,
      summary: "Reviewing · up to 1 round",
      canDecrease: false,
      canIncrease: true,
    });
    const high = boardCardPlanReviewView({
      card: { stage: planning, planReview: { enabled: true, rounds: 20 } },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings(),
      planReviewStarted: { rounds: 20 },
    });
    expect(high).toMatchObject({ inProgress: true, canDecrease: true, canIncrease: false });
  });

  it("keeps an inherited review in progress after the Settings default turns off", () => {
    const view = boardCardPlanReviewView({
      card: { stage: planning },
      isGroup: false,
      stages: BOARD_SEED_STAGES,
      planStageExecution: settings({ enabledByDefault: false }),
      planReviewStarted: { rounds: 3 },
    });
    expect(view).toMatchObject({
      enabled: true,
      inProgress: true,
      rounds: 3,
      summary: "Reviewing · up to 3 rounds",
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
    expect(
      nextBoardCardPlanReview({ enabled: false, rounds: 3, unattended: false }, { enabled: true }),
    ).toEqual({
      enabled: true,
      rounds: 3,
    });
  });

  it("clamps a typed round count into 1–20", () => {
    expect(
      nextBoardCardPlanReview({ enabled: true, rounds: 2, unattended: false }, { rounds: 99 }),
    ).toEqual({
      enabled: true,
      rounds: 20,
    });
    expect(
      nextBoardCardPlanReview({ enabled: true, rounds: 2, unattended: false }, { rounds: 0 }),
    ).toEqual({
      enabled: true,
      rounds: 1,
    });
  });
});

const view = (input: Partial<Parameters<typeof boardCardPlanReviewView>[0]> = {}) =>
  boardCardPlanReviewView({
    card: { stage: planning, planReview: { enabled: true, rounds: 3 } },
    isGroup: false,
    stages: BOARD_SEED_STAGES,
    planStageExecution: settings(),
    ...input,
  });

describe("boardCardPlanReviewView phases", () => {
  it("walks waiting, ready to start, reviewing, round, waiting for you and reviewed", () => {
    expect(view({ hasPlan: false })).toMatchObject({
      phase: "waiting-for-plan",
      summary: "Waiting for plan",
      progress: null,
    });
    expect(view({ hasPlan: true, awaitingStart: true })).toMatchObject({
      phase: "ready-to-start",
      summary: "Ready to start",
      note: "Nothing is sent until you start.",
    });
    expect(view({ planReviewStarted: { rounds: 3 } })).toMatchObject({
      phase: "reviewing",
      summary: "Reviewing · up to 3 rounds",
      progress: ["todo", "todo", "todo"],
    });
    expect(view({ planReviewStarted: { rounds: 3, round: 2 } })).toMatchObject({
      phase: "round",
      summary: "Round 2 of 3",
      inProgress: true,
      progress: ["done", "running", "todo"],
    });
    expect(
      view({ planReviewStarted: { rounds: 3, round: 2, doneAt: "2026-01-01T00:00:00.000Z" } }),
    ).toMatchObject({
      phase: "waiting-for-you",
      summary: "Reviewed, waiting for you",
      inProgress: false,
      progress: ["done", "done", "todo"],
    });
    expect(view({ finished: { rounds: 3, roundsRun: 2, findings: 5 } })).toMatchObject({
      phase: "reviewed",
      summary: "Reviewed · 2 rounds · 5 findings",
    });
    expect(view({ finished: { rounds: 3, roundsRun: null, findings: null } })).toMatchObject({
      summary: "Reviewed · 3 rounds",
    });
  });

  it("says where the setting came from", () => {
    expect(
      view({
        card: {
          stage: planning,
          planReview: { enabled: true, rounds: 3, source: "default" },
        },
        projectTitle: "t3o",
      })?.provenance,
    ).toBe("On by default for t3o · 3 rounds");
    expect(
      view({ card: { stage: planning, planReview: { enabled: false, rounds: 3 } } })?.provenance,
    ).toBe("Off for this card");
    expect(view()?.provenance).toBeNull();
  });

  it("explains Unattended and the Sign-off gate it hands the plan to", () => {
    expect(view()).toMatchObject({
      unattended: false,
      unattendedNote: "Off: the agent can stop to ask you about findings between rounds",
      signOffNote: null,
    });
    const unattended = {
      stage: planning,
      planReview: { enabled: true, rounds: 4, unattended: true },
    };
    expect(view({ card: unattended, signOff: { on: true, tag: null } })).toMatchObject({
      unattended: true,
      unattendedNote: "Plan switches to auto from round 1",
      signOffNote: "Auto sign-off is on, so when round 4 ends the plan signs off.",
    });
    expect(view({ card: unattended, signOff: { on: false, tag: "from GRP" } })?.signOffNote).toBe(
      "Auto sign-off is off (from GRP): the reviewed plan waits for you.",
    );
  });
});

describe("nextBoardCardPlanReview and Unattended", () => {
  it("toggles unattended and drops the default marker on any edit", () => {
    const base = { enabled: true, rounds: 3, unattended: false };
    expect(nextBoardCardPlanReview(base, { unattended: true })).toEqual({
      enabled: true,
      rounds: 3,
      unattended: true,
    });
    expect(nextBoardCardPlanReview({ ...base, unattended: true }, { unattended: false })).toEqual({
      enabled: true,
      rounds: 3,
    });
    expect(nextBoardCardPlanReview({ ...base, unattended: true }, { rounds: 5 })).toEqual({
      enabled: true,
      rounds: 5,
      unattended: true,
    });
  });
});

describe("boardPlanReviewFinishedFromActivity", () => {
  it("reads the last finish after the last start, and forgets it on a new start or move", () => {
    const finished = {
      kind: "plan-review-finished",
      payload: { planReviewRounds: 3, planReviewRoundsRun: 2, planReviewFindings: 4 },
    };
    expect(boardPlanReviewFinishedFromActivity([finished])).toEqual({
      rounds: 3,
      roundsRun: 2,
      findings: 4,
    });
    expect(
      boardPlanReviewFinishedFromActivity([finished, { kind: "plan-review-started", payload: {} }]),
    ).toBeNull();
    expect(
      boardPlanReviewFinishedFromActivity([finished, { kind: "card-moved", payload: {} }]),
    ).toBeNull();
  });
});
