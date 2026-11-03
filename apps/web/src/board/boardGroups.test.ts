/**
 * Groups on the board (T3O-29): the card face's counts, the drag rules a
 * refused column explains, the start confirmation and the settings notes.
 */
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardStageId,
  ProjectId,
  makeBoardCardShell,
  type BoardCardAttention,
  type BoardCardGroup,
  type BoardCardShell,
  type BoardState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardLandsOnLabel,
  boardDropRefusal,
  boardGroupCardVm,
  boardGroupNote,
  boardGroupSettingsVm,
  boardGroupStartPlan,
  boardGroupTargetLabel,
  isBoardTypedKeyConfirmed,
} from "./boardGroups";

const STAGES: BoardState = { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };

function group(overrides: Partial<BoardCardGroup> = {}): BoardCardGroup {
  return {
    target: "inherit",
    autoBuild: false,
    autoMerge: false,
    autoPlan: false,
    started: false,
    placed: BoardStageId.make("planning"),
    prevStage: BoardStageId.make("planning"),
    heading: false,
    integrated: false,
    ...overrides,
  };
}

function shell(id: string, stage: string, overrides: Partial<BoardCardShell> = {}): BoardCardShell {
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make(id),
      key: id.toUpperCase(),
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BoardStageId.make(stage),
      orderKey: "m",
      title: `Card ${id}`,
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...overrides,
  };
}

const child = (
  id: string,
  stage: string,
  parent: string,
  overrides: Partial<BoardCardShell> = {},
) => shell(id, stage, { parentCardId: BoardCardId.make(parent), ...overrides });

const noAttention = () => null;

describe("boardGroupCardVm", () => {
  const g = shell("g-1", "building", { group: group({ autoBuild: true, started: true }) });
  const waiting = child("c-1", "building", "g-1");
  const shells = [
    g,
    child("c-0", "done", "g-1"),
    waiting,
    child("c-2", "ready", "g-1", { blocked: true }),
    child("c-3", "building", "g-1"),
    child("c-4", "deferred", "g-1"),
    child("c-5", "deferred", "g-1"),
  ];
  const attentionFor = (card: BoardCardShell): BoardCardAttention | null =>
    card.cardId === waiting.cardId
      ? ({
          reason: "input",
          tone: "attention",
          label: "Input needed",
          detail: "",
        } as BoardCardAttention)
      : null;
  const vm = boardGroupCardVm({ shells, stages: STAGES, attentionFor }, g)!;

  it("draws one pip per active child, deferred ones excluded", () => {
    expect(vm.pips.map((pip) => pip.state)).toEqual(["done", "waiting", "blocked", "running"]);
    expect(vm.pips[1]!.tooltip).toBe("C-1 · Card c-1 — needs you");
  });

  it("counts done, who needs you and what is blocked", () => {
    expect(vm.doneLabel).toBe("1/4");
    expect(vm.needs).toBe("1 needs you");
    expect(vm.blocked).toBe("1 blocked");
  });

  it("says what is deferred and the auto-build state, and the branch only when own", () => {
    expect(vm.meta).toBe("+2 deferred · auto-build on");
    const own = shell("g-2", "planning", { group: group({ target: "own", autoBuild: true }) });
    const ownVm = boardGroupCardVm(
      { shells: [own, child("c-9", "ready", "g-2")], stages: STAGES, attentionFor: noAttention },
      own,
    )!;
    expect(ownVm.meta).toBe("→ board/g-2 · auto-build armed");
  });

  it("is never complete while deferred children are left", () => {
    const done = shell("g-3", "done", { group: group() });
    const finished = [done, child("c-6", "done", "g-3")];
    const stats = (cards: ReadonlyArray<BoardCardShell>) =>
      boardGroupCardVm({ shells: cards, stages: STAGES, attentionFor: noAttention }, done)!;
    expect(stats(finished).complete).toBe(true);
    expect(stats([...finished, child("c-7", "deferred", "g-3")]).complete).toBe(false);
  });

  it("rolls a nested group up to its worst child", () => {
    const outer = shell("o-1", "building", { group: group() });
    const inner = child("i-1", "building", "o-1", { group: group() });
    const shellsNested = [outer, inner, child("l-1", "ready", "i-1", { blocked: true })];
    const nested = boardGroupCardVm(
      { shells: shellsNested, stages: STAGES, attentionFor: noAttention },
      outer,
    )!;
    expect(nested.pips.map((pip) => pip.state)).toEqual(["blocked"]);
  });

  it("is null for a leaf", () => {
    expect(
      boardGroupCardVm({ shells, stages: STAGES, attentionFor: noAttention }, waiting),
    ).toBeNull();
  });
});

describe("boardDropRefusal", () => {
  const refusal = (shells: ReadonlyArray<BoardCardShell>, card: BoardCardShell, to: string) =>
    boardDropRefusal({ shells, stages: STAGES, card, toStage: BoardStageId.make(to) });

  it("lets a leaf go anywhere the decider decides on", () => {
    const leaf = shell("l-1", "backlog");
    for (const to of ["sprint", "building", "done"]) expect(refusal([leaf], leaf, to)).toBeNull();
  });

  it("moves a group's heading before Building, but refuses Ready", () => {
    const g = shell("g-1", "sprint", { group: group() });
    const shells = [g, child("c-1", "ready", "g-1")];
    expect(refusal(shells, g, "backlog")).toBeNull();
    expect(refusal(shells, g, "planning")).toBeNull();
    expect(refusal(shells, g, "ready")).toContain("Ready holds a single card's approved plan");
  });

  it("refuses the stages a group only reaches by derivation", () => {
    const own = shell("g-1", "planning", { group: group({ target: "own" }) });
    const inherit = shell("g-2", "planning", { group: group() });
    const shells = [own, inherit, child("c-1", "ready", "g-1"), child("c-2", "ready", "g-2")];
    expect(refusal(shells, own, "review")).toContain("integration review of board/g-1");
    expect(refusal(shells, inherit, "review")).toContain("merges straight into trunk");
    expect(refusal(shells, own, "merge")).toContain("never merges by hand");
    expect(refusal(shells, own, "done")).toContain("Done when all active children are done");
  });

  it("starts a group on Building only when there is something to start, unless auto-build is on", () => {
    const off = shell("g-1", "planning", { group: group() });
    const on = shell("g-2", "planning", { group: group({ autoBuild: true }) });
    const idle = [off, on, child("c-1", "planning", "g-1"), child("c-2", "planning", "g-2")];
    expect(refusal(idle, off, "building")).toBe("No children are ready to start. Plan them first.");
    expect(refusal(idle, on, "building")).toBeNull();
    // A blocked ready child is not startable either.
    const blocked = [off, child("c-3", "ready", "g-1", { blocked: true })];
    expect(refusal(blocked, off, "building")).not.toBeNull();
    expect(refusal([off, child("c-4", "ready", "g-1")], off, "building")).toBeNull();
  });

  it("refuses dragging a live group backwards and says how to pause", () => {
    const live = shell("g-1", "building", { group: group({ started: true, autoBuild: true }) });
    const shells = [live, child("c-1", "building", "g-1")];
    expect(refusal(shells, live, "planning")).toContain("turn off auto-build");
  });

  it("keeps started work out of Deferred, a group's started children included", () => {
    const started = child("c-1", "building", "g-1");
    const g = shell("g-1", "building", { group: group() });
    expect(refusal([g, started], started, "deferred")).toContain("Work has started on C-1");
    const inner = child("i-1", "planning", "g-1", { group: group() });
    const deep = child("d-1", "review", "i-1");
    expect(refusal([g, inner, deep], inner, "deferred")).toContain("D-1 inside I-1");
    expect(
      refusal([g, child("c-2", "ready", "g-1")], child("c-2", "ready", "g-1"), "deferred"),
    ).toBeNull();
  });

  it("keeps an own-branch group's cards from Ready onward", () => {
    const own = shell("g-1", "building", { group: group({ target: "own" }) });
    const card = child("c-1", "ready", "g-1");
    expect(refusal([own, card], card, "planning")).toContain("live from Ready onward");
    expect(refusal([own, card], card, "deferred")).toBeNull();
  });
});

describe("boardGroupStartPlan", () => {
  it("arms auto-build even with nothing ready", () => {
    const g = shell("g-1", "planning", { group: group({ autoBuild: true }) });
    const plan = boardGroupStartPlan([g, child("c-1", "planning", "g-1")], STAGES, g);
    expect(plan).toMatchObject({ autoBuild: true, title: "Start auto-build?" });
    expect(plan.ready).toHaveLength(0);
  });

  it("starts only the ready, unblocked children as a one-off", () => {
    const g = shell("g-1", "planning", { group: group() });
    const shells = [
      g,
      child("c-1", "ready", "g-1"),
      child("c-2", "ready", "g-1", { blocked: true }),
      child("c-3", "ready", "g-1"),
    ];
    const plan = boardGroupStartPlan(shells, STAGES, g);
    expect(plan.ready.map((card) => card.key)).toEqual(["C-1", "C-3"]);
    expect(plan.title).toBe("Start the 2 ready, unblocked children?");
    expect(plan.confirmLabel).toBe("Start 2");
  });
});

describe("targets and settings", () => {
  const outer = shell("o-1", "building", { group: group({ target: "own" }) });
  const middle = child("m-1", "building", "o-1", { group: group() });
  const leaf = child("l-1", "building", "m-1");
  const shells = [outer, middle, leaf];

  it("resolves an inherit group through to the nearest own branch, else trunk", () => {
    expect(boardGroupTargetLabel(shells, middle)).toBe("board/o-1");
    expect(boardCardLandsOnLabel(shells, leaf)).toBe("board/o-1");
    expect(boardCardLandsOnLabel(shells, outer)).toBe("trunk");
  });

  it("locks the merge target while a descendant has started", () => {
    const vm = boardGroupSettingsVm(shells, STAGES, outer)!;
    expect(vm.targetLockReason).toContain("L-1");
    const idle = [outer, child("l-2", "ready", "o-1")];
    expect(boardGroupSettingsVm(idle, STAGES, outer)!.targetLockReason).toBeNull();
  });

  it("enables auto-merge to trunk only when the children merge into trunk", () => {
    expect(boardGroupSettingsVm(shells, STAGES, middle)!.autoMerge.disabled).toBe(true);
    const top = shell("t-1", "planning", { group: group({ autoMerge: true }) });
    const vm = boardGroupSettingsVm([top], STAGES, top)!;
    expect(vm.autoMerge).toMatchObject({ disabled: false, on: true });
  });

  it("changes the auto-build note between armed, on and off", () => {
    const note = (settings: Partial<BoardCardGroup>) => {
      const g = shell("g-9", "planning", { group: group(settings) });
      return boardGroupSettingsVm([g], STAGES, g)!.autoBuild.note;
    };
    expect(note({ autoBuild: true })).toContain("Armed");
    expect(note({ autoBuild: true, started: true })).toContain("on their own");
    expect(note({ autoBuild: false })).toContain("wait for you");
  });

  it("explains a group's stage in one line", () => {
    const input = { shells, stages: STAGES, attentionFor: noAttention };
    expect(boardGroupNote(input, middle)).toContain("Building while any child is underway");
    const placed = shell("p-1", "sprint", { group: group() });
    expect(boardGroupNote({ ...input, shells: [placed] }, placed)).toContain(
      "Stays where you put it",
    );
  });
});

describe("isBoardTypedKeyConfirmed", () => {
  it("matches the key exactly, ignoring outer space", () => {
    expect(isBoardTypedKeyConfirmed(" T3O-26 ", "T3O-26")).toBe(true);
    expect(isBoardTypedKeyConfirmed("t3o-26", "T3O-26")).toBe(false);
    expect(isBoardTypedKeyConfirmed("T3O-2", "T3O-26")).toBe(false);
    expect(isBoardTypedKeyConfirmed("", "T3O-26")).toBe(false);
  });
});
