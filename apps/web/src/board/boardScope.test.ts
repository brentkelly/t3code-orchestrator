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
  boardColumnCollapsed,
  boardScopeCollapseKey,
  boardScopeColumnCollapsedByDefault,
  boardScopeStages,
  filterBoardColumnsByScope,
  livePeekedColumns,
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
): Pick<BoardCardShell, "cardId" | "stage" | "orderKey" | "parentCardId" | "group"> {
  return {
    cardId: BoardCardId.make(cardId),
    stage,
    orderKey: "m",
    ...(parentCardId === undefined ? {} : { parentCardId }),
  } as Pick<BoardCardShell, "cardId" | "stage" | "orderKey" | "parentCardId" | "group">;
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
    expect(boardScopeStages(BOARD_SEED_STAGES, ROOT_BOARD_SCOPE)).toEqual(BOARD_SEED_STAGES);
  });

  it("renders Deferred and then every stage inside a group (T3O-29)", () => {
    const stages = boardScopeStages(BOARD_SEED_STAGES, SUB_SCOPE);
    expect(stages.map((stage) => stage.stageId)).toEqual([
      "deferred",
      ...BOARD_SEED_STAGES.map((stage) => stage.stageId),
    ]);
  });
});

describe("boardScopeColumnCollapsedByDefault", () => {
  const collapsed = (
    scope: BoardScope,
    stageId: string,
    renderedIndex: number,
    cardCount: number,
  ) =>
    boardScopeColumnCollapsedByDefault({
      scope,
      stageState: STAGE_STATE,
      stageId: stageId as BoardCardShell["stage"],
      renderedIndex,
      cardCount,
    });

  it("collapses only the root board's first column", () => {
    expect(collapsed(ROOT_BOARD_SCOPE, "backlog", 0, 3)).toBe(true);
    expect(collapsed(ROOT_BOARD_SCOPE, "sprint", 1, 0)).toBe(false);
  });

  it("collapses an empty Deferred column and empty columns before Ready in a group", () => {
    expect(collapsed(SUB_SCOPE, "deferred", 0, 0)).toBe(true);
    expect(collapsed(SUB_SCOPE, "backlog", 1, 0)).toBe(true);
    expect(collapsed(SUB_SCOPE, "planning", 3, 0)).toBe(true);
  });

  it("keeps Ready onward open, and any column holding cards", () => {
    expect(collapsed(SUB_SCOPE, "ready", 4, 0)).toBe(false);
    expect(collapsed(SUB_SCOPE, "done", 8, 0)).toBe(false);
    expect(collapsed(SUB_SCOPE, "deferred", 0, 2)).toBe(false);
    expect(collapsed(SUB_SCOPE, "backlog", 1, 1)).toBe(false);
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

  it("admits an empty heading, which is a group with no children yet", () => {
    const heading = {
      ...shell("card-heading", "backlog"),
      group: {
        target: "inherit",
        autoBuild: false,
        autoMerge: false,
        autoPlan: false,
        started: false,
        placed: "backlog",
        prevStage: "backlog",
        heading: true,
        integrated: false,
      },
    } as (typeof cards)[number];
    expect(resolveSubBoardEntry([...cards, heading], BoardCardId.make("card-heading"))).toEqual({
      kind: "sub-board",
    });
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

describe("boardColumnCollapsed (T3O-40)", () => {
  const resolve = (overrides: Partial<Parameters<typeof boardColumnCollapsed>[0]>) =>
    boardColumnCollapsed({
      autoCollapseEmpty: true,
      cardCount: 0,
      dragOverThisColumn: false,
      peeked: false,
      storedOrDefaultCollapsed: false,
      ...overrides,
    });

  it("leaves the stored-or-default value alone while the setting is off", () => {
    for (const storedOrDefaultCollapsed of [true, false]) {
      expect(resolve({ autoCollapseEmpty: false, cardCount: 0, storedOrDefaultCollapsed })).toEqual(
        { collapsed: storedOrDefaultCollapsed, autoFolded: false },
      );
    }
  });

  it("folds an empty column even when the store says expanded", () => {
    expect(resolve({ storedOrDefaultCollapsed: false })).toEqual({
      collapsed: true,
      autoFolded: true,
    });
  });

  it("keeps a manually collapsed column collapsed once it holds cards", () => {
    expect(resolve({ cardCount: 2, storedOrDefaultCollapsed: true })).toEqual({
      collapsed: true,
      autoFolded: false,
    });
  });

  it("opens a column that holds cards and has no stored choice", () => {
    expect(resolve({ cardCount: 1, storedOrDefaultCollapsed: false })).toEqual({
      collapsed: false,
      autoFolded: false,
    });
  });

  it("opens an auto-folded column while it is peeked or dragged over", () => {
    expect(resolve({ peeked: true })).toEqual({ collapsed: false, autoFolded: true });
    expect(resolve({ dragOverThisColumn: true })).toEqual({ collapsed: false, autoFolded: true });
  });

  it("ignores a peek or drag on a column that holds cards", () => {
    expect(
      resolve({
        cardCount: 1,
        peeked: true,
        dragOverThisColumn: true,
        storedOrDefaultCollapsed: true,
      }),
    ).toEqual({ collapsed: true, autoFolded: false });
  });
});

describe("livePeekedColumns (T3O-40)", () => {
  it("keeps the same set while every peek is still on an empty column", () => {
    const peeked = new Set(["sprint"]);
    expect(
      livePeekedColumns({ autoCollapseEmpty: true, peeked, emptyColumnKeys: ["sprint", "done"] }),
    ).toBe(peeked);
  });

  it("ends a peek once its column holds cards", () => {
    const peeked = new Set(["sprint", "done"]);
    expect([
      ...livePeekedColumns({ autoCollapseEmpty: true, peeked, emptyColumnKeys: ["done"] }),
    ]).toEqual(["done"]);
  });

  it("drops peeks outside the current scope and every peek while the setting is off", () => {
    const peeked = new Set(["sprint", "sub/card-parent/sprint"]);
    expect([
      ...livePeekedColumns({ autoCollapseEmpty: true, peeked, emptyColumnKeys: ["sprint"] }),
    ]).toEqual(["sprint"]);
    expect(
      livePeekedColumns({ autoCollapseEmpty: false, peeked, emptyColumnKeys: ["sprint"] }).size,
    ).toBe(0);
  });
});
