/**
 * The Automation section's decisions: the header's gate tags, Make hands-off, the source
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
  boardAutomationPastPlanning,
  boardAutomationSourceTag,
  boardAutomationStrip,
  boardCardAutoBuildChip,
  boardCardAutomationRows,
  boardCardPlanningFinishedFromDetail,
  boardGroupAutomationEffects,
  boardGroupAutomationRows,
  boardMakeHandsOffPatch,
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
    autoSignOff: false,
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

describe("the header's gate tags", () => {
  const strip = (card: BoardCardShell, shells: ReadonlyArray<BoardCardShell> = [card]) =>
    boardAutomationStrip({
      rows: boardCardAutomationRows({
        resolved: resolve(shells, card),
        inPlanning: card.stage === BOARD_SEED_STAGE_IDS.planning,
      }),
      pastPlanning: boardAutomationPastPlanning(STAGES, card.stage),
    });
  const read = (value: ReturnType<typeof strip>) =>
    value.tags.map((tag) => `${tag.gate} · ${tag.auto ? "auto" : "you"}`);

  it("shows Sign-off only while planning is automated", () => {
    const manual = strip(shell("c-1", "backlog"));
    expect(read(manual)).toEqual(["Plan · you", "Build · you", "Merge · you"]);
    expect(manual.handsOff).toBe(false);
    const auto = strip(shell("c-2", "backlog", { autoPlanSetting: true, autoBuildSetting: true }));
    expect(read(auto)).toEqual(["Plan · auto", "Sign-off · you", "Build · auto", "Merge · you"]);
  });

  it("is hands-off when every gate is automatic", () => {
    const all = shell("c-1", "planning", {
      autoPlanSetting: true,
      autoSignOffSetting: true,
      autoBuildSetting: true,
      autoMergeSetting: true,
    });
    expect(strip(all).handsOff).toBe(true);
    expect(strip({ ...all, autoSignOffSetting: false }).handsOff).toBe(false);
  });

  it("drops the settled Plan and Sign-off gates past Planning", () => {
    const ready = shell("c-1", "ready", { autoBuildSetting: true, autoMergeSetting: true });
    const value = strip(ready);
    expect(read(value)).toEqual(["Build · auto", "Merge · auto"]);
    expect(value.handsOff).toBe(true);
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
    expect(read(boardAutomationStrip({ rows, pastPlanning: false }))).toEqual([
      "Plan · you",
      "Build · you",
      "Merge · auto",
    ]);
  });

  it("gives a group with Auto-plan an indented sign-off row", () => {
    const g = shell("g-1", "planning", { group: group({ autoPlan: true, autoSignOff: true }) });
    const rows = boardGroupAutomationRows({
      vm: boardGroupSettingsVm([g], STAGES, g)!,
      groupKey: g.key,
      ownMerge: resolve([g], g).autoMerge,
    });
    expect(rows.find((r) => r.id === "autoSignOff")).toMatchObject({ on: true, indent: true });
  });
});

describe("Make hands-off", () => {
  const patch = (card: BoardCardShell, shells: ReadonlyArray<BoardCardShell> = [card]) =>
    boardMakeHandsOffPatch(resolve(shells, card));

  it("turns on every gate that is off in Planning", () => {
    expect(patch(shell("c-1", "planning"))).toEqual({
      autoPlan: true,
      autoSignOff: true,
      autoBuild: true,
      autoMerge: true,
    });
    expect(
      patch(shell("c-1", "planning", { autoPlanSetting: true, autoBuildSetting: true })),
    ).toEqual({ autoSignOff: true, autoMerge: true });
  });

  it("sends only the unlocked gates in Ready and Building", () => {
    expect(patch(shell("c-1", "ready"))).toEqual({ autoBuild: true, autoMerge: true });
    expect(patch(shell("c-1", "building"))).toEqual({ autoMerge: true });
  });

  it("is hidden once every applicable, unlocked gate is on", () => {
    expect(
      patch(shell("c-1", "building", { autoBuildSetting: true, autoMergeSetting: true })),
    ).toBeNull();
    // A board-wide merge is on and locked, so it is not sent.
    expect(
      boardMakeHandsOffPatch(resolve([shell("c-1", "building")], shell("c-1", "building"), true)),
    ).toBeNull();
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
    const plan = rows.find((r) => r.id === "autoPlan")!;
    expect(plan.locked).toBe(true);
    expect(plan.switchDisabled).toBe(true);
    expect(plan.note).toBe("Planning is finished.");
  });

  it("keeps Auto-plan switchable after planning finished in Planning, noting it", () => {
    const planning = shell("c-1", "planning");
    const plan = boardCardAutomationRows({
      resolved: resolve([planning], planning),
      inPlanning: true,
      planningFinished: true,
    })[0]!;
    expect(plan).toMatchObject({
      note: "Planning is finished.",
      locked: false,
      switchDisabled: false,
    });
  });

  it("tags an own value under a group as overriding it", () => {
    const g = shell("g-1", "planning", { group: group({ autoPlan: true }) });
    const ready = child("c-1", "backlog", { autoPlanSetting: false });
    const plan = boardCardAutomationRows({
      resolved: resolve([g, ready], ready),
      inPlanning: false,
    })[0]!;
    expect(plan).toMatchObject({ on: false, tag: "overrides G-1" });
  });

  it("keeps a locked own-off row under a started group off and disabled", () => {
    const g = shell("g-1", "building", { group: group({ autoBuild: true, started: true }) });
    const reviewing = child("c-1", "review", { autoBuildSetting: false });
    const build = boardCardAutomationRows({
      resolved: resolve([g, reviewing], reviewing),
      inPlanning: false,
    }).find((r) => r.id === "autoBuild")!;
    expect(build).toMatchObject({ on: false, locked: true, switchDisabled: true });
  });

  it("shows Auto sign-off, indented, only while Auto-plan is on", () => {
    const manual = shell("c-1", "backlog");
    expect(
      boardCardAutomationRows({ resolved: resolve([manual], manual), inPlanning: false }).map(
        (r) => r.id,
      ),
    ).toEqual(["autoPlan", "autoBuild", "autoMerge"]);
    const solo = shell("c-2", "backlog", { autoPlanSetting: true });
    const waits = boardCardAutomationRows({ resolved: resolve([solo], solo), inPlanning: false });
    expect(waits[1]).toMatchObject({
      id: "autoSignOff",
      on: false,
      indent: true,
      note: "Off: the agent's plan waits for you.",
    });
    const signed = shell("c-3", "backlog", { autoPlanSetting: true, autoSignOffSetting: true });
    const approves = boardCardAutomationRows({
      resolved: resolve([signed], signed),
      inPlanning: false,
    });
    expect(approves[1]).toMatchObject({ on: true, note: "Approve the agent's plan without you." });
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
    toggleName: "autoPlan" | "autoSignOff" | "autoBuild" | "autoMerge",
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

  it("starts ready children only once the group has started, and never approves a plan", () => {
    const shells = (started: boolean) => [
      shell("g-1", "building", { group: group({ started }) }),
      child("c-1", "planning", { autoPlanPending: true, planCount: 1 }),
      child("c-2", "ready"),
    ];
    expect(effects(shells(true), "autoBuild", true)).toEqual([
      "1 ready child will start building once its dependencies are done.",
    ]);
    expect(effects(shells(false), "autoBuild", true)).toEqual([]);
  });

  it("approves waiting single plans when sign-off turns on, never a split", () => {
    const shells = [
      shell("g-1", "planning", { group: group({ autoPlan: true }) }),
      child("c-1", "planning", { autoPlanPending: true, planCount: 1 }),
      child("c-2", "planning", { autoPlanPending: true, planCount: 2 }),
    ];
    expect(effects(shells, "autoSignOff", true)).toEqual(["1 waiting plan will be approved."]);
    expect(effects(shells, "autoSignOff", false)).toEqual([]);
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
