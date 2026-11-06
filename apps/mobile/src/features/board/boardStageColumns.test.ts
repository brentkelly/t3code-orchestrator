import {
  BOARD_SEED_STAGE_IDS,
  BOARD_SEED_STAGES,
  boardCardShellPendingSplit,
  type BoardCardId,
  type BoardCardShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardPagerScrollIndex,
  cardsInStage,
  liveTopLevelBoardCards,
  liveTopLevelBoardCardsWithPlanProgress,
} from "./boardStageColumns";

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
      ["project-1" as BoardCardShell["projectId"]],
    );
    expect(live.map((card) => card.cardId)).toEqual(["a"]);
  });

  it("shows no cards when the Home scope matches nothing", () => {
    const live = liveTopLevelBoardCards(
      [shell({ cardId: "a" as BoardCardId, stage: ids.backlog })],
      [],
    );
    expect(live).toEqual([]);
  });
});

describe("liveTopLevelBoardCardsWithPlanProgress", () => {
  it("folds live children into the parent's plan pips and drops the children", () => {
    const parent = shell({
      cardId: "parent" as BoardCardId,
      stage: ids.planning,
      planCount: 2,
    });
    const live = liveTopLevelBoardCardsWithPlanProgress(
      [
        parent,
        shell({
          cardId: "child-a" as BoardCardId,
          stage: ids.building,
          parentCardId: parent.cardId,
        }),
        shell({
          cardId: "child-b" as BoardCardId,
          stage: ids.done,
          parentCardId: parent.cardId,
        }),
      ],
      null,
      BOARD_SEED_STAGES,
    );
    expect(live.map((card) => card.cardId)).toEqual(["parent"]);
    expect(live[0]?.planTotal).toBe(2);
    expect(live[0]?.planDone).toBe(1);
    expect(
      boardCardShellPendingSplit(
        {
          stage: live[0]!.stage,
          planCount: live[0]!.planCount,
          planTotal: live[0]!.planTotal,
        },
        BOARD_SEED_STAGES,
      ),
    ).toBe(false);
  });

  it("keeps Needs approval when two plans have no live children", () => {
    const live = liveTopLevelBoardCardsWithPlanProgress(
      [shell({ cardId: "parent" as BoardCardId, stage: ids.planning, planCount: 2 })],
      null,
      BOARD_SEED_STAGES,
    );
    expect(live[0]?.planTotal).toBeUndefined();
    expect(
      boardCardShellPendingSplit(
        { stage: live[0]!.stage, planCount: live[0]!.planCount },
        BOARD_SEED_STAGES,
      ),
    ).toBe(true);
  });
});

describe("boardPagerScrollIndex", () => {
  const stages = BOARD_SEED_STAGES.map((stage) => ({ stageId: stage.stageId }));

  it("waits until the board is mounted and the page has a width", () => {
    expect(
      boardPagerScrollIndex({
        boardReady: false,
        width: 390,
        resolvedStageId: ids.building,
        stages,
      }),
    ).toBeNull();
    expect(
      boardPagerScrollIndex({
        boardReady: true,
        width: 0,
        resolvedStageId: ids.building,
        stages,
      }),
    ).toBeNull();
  });

  it("returns the stage index once width is known", () => {
    expect(
      boardPagerScrollIndex({
        boardReady: true,
        width: 390,
        resolvedStageId: ids.building,
        stages,
      }),
    ).toBe(stages.findIndex((stage) => stage.stageId === ids.building));
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
