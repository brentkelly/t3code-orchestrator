import {
  BOARD_SEED_STAGE_IDS,
  BOARD_SEED_STAGES,
  boardCardAttention,
  type BoardCardShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { defaultBoardStageId, type DefaultBoardStageCard } from "./defaultBoardStageId.ts";

const ids = BOARD_SEED_STAGE_IDS;

function card(overrides: Partial<DefaultBoardStageCard> & Pick<DefaultBoardStageCard, "stage">): DefaultBoardStageCard {
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

describe("defaultBoardStageId", () => {
  it("returns null when there are no stages", () => {
    expect(defaultBoardStageId({ stages: [], cards: [] })).toBeNull();
  });

  it("returns the first stage when every column is empty", () => {
    expect(defaultBoardStageId({ stages: BOARD_SEED_STAGES, cards: [] })).toBe(ids.backlog);
  });

  it("ignores archived cards when choosing a column", () => {
    expect(
      defaultBoardStageId({
        stages: BOARD_SEED_STAGES,
        cards: [
          card({ stage: ids.building, archivedAt: "2026-01-01T00:00:00.000Z", stalled: true }),
          card({ stage: ids.sprint }),
        ],
      }),
    ).toBe(ids.sprint);
  });

  it("prefers a stage with a blocked card over an earlier occupied column", () => {
    expect(
      defaultBoardStageId({
        stages: BOARD_SEED_STAGES,
        cards: [card({ stage: ids.backlog }), card({ stage: ids.ready, blocked: true })],
      }),
    ).toBe(ids.ready);
  });

  it("prefers a stage whose card needs a human over the first non-empty stage", () => {
    const waiting = card({
      stage: ids.planning,
      awaitingInput: true,
      threadState: "waiting",
    });
    expect(boardCardAttention({ card: waiting, stages: BOARD_SEED_STAGES })).not.toBeNull();
    expect(
      defaultBoardStageId({
        stages: BOARD_SEED_STAGES,
        cards: [card({ stage: ids.backlog }), waiting],
      }),
    ).toBe(ids.planning);
  });

  it("falls back to the first non-empty stage when nothing is waiting", () => {
    expect(
      defaultBoardStageId({
        stages: BOARD_SEED_STAGES,
        cards: [card({ stage: ids.sprint }), card({ stage: ids.done })],
      }),
    ).toBe(ids.sprint);
  });

  it("treats a BoardCardShell as a valid input", () => {
    const shell = {
      stage: ids.building,
      stalled: true,
      held: false,
      awaitingInput: false,
      stepAwaiting: null,
      stepRunning: false,
      threadState: "none",
      queued: false,
      archivedAt: null,
      blocked: false,
    } satisfies DefaultBoardStageCard;
    expect(defaultBoardStageId({ stages: BOARD_SEED_STAGES, cards: [shell] })).toBe(ids.building);
    void (shell as Pick<BoardCardShell, "stage" | "blocked" | "archivedAt">);
  });
});
