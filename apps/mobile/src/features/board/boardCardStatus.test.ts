import { BOARD_SEED_STAGE_IDS, BOARD_SEED_STAGES, boardCardAttention } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardCardStatus, type BoardCardStatusCard } from "./boardCardStatus";

const ids = BOARD_SEED_STAGE_IDS;

function card(
  overrides: Partial<BoardCardStatusCard> & Pick<BoardCardStatusCard, "stage">,
): BoardCardStatusCard {
  return {
    stalled: false,
    held: false,
    awaitingInput: false,
    stepAwaiting: null,
    stepRunning: false,
    threadState: "none",
    queued: false,
    archivedAt: null,
    blocked: false,
    ...overrides,
  };
}

describe("boardCardStatus", () => {
  it("marks an archived card green", () => {
    const tone = boardCardStatus({
      card: card({ stage: ids.building, archivedAt: "2026-01-01T00:00:00.000Z", stalled: true }),
      stages: BOARD_SEED_STAGES,
    });
    expect(tone?.label).toBe("Archived");
    expect(tone?.textClassName).toBe("text-adaptive-emerald-700-300");
  });

  it("marks a done-stage card green even when the step is held", () => {
    const tone = boardCardStatus({
      card: card({ stage: ids.done, held: true }),
      stages: BOARD_SEED_STAGES,
    });
    expect(tone?.label).toBe("Done");
    expect(tone?.textClassName).toBe("text-adaptive-emerald-700-300");
  });

  it("marks a working card blue", () => {
    const tone = boardCardStatus({
      card: card({ stage: ids.building, stepRunning: true, threadState: "working" }),
      stages: BOARD_SEED_STAGES,
    });
    expect(tone?.label).toBe("Running");
    expect(tone?.textClassName).toBe("text-update-foreground");
  });

  it("keeps a queued card neutral", () => {
    const tone = boardCardStatus({
      card: card({ stage: ids.building, queued: true }),
      stages: BOARD_SEED_STAGES,
    });
    expect(tone?.label).toBe("Queued");
    expect(tone?.textClassName).toBe("text-foreground-secondary");
  });

  it("ranks a conflict rewrite above Running", () => {
    const tone = boardCardStatus({
      card: card({
        stage: ids.merge,
        stepRunning: true,
        threadState: "working",
        stepConflictFix: true,
      }),
      stages: BOARD_SEED_STAGES,
    });
    expect(tone?.label).toBe("Conflicts");
    expect(tone?.textClassName).toBe("text-warning-foreground");
  });

  it("ranks a queued conflict rewrite as Conflicts, not Queued", () => {
    const tone = boardCardStatus({
      card: card({ stage: ids.merge, queued: true, stepConflictFix: true }),
      stages: BOARD_SEED_STAGES,
    });
    expect(tone?.label).toBe("Conflicts");
    expect(tone?.textClassName).toBe("text-warning-foreground");
  });

  it("ranks a CI fix above Running", () => {
    const tone = boardCardStatus({
      card: card({
        stage: ids.merge,
        stepRunning: true,
        threadState: "working",
        stepChecksFix: true,
      }),
      stages: BOARD_SEED_STAGES,
    });
    expect(tone?.label).toBe("Fixing CI");
    expect(tone?.textClassName).toBe("text-warning-foreground");
  });

  it("ranks a queued CI fix as Fixing CI, not Queued", () => {
    const tone = boardCardStatus({
      card: card({ stage: ids.merge, queued: true, stepChecksFix: true }),
      stages: BOARD_SEED_STAGES,
    });
    expect(tone?.label).toBe("Fixing CI");
    expect(tone?.textClassName).toBe("text-warning-foreground");
  });

  it("ranks a pending question above a conflict rewrite", () => {
    const waiting = card({
      stage: ids.merge,
      stepConflictFix: true,
      awaitingInput: true,
      threadState: "waiting",
    });
    expect(boardCardAttention({ card: waiting, stages: BOARD_SEED_STAGES })?.reason).toBe("input");
    const tone = boardCardStatus({ card: waiting, stages: BOARD_SEED_STAGES });
    expect(tone?.label).toBe("Input needed");
    expect(tone?.textClassName).toBe("text-adaptive-violet-700-300");
  });

  it("marks a blocked card amber", () => {
    const tone = boardCardStatus({
      card: card({ stage: ids.ready, blocked: true }),
      stages: BOARD_SEED_STAGES,
    });
    expect(tone?.label).toBe("Blocked");
    expect(tone?.textClassName).toBe("text-warning-foreground");
  });

  it("ranks a pending question above a queue slot", () => {
    const waiting = card({
      stage: ids.building,
      queued: true,
      awaitingInput: true,
      threadState: "waiting",
    });
    expect(boardCardAttention({ card: waiting, stages: BOARD_SEED_STAGES })?.reason).toBe("input");
    const tone = boardCardStatus({ card: waiting, stages: BOARD_SEED_STAGES });
    expect(tone?.label).toBe("Input needed");
    expect(tone?.textClassName).toBe("text-adaptive-violet-700-300");
  });

  it("ranks a pending question above the dependency gate", () => {
    const waiting = card({
      stage: ids.building,
      blocked: true,
      awaitingInput: true,
      threadState: "waiting",
    });
    expect(boardCardAttention({ card: waiting, stages: BOARD_SEED_STAGES })?.reason).toBe("input");
    const tone = boardCardStatus({ card: waiting, stages: BOARD_SEED_STAGES });
    expect(tone?.label).toBe("Input needed");
    expect(tone?.textClassName).toBe("text-adaptive-violet-700-300");
  });

  it("ranks a permission prompt above the dependency gate", () => {
    const waiting = card({
      stage: ids.building,
      blocked: true,
      threadState: "waiting",
    });
    expect(boardCardAttention({ card: waiting, stages: BOARD_SEED_STAGES })?.reason).toBe(
      "permission",
    );
    const tone = boardCardStatus({ card: waiting, stages: BOARD_SEED_STAGES });
    expect(tone?.label).toBe("Needs permission");
    expect(tone?.textClassName).toBe("text-adaptive-violet-700-300");
  });

  it("marks a waiting-on-human card violet", () => {
    const waiting = card({
      stage: ids.planning,
      awaitingInput: true,
      threadState: "waiting",
    });
    expect(boardCardAttention({ card: waiting, stages: BOARD_SEED_STAGES })).not.toBeNull();
    const tone = boardCardStatus({ card: waiting, stages: BOARD_SEED_STAGES });
    expect(tone?.textClassName).toBe("text-adaptive-violet-700-300");
  });

  it("returns no pill for a quiet backlog card", () => {
    expect(
      boardCardStatus({
        card: card({ stage: ids.backlog }),
        stages: BOARD_SEED_STAGES,
      }),
    ).toBeNull();
  });

  it("marks a split parent Needs approval only before children exist", () => {
    expect(
      boardCardStatus({
        card: card({ stage: ids.planning, planCount: 2 }),
        stages: BOARD_SEED_STAGES,
      })?.label,
    ).toBe("Input needed");
    expect(
      boardCardStatus({
        card: card({ stage: ids.planning, planCount: 2, planTotal: 2, planDone: 0 }),
        stages: BOARD_SEED_STAGES,
      }),
    ).toBeNull();
  });

  it("ranks a pause above Running while the interrupted turn is still working", () => {
    const paused = card({
      stage: ids.building,
      stepAwaiting: "paused",
      threadState: "working",
    });
    expect(boardCardAttention({ card: paused, stages: BOARD_SEED_STAGES })?.reason).toBe("paused");
    expect(boardCardAttention({ card: paused, stages: BOARD_SEED_STAGES })?.label).toBe("Paused");
    const tone = boardCardStatus({ card: paused, stages: BOARD_SEED_STAGES });
    expect(tone?.label).toBe("Paused");
    expect(tone?.textClassName).toBe("text-foreground-secondary");
  });

  it("ranks a stall above Running", () => {
    const stalled = card({
      stage: ids.building,
      stalled: true,
      threadState: "working",
      stepRunning: true,
    });
    expect(boardCardAttention({ card: stalled, stages: BOARD_SEED_STAGES })?.reason).toBe(
      "stalled",
    );
    const tone = boardCardStatus({ card: stalled, stages: BOARD_SEED_STAGES });
    expect(tone?.label).toBe("Stalled — needs a human");
    expect(tone?.textClassName).toBe("text-warning-foreground");
  });

  it("ranks Needs approval above Running", () => {
    const pending = card({
      stage: ids.planning,
      planCount: 2,
      threadState: "working",
    });
    expect(boardCardAttention({ card: pending, stages: BOARD_SEED_STAGES })?.reason).toBe(
      "approval",
    );
    const tone = boardCardStatus({ card: pending, stages: BOARD_SEED_STAGES });
    expect(tone?.label).toBe("Input needed");
    expect(tone?.label).not.toBe("Running");
  });

  it("ranks a held review loop above Running", () => {
    const held = card({
      stage: ids.review,
      reviewOutcome: "round-cap",
      threadState: "working",
      stepRunning: true,
    });
    expect(boardCardAttention({ card: held, stages: BOARD_SEED_STAGES })?.reason).toBe(
      "review-held",
    );
    const tone = boardCardStatus({ card: held, stages: BOARD_SEED_STAGES });
    expect(tone?.label).toBe("No convergence");
    expect(tone?.textClassName).toBe("text-warning-foreground");
  });

  it("keeps Running for a working card whose held or stopped flags are stale", () => {
    expect(
      boardCardStatus({
        card: card({
          stage: ids.building,
          held: true,
          threadState: "working",
          stepRunning: true,
        }),
        stages: BOARD_SEED_STAGES,
      })?.label,
    ).toBe("Running");
    expect(
      boardCardStatus({
        card: card({
          stage: ids.building,
          stepAwaiting: "stopped",
          threadState: "working",
        }),
        stages: BOARD_SEED_STAGES,
      })?.label,
    ).toBe("Running");
  });

  it("inherits a child's Input needed onto an idle split parent", () => {
    const parent = card({
      stage: ids.planning,
      planTotal: 2,
      planDone: 0,
    });
    const childAttention = {
      reason: "input" as const,
      tone: "attention" as const,
      label: "Input needed",
      detail: "A thread on this card is waiting on your answer",
      childCount: 1,
    };
    expect(boardCardStatus({ card: parent, stages: BOARD_SEED_STAGES })).toBeNull();
    const tone = boardCardStatus({
      card: parent,
      stages: BOARD_SEED_STAGES,
      childAttention,
    });
    expect(tone?.label).toBe("1 child needs you");
    expect(tone?.textClassName).toBe("text-adaptive-violet-700-300");
  });

  it("does not let a child roll-up hide the parent's own Input needed", () => {
    const parent = card({
      stage: ids.planning,
      awaitingInput: true,
      threadState: "waiting",
    });
    const tone = boardCardStatus({
      card: parent,
      stages: BOARD_SEED_STAGES,
      childAttention: {
        reason: "stalled",
        tone: "warning",
        label: "Stalled — needs a human",
        detail: "Stalled",
        childCount: 1,
      },
    });
    expect(tone?.label).toBe("Input needed");
  });

  it("shows Running when a child is working and the parent is idle", () => {
    const parent = card({
      stage: ids.planning,
      planTotal: 2,
      planDone: 0,
    });
    expect(boardCardStatus({ card: parent, stages: BOARD_SEED_STAGES })).toBeNull();
    expect(
      boardCardStatus({
        card: parent,
        stages: BOARD_SEED_STAGES,
        childRunning: 1,
      })?.label,
    ).toBe("Running");
  });
});
