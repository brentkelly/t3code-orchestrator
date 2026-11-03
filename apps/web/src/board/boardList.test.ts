/**
 * The List view's outline (T3O-30): tree order and scope, filter context,
 * indent and outdent eligibility, range selection, drop zones and the one
 * move path's guard rails.
 */
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardStageId,
  ProjectId,
  makeBoardCardShell,
  type BoardCardGroup,
  type BoardCardShell,
  type BoardState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardListDragBlocked,
  boardListDropRequest,
  boardListDropZone,
  boardListIndent,
  boardListMoveTargets,
  boardListOutdent,
  boardListRange,
  boardListRowWindow,
  boardListRows,
  boardListStageCounts,
  boardListVisibleSelection,
  buildBoardListTree,
  planBoardListMove,
} from "./boardList";

const STAGES: BoardState = { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };

function group(overrides: Partial<BoardCardGroup> = {}): BoardCardGroup {
  return {
    target: "inherit",
    autoBuild: false,
    autoMerge: false,
    autoPlan: false,
    started: false,
    placed: BoardStageId.make("backlog"),
    prevStage: BoardStageId.make("planning"),
    heading: false,
    integrated: false,
    ...overrides,
  };
}

function shell(
  id: string,
  stage: string,
  overrides: Partial<BoardCardShell> & { readonly parent?: string } = {},
): BoardCardShell {
  const { parent, ...rest } = overrides;
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make(id),
      key: id.toUpperCase(),
      projectId: ProjectId.make("p1"),
      labelIds: [],
      stage: BoardStageId.make(stage),
      orderKey: "m",
      title: `Card ${id}`,
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...(parent === undefined ? {} : { parentCardId: BoardCardId.make(parent) }),
    ...rest,
  };
}

const everything = () => true;
const NO_FILTER = { query: "", stages: new Set<string>() };

function treeOf(
  shells: ReadonlyArray<BoardCardShell>,
  inScope: (card: BoardCardShell) => boolean = everything,
) {
  return buildBoardListTree({ shells, stages: STAGES, inScope });
}

const ids = (rows: ReadonlyArray<{ readonly card: BoardCardShell }>) =>
  rows.map((row) => String(row.card.cardId));

describe("buildBoardListTree and boardListRows", () => {
  const shells = [
    shell("b", "sprint", { orderKey: "a" }),
    shell("a", "backlog", { orderKey: "z" }),
    shell("g", "backlog", { orderKey: "a", group: group() }),
    shell("g2", "backlog", { orderKey: "b", parent: "g", group: group() }),
    shell("c1", "deferred", { parent: "g" }),
    shell("c2", "building", { parent: "g" }),
    shell("c3", "backlog", { parent: "g2" }),
  ];

  it("orders siblings by stage, Deferred last, then column order, and nests", () => {
    const rows = boardListRows({ tree: treeOf(shells), collapsed: new Set(), filter: NO_FILTER });
    expect(ids(rows)).toEqual(["g", "g2", "c3", "c2", "c1", "a", "b"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 1, 0, 0]);
    expect(rows[0]).toMatchObject({ isGroup: true, expanded: true, childCount: 3 });
  });

  it("hides a collapsed group's children", () => {
    const rows = boardListRows({
      tree: treeOf(shells),
      collapsed: new Set(["g2"]),
      filter: NO_FILTER,
    });
    expect(ids(rows)).toEqual(["g", "g2", "c2", "c1", "a", "b"]);
    expect(rows[1]).toMatchObject({ expanded: false });
  });

  it("keeps a match's ancestors for context, dimmed, and expands them", () => {
    const rows = boardListRows({
      tree: treeOf(shells),
      collapsed: new Set(["g", "g2"]),
      filter: { query: "card c3", stages: new Set() },
    });
    expect(ids(rows)).toEqual(["g", "g2", "c3"]);
    expect(rows.map((row) => row.context)).toEqual([true, true, false]);
    expect(rows.every((row) => !row.isGroup || row.expanded)).toBe(true);
  });

  it("filters by stage, keeping ancestors of matching rows", () => {
    const rows = boardListRows({
      tree: treeOf(shells),
      collapsed: new Set(),
      filter: { query: "", stages: new Set(["building", "sprint"]) },
    });
    expect(ids(rows)).toEqual(["g", "c2", "b"]);
    expect(rows.map((row) => row.context)).toEqual([true, false, false]);
  });

  it("shows another project's child under its group, and its group for context", () => {
    const mixed = [
      shell("g", "backlog", { group: group() }),
      shell("x", "backlog", { parent: "g", projectId: ProjectId.make("p2") }),
      shell("y", "backlog", { parent: "g" }),
      shell("solo", "backlog"),
    ];
    const inP2 = (card: BoardCardShell) => card.projectId === "p2";
    const rows = boardListRows({
      tree: treeOf(mixed, inP2),
      collapsed: new Set(),
      filter: NO_FILTER,
    });
    expect(ids(rows)).toEqual(["g", "x", "y"]);
    expect(rows.map((row) => row.context)).toEqual([true, false, true]);
    const inP1 = (card: BoardCardShell) => card.projectId === "p1";
    expect(
      ids(boardListRows({ tree: treeOf(mixed, inP1), collapsed: new Set(), filter: NO_FILTER })),
    ).toEqual(["g", "x", "y", "solo"]);
    expect(boardListStageCounts(treeOf(mixed, inP1)).get("backlog")).toBe(3);
  });
});

describe("boardListIndent and boardListOutdent", () => {
  const shells = [
    shell("a", "backlog", { orderKey: "a" }),
    shell("b", "backlog", { orderKey: "b" }),
    shell("c", "backlog", { orderKey: "c" }),
    shell("g", "backlog", { orderKey: "d", group: group() }),
    shell("k1", "backlog", { parent: "g", orderKey: "a" }),
    shell("k2", "backlog", { parent: "g", orderKey: "b" }),
  ];
  const tree = treeOf(shells);

  it("asks for a selection first", () => {
    expect(boardListIndent(tree, new Set())).toEqual({
      kind: "refused",
      reason: "Select cards first",
    });
    expect(boardListOutdent(tree, new Set())).toEqual({
      kind: "refused",
      reason: "Select cards first",
    });
  });

  it("indents under the previous unselected sibling", () => {
    expect(boardListIndent(tree, new Set(["c", "b"]))).toEqual({
      kind: "ok",
      request: { ids: ["b", "c"], parentId: "a" },
      label: "Indent under A · Card a",
    });
  });

  it("refuses to indent the first sibling", () => {
    expect(boardListIndent(tree, new Set(["a"]))).toEqual({
      kind: "refused",
      reason: "Nothing above to indent under",
    });
    expect(boardListIndent(tree, new Set(["k1"]))).toMatchObject({ kind: "refused" });
  });

  it("with a filter on, skips siblings the filter hides", () => {
    expect(boardListIndent(tree, new Set(["c"]), new Set(["a", "c"]))).toEqual({
      kind: "ok",
      request: { ids: ["c"], parentId: "a" },
      label: "Indent under A · Card a",
    });
    expect(boardListIndent(tree, new Set(["c"]), new Set(["c"]))).toEqual({
      kind: "refused",
      reason: "Nothing above to indent under",
    });
  });

  it("refuses cards that don't share a parent", () => {
    const reason = "Select cards that share a parent";
    expect(boardListIndent(tree, new Set(["b", "k2"]))).toEqual({ kind: "refused", reason });
    expect(boardListOutdent(tree, new Set(["k1", "b"]))).toEqual({ kind: "refused", reason });
  });

  it("outdents to directly after the parent, one level up", () => {
    expect(boardListOutdent(tree, new Set(["k2"]))).toEqual({
      kind: "ok",
      request: { ids: ["k2"], parentId: null, afterId: "g" },
      label: "Move out of G",
    });
    expect(boardListOutdent(tree, new Set(["a"]))).toEqual({
      kind: "refused",
      reason: "Already at the top level",
    });
  });
});

describe("selection and drag helpers", () => {
  it("selects the visible range between the anchor and the click, either way", () => {
    const visible = ["a", "b", "c", "d"];
    expect(boardListRange(visible, "b", "d")).toEqual(["b", "c", "d"]);
    expect(boardListRange(visible, "d", "a")).toEqual(["a", "b", "c", "d"]);
    expect(boardListRange(visible, null, "c")).toEqual(["c"]);
    expect(boardListRange(visible, "gone", "c")).toEqual(["c"]);
  });

  it("splits a row into before, into and after at 28%", () => {
    expect(boardListDropZone(0, 35)).toBe("before");
    expect(boardListDropZone(9.7, 35)).toBe("before");
    expect(boardListDropZone(10, 35)).toBe("into");
    expect(boardListDropZone(25, 35)).toBe("into");
    expect(boardListDropZone(25.5, 35)).toBe("after");
    expect(boardListDropZone(35, 35)).toBe("after");
  });

  it("maps a drop to a move request", () => {
    const target = shell("t", "backlog", { parent: "g" });
    expect(boardListDropRequest(["x"], target, "into")).toEqual({ ids: ["x"], parentId: "t" });
    expect(boardListDropRequest(["x"], target, "before")).toEqual({
      ids: ["x"],
      parentId: "g",
      beforeId: "t",
    });
    expect(boardListDropRequest(["x"], target, "after")).toEqual({
      ids: ["x"],
      parentId: "g",
      afterId: "t",
    });
  });

  it("blocks the dragged cards and their subtrees, and hides them from Move to", () => {
    const shells = [
      shell("g", "backlog", { group: group() }),
      shell("k", "backlog", { parent: "g" }),
      shell("o", "backlog"),
    ];
    expect([...boardListDragBlocked(shells, ["g"])].toSorted()).toEqual(["g", "k"]);
    const targets = boardListMoveTargets(treeOf(shells), new Set(["g"]));
    expect(targets.map((target) => target.card?.key ?? "Top level")).toEqual(["Top level", "O"]);
  });
});

describe("planBoardListMove", () => {
  const plan = (
    shells: ReadonlyArray<BoardCardShell>,
    request: Parameters<typeof planBoardListMove>[0]["request"],
  ) => planBoardListMove({ shells, stages: STAGES, request });

  it("refuses moving a card inside itself", () => {
    const shells = [
      shell("g", "backlog", { group: group() }),
      shell("k", "backlog", { parent: "g" }),
    ];
    expect(plan(shells, { ids: ["g"], parentId: "k" })).toEqual({
      kind: "refused",
      reason: "A card can't move inside itself.",
    });
  });

  it("opens the started-card dialog for a started leaf destination", () => {
    const shells = [shell("s", "building"), shell("x", "backlog")];
    const result = plan(shells, { ids: ["x"], parentId: "s" });
    expect(result).toMatchObject({ kind: "started" });
    if (result.kind !== "started") return;
    expect(result.started.key).toBe("S");
    expect(result.moving.map((card) => card.key)).toEqual(["X"]);
  });

  it("refuses retargeting a started card, naming the target to rebase onto", () => {
    const shells = [
      shell("own", "building", { group: group({ target: "own" }) }),
      shell("s", "building"),
    ];
    expect(plan(shells, { ids: ["s"], parentId: "own" })).toEqual({
      kind: "refused",
      reason:
        "Can't move S into OWN. It's built on trunk, and OWN's children merge into board/own. Rebase onto board/own first.",
    });
  });

  it("lets a started descendant under an own-branch group keep its target", () => {
    const shells = [
      shell("outer", "backlog", { group: group() }),
      shell("own", "building", { group: group({ target: "own" }) }),
      shell("s", "building", { parent: "own" }),
    ];
    expect(plan(shells, { ids: ["own"], parentId: "outer" })).toMatchObject({ kind: "move" });
  });

  it("refuses a foreign project under an integration branch", () => {
    const shells = [
      shell("own", "backlog", { group: group({ target: "own" }) }),
      shell("x", "backlog", { projectId: ProjectId.make("p2") }),
    ];
    expect(plan(shells, { ids: ["x"], parentId: "own" })).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("it's in another project"),
    });
  });

  it("refuses a card before the floor under an own-branch group, as the decider does", () => {
    const shells = [
      shell("own", "ready", { group: group({ target: "own" }) }),
      shell("x", "backlog"),
      shell("r", "ready"),
      shell("d", "deferred", { parent: "own" }),
    ];
    expect(plan(shells, { ids: ["x"], parentId: "own" })).toEqual({
      kind: "refused",
      reason:
        "OWN has its own integration branch, so its cards live from Ready onward. Move X to Ready first.",
    });
    expect(plan(shells, { ids: ["r"], parentId: "own" })).toMatchObject({ kind: "move" });
  });

  it("builds the command, anchors next to a sibling and names emptied groups", () => {
    const shells = [
      shell("g", "backlog", { group: group({ prevStage: BoardStageId.make("building") }) }),
      shell("k", "backlog", { parent: "g" }),
      shell("h", "backlog", { group: group({ heading: true }) }),
      shell("j", "backlog", { parent: "h" }),
      shell("top", "backlog"),
    ];
    const outdent = plan(shells, { ids: ["k"], parentId: null, afterId: "g" });
    expect(outdent).toEqual({
      kind: "move",
      input: {
        cardId: BoardCardId.make("k"),
        cardIds: [BoardCardId.make("k")],
        parentCardId: null,
        afterCardId: BoardCardId.make("g"),
      },
      reverting: [{ card: shells[0], stageId: BoardStageId.make("sprint") }],
    });
    // A heading stays a group with no children.
    expect(plan(shells, { ids: ["j"], parentId: null, beforeId: "top" })).toMatchObject({
      kind: "move",
      input: { beforeCardId: BoardCardId.make("top") },
      reverting: [],
    });
    // An anchor under another parent is dropped rather than refused by the server.
    expect(plan(shells, { ids: ["top"], parentId: "h", afterId: "g" })).toEqual({
      kind: "move",
      input: {
        cardId: BoardCardId.make("top"),
        cardIds: [BoardCardId.make("top")],
        parentCardId: BoardCardId.make("h"),
      },
      reverting: [],
    });
  });
});

describe("boardListVisibleSelection", () => {
  it("drops selected ids that are no longer shown, and keeps the set when all are", () => {
    const selected = new Set(["a", "b"]);
    expect([...boardListVisibleSelection(selected, ["a", "c"])]).toEqual(["a"]);
    expect(boardListVisibleSelection(selected, ["b", "a"])).toBe(selected);
  });
});

describe("boardListRowWindow", () => {
  const base = { viewportHeight: 350, rowHeight: 35, overscan: 2 };

  it("starts at the top with the viewport plus overscan", () => {
    expect(boardListRowWindow({ ...base, scrollTop: 0, rowCount: 200 })).toEqual({
      start: 0,
      end: 12,
    });
  });

  it("reaches the last row at the bottom", () => {
    const scrollTop = 200 * 35 - 350;
    expect(boardListRowWindow({ ...base, scrollTop, rowCount: 200 })).toEqual({
      start: 188,
      end: 200,
    });
  });

  it("shows the last rows when the list shrinks under a stale scroll position", () => {
    expect(boardListRowWindow({ ...base, scrollTop: 190 * 35, rowCount: 30 })).toEqual({
      start: 18,
      end: 30,
    });
  });

  it("renders every row when they fit the viewport", () => {
    expect(boardListRowWindow({ ...base, scrollTop: 500, rowCount: 5 })).toEqual({
      start: 0,
      end: 5,
    });
  });
});
