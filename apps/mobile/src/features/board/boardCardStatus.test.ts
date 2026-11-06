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
      stepAwaiting: "permission",
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
    ).toBe("Needs approval");
    expect(
      boardCardStatus({
        card: card({ stage: ids.planning, planCount: 2, planTotal: 2, planDone: 0 }),
        stages: BOARD_SEED_STAGES,
      }),
    ).toBeNull();
  });
});
