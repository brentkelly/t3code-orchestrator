/**
 * Board scope (t3o-25): the pure rules behind the sub-board drill-in — what
 * renders in each scope, which stages a sub-board shows, how collapse state
 * keys per scope, and where a dead sub-board URL resolves.
 */
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  type BoardCardShell,
  type BoardState,
} from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  boardScopeCollapseKey,
  boardScopeStages,
  filterBoardColumnsByScope,
  isBoardCardInScope,
  resolveSubBoardEntry,
  ROOT_BOARD_SCOPE,
  type BoardScope,
} from "./boardScope";

const parentId = BoardCardId.make("card-parent");
const otherParentId = BoardCardId.make("card-other-parent");
const SUB_SCOPE: BoardScope = { kind: "sub-board", parentCardId: parentId };

const STAGE_STATE: BoardState = {
  cards: [],
  stages: BOARD_SEED_STAGES,
  nextCardNumberByProject: {},
};

function shell(
  cardId: string,
  stage: string,
  parentCardId?: BoardCardId,
): Pick<BoardCardShell, "cardId" | "stage" | "orderKey" | "parentCardId"> {
  return {
    cardId: BoardCardId.make(cardId),
    stage,
    orderKey: "m",
    ...(parentCardId === undefined ? {} : { parentCardId }),
  } as Pick<BoardCardShell, "cardId" | "stage" | "orderKey" | "parentCardId">;
}

describe("isBoardCardInScope", () => {
  it("keeps top-level cards on the root board and children off it", () => {
    expect(isBoardCardInScope(shell("card-1", "backlog"), ROOT_BOARD_SCOPE)).toBe(true);
    expect(isBoardCardInScope(shell("card-2", "ready", parentId), ROOT_BOARD_SCOPE)).toBe(false);
  });

  it("keeps exactly one parent's children inside its sub-board", () => {
    expect(isBoardCardInScope(shell("card-2", "ready", parentId), SUB_SCOPE)).toBe(true);
    expect(isBoardCardInScope(shell("card-3", "ready", otherParentId), SUB_SCOPE)).toBe(false);
    // The parent itself is a header there, never a card (D2).
    expect(isBoardCardInScope(shell(String(parentId), "building"), SUB_SCOPE)).toBe(false);
  });
});

describe("filterBoardColumnsByScope", () => {
  const columns = {
    backlog: [shell("card-1", "backlog")],
    ready: [shell("card-2", "ready", parentId), shell("card-3", "ready", otherParentId)],
  } as unknown as BoardStageColumns;

  it("splits one column set into the two boards without losing a card", () => {
    const root = filterBoardColumnsByScope(columns, ROOT_BOARD_SCOPE);
    expect((root["backlog"] ?? []).map((card) => card.cardId)).toEqual(["card-1"]);
    expect(root["ready"] ?? []).toEqual([]);

    const sub = filterBoardColumnsByScope(columns, SUB_SCOPE);
    expect(sub["backlog"] ?? []).toEqual([]);
    expect((sub["ready"] ?? []).map((card) => card.cardId)).toEqual(["card-2"]);
  });
});

describe("boardScopeStages", () => {
  it("renders every stage on the root board", () => {
    expect(boardScopeStages(BOARD_SEED_STAGES, STAGE_STATE, ROOT_BOARD_SCOPE)).toEqual(
      BOARD_SEED_STAGES,
    );
  });

  it("renders the materialisation floor onward inside a sub-board", () => {
    const stages = boardScopeStages(BOARD_SEED_STAGES, STAGE_STATE, SUB_SCOPE);
    expect(stages.map((stage) => stage.stageId)).toEqual([
      "ready",
      "building",
      "review",
      "merge",
      "done",
    ]);
  });
});

describe("boardScopeCollapseKey", () => {
  it("keeps the root board's bare stage keys, so persisted collapse state survives", () => {
    expect(boardScopeCollapseKey(ROOT_BOARD_SCOPE, "backlog")).toBe("backlog");
  });

  it("namespaces sub-board keys per parent, so a collapsed root Backlog collapses nowhere else", () => {
    expect(boardScopeCollapseKey(SUB_SCOPE, "ready")).toBe(`sub/${parentId}/ready`);
    expect(
      boardScopeCollapseKey({ kind: "sub-board", parentCardId: otherParentId }, "ready"),
    ).not.toBe(boardScopeCollapseKey(SUB_SCOPE, "ready"));
  });
});

describe("resolveSubBoardEntry", () => {
  const cards = [
    shell(String(parentId), "building"),
    shell("card-2", "ready", parentId),
    shell("card-4", "done"),
  ];

  it("admits a parent with children", () => {
    expect(resolveSubBoardEntry(cards, parentId)).toEqual({ kind: "sub-board" });
  });

  it("resolves a childless card's URL up to the root board with its sheet open (D3)", () => {
    expect(resolveSubBoardEntry(cards, BoardCardId.make("card-4"))).toEqual({
      kind: "redirect-parent-sheet",
    });
  });

  it("resolves a URL naming no live card to the bare root board", () => {
    expect(resolveSubBoardEntry(cards, BoardCardId.make("card-missing"))).toEqual({
      kind: "redirect-root",
    });
  });
});
