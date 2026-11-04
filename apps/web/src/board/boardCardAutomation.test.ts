/**
 * The Automation section's decisions (T3O-38): the header summary, the source
 * tag, what a locked row shows, and what a group flip does to its children.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  ProjectId,
  makeBoardCardShell,
  type BoardCardGroup,
  type BoardCardShell,
  type BoardResolvedAutomationToggle,
  type BoardState,
  type BoardStepCompletion,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardAutomationRowsSummary,
  boardAutomationSourceTag,
  boardAutomationSummary,
  boardCardAutoBuildChip,
  boardCardAutomationRows,
  boardCardPlanningFinishedFromDetail,
  boardGroupAutomationEffects,
  boardGroupAutomationRows,
  boardShellAutomationNode,
  resolveBoardShellAutomation,
} from "./boardCardAutomation";
import { boardGroupSettingsVm } from "./boardGroups";

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

const child = (id: string, stage: string, overrides: Partial<BoardCardShell> = {}) =>
  shell(id, stage, { parentCardId: BoardCardId.make("g-1"), ...overrides });

function resolve(shells: ReadonlyArray<BoardCardShell>, card: BoardCardShell, boardWide = false) {
  return resolveBoardShellAutomation({
    shells,
    stages: STAGES,
    card: boardShellAutomationNode(card),
    boardWideAutoMerge: boardWide,
  });
}

function toggle(overrides: Partial<BoardResolvedAutomationToggle>): BoardResolvedAutomationToggle {
  return {
    value: false,
    own: null,
    source: null,
    inheritedFrom: { id: "g-1", key: "T3O-9" },
    waitingForGroupStart: false,
    locked: false,
    lockReason: null,
    ...overrides,
  };
}

describe("the header summary", () => {
  it("names the toggles that are on in pipeline order, or says Off", () => {
    expect(boardAutomationSummary(["autoMerge", "autoPlan"])).toBe("Plan · Merge");
    expect(boardAutomationSummary(["autoPlan", "autoBuild", "autoMerge"])).toBe(
      "Plan · Build · Merge",
    );
    expect(boardAutomationSummary([])).toBe("Off");
  });

  it("reads a group's two merges as one Merge", () => {
    const g = shell("g-1", "planning", {
      group: group({ target: "own", autoMerge: true }),
      autoMergeSetting: true,
    });
    const vm = boardGroupSettingsVm([g], STAGES, g)!;
    const rows = boardGroupAutomationRows({
      vm,
      groupKey: g.key,
      ownMerge: resolve([g], g).autoMerge,
    });
    expect(rows.map((r) => r.id)).toEqual(["autoPlan", "autoBuild", "autoMerge", "ownMerge"]);
    expect(rows[3]!.label).toBe("Auto-merge board/g-1 into trunk");
    expect(boardAutomationRowsSummary(rows)).toBe("Merge");
  });
});

describe("the source tag", () => {
  it("names the group an inherited on comes from, and stays quiet for an inherited off", () => {
    expect(boardAutomationSourceTag(toggle({ value: true, source: "inherited" }))).toBe(
      "from T3O-9",
    );
    expect(boardAutomationSourceTag(toggle({ value: false, source: "inherited" }))).toBeNull();
  });

  it("says an own value overrides the group, and nothing on a top-level card", () => {
    expect(boardAutomationSourceTag(toggle({ value: false, own: false, source: "own" }))).toBe(
      "overrides T3O-9",
    );
    expect(
      boardAutomationSourceTag(
        toggle({ own: true, value: true, source: "own", inheritedFrom: null }),
      ),
    ).toBeNull();
  });

  it("says when an inherited Auto-build waits for the group to start", () => {
    expect(
      boardAutomationSourceTag(toggle({ source: "inherited", waitingForGroupStart: true })),
    ).toBe("from T3O-9 · when group starts");
  });

  it("names the board for the board-wide merge", () => {
    expect(boardAutomationSourceTag(toggle({ value: true, source: "board" }))).toBe("board");
  });
});

describe("a leaf's rows", () => {
  it("shows a locked row's reason in place of its note, and still lets an on row turn off", () => {
    const g = shell("g-1", "building", { group: group({ autoBuild: true, started: true }) });
    const building = child("c-1", "building", { autoBuildSetting: true });
    const rows = boardCardAutomationRows({
      resolved: resolve([g, building], building),
      inPlanning: false,
    });
    const build = rows.find((r) => r.id === "autoBuild")!;
    expect(build.locked).toBe(true);
    expect(build.note).toBe("Building now.");
    // Locks refuse only turning on: an on row can go off or back to the group.
    expect(build.switchDisabled).toBe(false);
    expect(build.canInherit).toBe(true);
    const plan = rows.find((r) => r.id === "autoPlan")!;
    expect(plan.locked).toBe(true);
    expect(plan.switchDisabled).toBe(true);
    expect(plan.note).toBe("Planning is finished.");
  });

  it("offers the group's setting back to an own value under a group", () => {
    const g = shell("g-1", "planning", { group: group({ autoPlan: true }) });
    const ready = child("c-1", "backlog", { autoPlanSetting: false });
    const plan = boardCardAutomationRows({
      resolved: resolve([g, ready], ready),
      inPlanning: false,
    })[0]!;
    expect(plan).toMatchObject({ on: false, tag: "overrides G-1", canInherit: true });
  });

  it("says an unattended plan waits for approval unless Auto-build is on too", () => {
    const solo = shell("c-1", "backlog", { autoPlanSetting: true });
    const waits = boardCardAutomationRows({ resolved: resolve([solo], solo), inPlanning: false });
    expect(waits[0]!.note).toContain("waits for your approval");
    const both = shell("c-2", "backlog", { autoPlanSetting: true, autoBuildSetting: true });
    const builds = boardCardAutomationRows({ resolved: resolve([both], both), inPlanning: false });
    expect(builds[0]!.note).toContain("approved and built");
  });

  it("locks Auto-merge on, from the board, under the board-wide setting", () => {
    const card = shell("c-1", "building");
    const merge = boardCardAutomationRows({
      resolved: resolve([card], card, true),
      inPlanning: false,
    })[2]!;
    expect(merge).toMatchObject({
      on: true,
      locked: true,
      switchDisabled: true,
      tag: "board",
      canInherit: false,
    });
    expect(merge.note).toContain("Settings");
  });
});

describe("planning finished, from the detail", () => {
  const completion = (outcome: "succeeded" | "failed", completedAt: string): BoardStepCompletion =>
    ({
      cardId: BoardCardId.make("c-1"),
      stepId: BOARD_SEED_STAGE_IDS.planning,
      outcome,
      summary: "done",
      payload: null,
      threadId: null,
      completedAt,
    }) as BoardStepCompletion;
  const finished = (completions: ReadonlyArray<BoardStepCompletion>, stepLive = false) =>
    boardCardPlanningFinishedFromDetail({
      stages: STAGES,
      stage: BOARD_SEED_STAGE_IDS.planning,
      stepCompletions: completions,
      stepLive,
    });

  it("reads the latest plan-stage completion while no step is live", () => {
    expect(finished([completion("succeeded", "2026-01-01T00:00:00.000Z")])).toBe(true);
    expect(
      finished([
        completion("succeeded", "2026-01-01T00:00:00.000Z"),
        completion("failed", "2026-01-02T00:00:00.000Z"),
      ]),
    ).toBe(false);
    expect(finished([])).toBe(false);
  });

  it("is not finished while a planning step is live again", () => {
    expect(finished([completion("succeeded", "2026-01-01T00:00:00.000Z")], true)).toBe(false);
  });
});

describe("what a group flip does to its children", () => {
  const effects = (
    shells: ReadonlyArray<BoardCardShell>,
    toggleName: "autoPlan" | "autoBuild" | "autoMerge",
    next: boolean,
    boardWide = false,
  ) =>
    boardGroupAutomationEffects({
      shells,
      stages: STAGES,
      group: shells[0]!,
      toggle: toggleName,
      next,
      boardWideAutoMerge: boardWide,
    });

  it("finishes inheriting children mid-planning unattended, and leaves own values alone", () => {
    const g = shell("g-1", "planning", { group: group() });
    const shells = [
      g,
      child("c-1", "planning", { stepRunning: true }),
      child("c-2", "planning", { stepAwaiting: "input" as never }),
      child("c-3", "planning", { stepRunning: true, autoPlanSetting: false }),
      child("c-4", "backlog"),
    ];
    expect(effects(shells, "autoPlan", true)).toEqual([
      "2 children being planned will finish unattended.",
    ]);
  });

  it("approves waiting plans and starts ready children only once the group has started", () => {
    const shells = (started: boolean) => [
      shell("g-1", "building", { group: group({ started }) }),
      child("c-1", "planning", { autoPlanPending: true }),
      child("c-2", "ready"),
    ];
    expect(effects(shells(true), "autoBuild", true)).toEqual([
      "1 waiting plan will be approved and built.",
      "1 ready child will start building once its dependencies are done.",
    ]);
    expect(effects(shells(false), "autoBuild", true)).toEqual([]);
  });

  it("says children in progress will no longer auto-merge", () => {
    const shells = [
      shell("g-1", "building", { group: group({ autoMerge: true }) }),
      child("c-1", "building"),
      child("c-2", "merge"),
      child("c-3", "done"),
    ];
    expect(effects(shells, "autoMerge", false)).toEqual([
      "2 children in progress will no longer auto-merge; they wait in Ready for merge for you.",
    ]);
    // The board-wide setting merges them anyway, so nothing changes.
    expect(effects(shells, "autoMerge", false, true)).toEqual([]);
  });

  it("needs no confirmation when nothing is in flight or nothing changes", () => {
    const g = shell("g-1", "planning", { group: group({ autoPlan: true }) });
    expect(effects([g, child("c-1", "backlog")], "autoPlan", false)).toEqual([]);
    expect(effects([g, child("c-1", "planning", { stepRunning: true })], "autoPlan", true)).toEqual(
      [],
    );
  });
});

describe("the card face's Auto-build chip", () => {
  it("shows on an armed card and yields to a schedule pill", () => {
    expect(boardCardAutoBuildChip({ armed: true, done: false, scheduled: false })?.label).toBe(
      "Auto-build",
    );
    expect(boardCardAutoBuildChip({ armed: true, done: false, scheduled: true })).toBeNull();
    expect(boardCardAutoBuildChip({ armed: false, done: false, scheduled: false })).toBeNull();
    expect(boardCardAutoBuildChip({ armed: true, done: true, scheduled: false })).toBeNull();
  });
});
