import { BOARD_SEED_STAGE_IDS, type BoardCardId, type BoardCardShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cardsInStage, liveTopLevelBoardCards } from "./boardStageColumns";

const ids = BOARD_SEED_STAGE_IDS;

function shell(
  overrides: Pick<BoardCardShell, "cardId" | "stage"> & Partial<BoardCardShell>,
): BoardCardShell {
  return {
    key: String(overrides.cardId),
    projectId: "project-1" as BoardCardShell["projectId"],
    labelIds: [],
    orderKey: "m",
    title: "Card",
    blocked: false,
    dependencyCount: 0,
    hasBrief: false,
    archivedAt: null,
    hasPr: false,
    attachmentCount: 0,
    queued: false,
    stalled: false,
    stepRunning: false,
    held: false,
    stepAwaiting: null,
    stepConflictFix: false,
    threadState: "none",
    awaitingInput: false,
    activeThreadId: null,
    ...overrides,
  };
}

describe("liveTopLevelBoardCards", () => {
  it("drops archived cards, children, and out-of-scope projects", () => {
    const live = liveTopLevelBoardCards(
      [
        shell({ cardId: "a" as BoardCardId, stage: ids.backlog }),
        shell({
          cardId: "b" as BoardCardId,
          stage: ids.backlog,
          archivedAt: "2026-01-01T00:00:00.000Z",
        }),
        shell({
          cardId: "c" as BoardCardId,
          stage: ids.backlog,
          parentCardId: "a" as BoardCardId,
        }),
        shell({
          cardId: "d" as BoardCardId,
          stage: ids.backlog,
          projectId: "other" as BoardCardShell["projectId"],
        }),
      ],
      "project-1" as BoardCardShell["projectId"],
    );
    expect(live.map((card) => card.cardId)).toEqual(["a"]);
  });
});

describe("cardsInStage", () => {
  it("sorts by orderKey", () => {
    const rows = cardsInStage(
      [
        shell({ cardId: "z" as BoardCardId, stage: ids.sprint, orderKey: "n" }),
        shell({ cardId: "a" as BoardCardId, stage: ids.sprint, orderKey: "b" }),
        shell({ cardId: "x" as BoardCardId, stage: ids.backlog, orderKey: "a" }),
      ],
      ids.sprint,
    );
    expect(rows.map((card) => card.cardId)).toEqual(["a", "z"]);
  });
});
