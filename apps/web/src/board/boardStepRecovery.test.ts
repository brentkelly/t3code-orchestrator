/**
 * The ways out of a stalled step (T3O-13): Continue, Restart, and Move to the
 * next stage, offered as one split button.
 */
import { BOARD_SEED_STAGE_IDS, BOARD_SEED_STAGES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardReviewPhaseShownStatus, resolveBoardStepRecovery } from "./boardStepRecovery";

const stages = BOARD_SEED_STAGES;

describe("resolveBoardStepRecovery", () => {
  it("offers Continue first, then Restart and the next stage, for a stalled review", () => {
    expect(
      resolveBoardStepRecovery({
        stages,
        stage: BOARD_SEED_STAGE_IDS.review,
        stalled: true,
        archived: false,
        blocked: false,
      }),
    ).toEqual({
      continueLabel: "Continue code review",
      restartLabel: "Restart code review",
      next: {
        label: "Move to Ready for merge",
        toStage: BOARD_SEED_STAGE_IDS.merge,
        disabledReason: null,
      },
    });
  });

  it("is not offered when nothing has stalled, or on an archived card", () => {
    const base = {
      stages,
      stage: BOARD_SEED_STAGE_IDS.review,
      archived: false,
      blocked: false,
    };
    expect(resolveBoardStepRecovery({ ...base, stalled: false })).toBeNull();
    expect(resolveBoardStepRecovery({ ...base, stalled: true, archived: true })).toBeNull();
  });

  it("works on any stage, naming that stage", () => {
    const recovery = resolveBoardStepRecovery({
      stages,
      stage: BOARD_SEED_STAGE_IDS.building,
      stalled: true,
      archived: false,
      blocked: false,
    });
    expect(recovery?.continueLabel).toBe("Continue building");
    expect(recovery?.restartLabel).toBe("Restart building");
    expect(recovery?.next?.toStage).toBe(BOARD_SEED_STAGE_IDS.review);
  });

  it("keeps the next stage visible but disabled while dependencies block the card", () => {
    expect(
      resolveBoardStepRecovery({
        stages,
        stage: BOARD_SEED_STAGE_IDS.review,
        stalled: true,
        archived: false,
        blocked: true,
      })?.next?.disabledReason,
    ).toBe("Blocked by unmet dependencies");
  });

  it("has no next stage on the last stage", () => {
    expect(
      resolveBoardStepRecovery({
        stages,
        stage: BOARD_SEED_STAGE_IDS.done,
        stalled: true,
        archived: false,
        blocked: false,
      })?.next,
    ).toBeNull();
  });
});

describe("boardReviewPhaseShownStatus", () => {
  // The other half of the report: the ledger walk calls the owed phase
  // "running", so the pane spun a spinner and said an adjudicator was checking
  // the fixes while no thread existed.
  it("does not show a stalled phase as running", () => {
    expect(boardReviewPhaseShownStatus("running", { offStage: false, stalled: true })).toBe(
      "stopped",
    );
  });

  it("shows a phase off the review stage as not started", () => {
    expect(boardReviewPhaseShownStatus("running", { offStage: true, stalled: false })).toBe(
      "pending",
    );
  });

  it("leaves a live phase, and every settled one, as the walk says", () => {
    expect(boardReviewPhaseShownStatus("running", { offStage: false, stalled: false })).toBe(
      "running",
    );
    expect(boardReviewPhaseShownStatus("done", { offStage: false, stalled: true })).toBe("done");
    expect(boardReviewPhaseShownStatus("skipped", { offStage: true, stalled: true })).toBe(
      "skipped",
    );
  });
});
