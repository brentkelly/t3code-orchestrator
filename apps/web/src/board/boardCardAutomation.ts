/**
 * The card detail's Automation section as pure decisions. Resolution is
 * `resolveBoardCardAutomation` from contracts, the same reading the server uses.
 */
import {
  BOARD_AUTOMATION_TOGGLE_LABELS,
  boardStageBeforeBuild,
  boardStageById,
  boardStageIndex,
  boardPlanAutomatedBy,
  boardStageWithRole,
  effectiveBoardStageRole,
  isBoardDeferredStage,
  resolveBoardCardAutomation,
  type BoardAutomationNode,
  type BoardAutomationToggle,
  type BoardCardShell,
  type BoardResolvedAutomation,
  type BoardResolvedAutomationToggle,
  type BoardStageId,
  type BoardState,
  type BoardStepCompletion,
} from "@t3tools/contracts";

import { boardGroupBranchName, boardShellChildren, type BoardGroupSettingsVm } from "./boardGroups";

type Shells = ReadonlyArray<BoardCardShell>;

const nodeIndexes = new WeakMap<Shells, ReadonlyMap<string, BoardAutomationNode>>();

/** A shell as the resolver reads it. Shells omit a null setting, so absent
    reads as inherit. */
export function boardShellAutomationNode(shell: BoardCardShell): BoardAutomationNode {
  return {
    id: String(shell.cardId),
    key: shell.key,
    parentCardId: shell.parentCardId ?? null,
    stage: String(shell.stage),
    autoPlanSetting: shell.autoPlanSetting ?? null,
    autoSignOffSetting: shell.autoSignOffSetting ?? null,
    autoBuildSetting: shell.autoBuildSetting ?? null,
    autoMergeSetting: shell.autoMergeSetting ?? null,
    group: shell.group ?? null,
  };
}

function nodesOf(shells: Shells): ReadonlyMap<string, BoardAutomationNode> {
  let index = nodeIndexes.get(shells);
  if (index === undefined) {
    index = new Map(shells.map((shell) => [String(shell.cardId), boardShellAutomationNode(shell)]));
    nodeIndexes.set(shells, index);
  }
  return index;
}

/** `resolveBoardCardAutomation` with the parent looked up in the shells. */
export function resolveBoardShellAutomation(input: {
  readonly shells: Shells;
  readonly stages: BoardState;
  readonly card: BoardAutomationNode;
  readonly boardWideAutoMerge: boolean;
}): BoardResolvedAutomation {
  const nodes = nodesOf(input.shells);
  return resolveBoardCardAutomation({
    stages: input.stages.stages ?? [],
    lookup: (id) => nodes.get(id),
    card: input.card,
    boardWideAutoMerge: input.boardWideAutoMerge,
  });
}

/**
 * Whether the card's planning run for this stay has finished, from what the
 * detail carries: it sits in the plan stage, no step is live, and its latest
 * plan-stage completion succeeded. The client's reading of
 * `boardCardPlanningFinished`, for the note under Auto-plan.
 */
export function boardCardPlanningFinishedFromDetail(input: {
  readonly stages: BoardState;
  readonly stage: BoardStageId;
  readonly stepCompletions: ReadonlyArray<BoardStepCompletion>;
  readonly stepLive: boolean;
}): boolean {
  const stage = boardStageById(input.stages, input.stage);
  if (stage === null || effectiveBoardStageRole(stage) !== "plan" || input.stepLive) return false;
  let latest: BoardStepCompletion | null = null;
  for (const completion of input.stepCompletions) {
    if (completion.stepId !== String(input.stage)) continue;
    if (latest === null || completion.completedAt > latest.completedAt) latest = completion;
  }
  return latest?.outcome === "succeeded";
}

/**
 * The tag beside a toggle's label: where its value comes from. Silent for a
 * plain own value on a top-level card and for an inherited off, which is the
 * default and says nothing worth reading.
 */
export function boardAutomationSourceTag(toggle: BoardResolvedAutomationToggle): string | null {
  if (toggle.source === "board") return "board";
  const key = toggle.inheritedFrom?.key ?? null;
  if (key === null) return null;
  if (toggle.waitingForGroupStart) return `from ${key} · when group starts`;
  if (toggle.source === "inherited") return toggle.value ? `from ${key}` : null;
  if (toggle.source === "own") return `overrides ${key}`;
  return null;
}

/** One switch row in the Automation section. */
export interface BoardAutomationRow {
  /** `ownMerge` is a group's own merge into where it lands; it dispatches the
      group card's own Auto-merge. */
  readonly id: BoardAutomationToggle | "ownMerge";
  readonly label: string;
  readonly on: boolean;
  /** The one-line note, or the lock reason when the row is locked. */
  readonly note: string;
  readonly tag: string | null;
  /** Turning it on would be refused. */
  readonly locked: boolean;
  /** The switch cannot be used: locked while off (only turning on is
      refused, so a locked row that is on can still be turned off), or held
      on by the board-wide setting. */
  readonly switchDisabled: boolean;
  readonly lockReason: string | null;
  /** Sits under the row before it: Auto sign-off belongs to automated planning. */
  readonly indent?: boolean;
}

function lockState(toggle: BoardResolvedAutomationToggle) {
  return {
    locked: toggle.locked,
    lockReason: toggle.lockReason,
    switchDisabled: toggle.locked && (!toggle.value || toggle.source === "board"),
  };
}

function row(
  id: BoardAutomationRow["id"],
  label: string,
  toggle: BoardResolvedAutomationToggle,
  note: string,
): BoardAutomationRow {
  return {
    id,
    label,
    on: toggle.value,
    note: toggle.locked && toggle.lockReason !== null ? toggle.lockReason : note,
    tag: boardAutomationSourceTag(toggle),
    ...lockState(toggle),
  };
}

/** A leaf card's rows: Auto sign-off only while planning is automated. */
export function boardCardAutomationRows(input: {
  readonly resolved: BoardResolvedAutomation;
  readonly inPlanning: boolean;
  /** The plan step succeeded in Planning; Auto-plan still switches on. */
  readonly planningFinished?: boolean;
}): ReadonlyArray<BoardAutomationRow> {
  const { autoPlan, autoSignOff, autoBuild, autoMerge } = input.resolved;
  const planNote =
    input.inPlanning && input.planningFinished === true
      ? "Planning is finished."
      : "The agent plans without asking you.";
  const signOffNote = autoSignOff.value
    ? "Approve the agent's plan without you."
    : "Off: the agent's plan waits for you.";
  const buildNote = autoBuild.waitingForGroupStart
    ? `Start once ${autoBuild.inheritedFrom?.key ?? "the group"} has started, the plan is signed off and dependencies are done.`
    : "Start once the plan is signed off and dependencies are done.";
  const mergeNote = autoMerge.value
    ? "Merge to the target once code review passes."
    : "Off: finished cards wait for you to merge.";
  return [
    row("autoPlan", BOARD_AUTOMATION_TOGGLE_LABELS.autoPlan, autoPlan, planNote),
    ...(boardPlanAutomatedBy(input.resolved) === null
      ? []
      : [
          {
            ...row(
              "autoSignOff",
              BOARD_AUTOMATION_TOGGLE_LABELS.autoSignOff,
              autoSignOff,
              signOffNote,
            ),
            indent: true,
          },
        ]),
    row("autoBuild", BOARD_AUTOMATION_TOGGLE_LABELS.autoBuild, autoBuild, buildNote),
    row("autoMerge", BOARD_AUTOMATION_TOGGLE_LABELS.autoMerge, autoMerge, mergeNote),
  ];
}

/**
 * Make hands-off: every gate that is off and unlocked, as one set-automation patch. Sign-off
 * comes only with automated planning. Null when there is nothing left to turn on, which hides
 * the button. The decider refuses the whole command if any toggle it turns on is locked.
 */
export function boardMakeHandsOffPatch(
  resolved: BoardResolvedAutomation,
): Partial<Record<BoardAutomationToggle, true>> | null {
  const turnOn = (toggle: BoardResolvedAutomationToggle) => !toggle.value && !toggle.locked;
  const planAutomated = resolved.autoPlan.value || turnOn(resolved.autoPlan);
  const patch: Partial<Record<BoardAutomationToggle, true>> = {
    ...(turnOn(resolved.autoPlan) ? { autoPlan: true } : {}),
    ...(planAutomated && turnOn(resolved.autoSignOff) ? { autoSignOff: true } : {}),
    ...(turnOn(resolved.autoBuild) ? { autoBuild: true } : {}),
    ...(turnOn(resolved.autoMerge) ? { autoMerge: true } : {}),
  };
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * A group card's rows: the group's settings for its children, then — for a
 * group with its own branch — the group's own merge, which is the group card's
 * own Auto-merge resolved like any card's.
 */
export function boardGroupAutomationRows(input: {
  readonly vm: BoardGroupSettingsVm;
  readonly groupKey: string;
  /** The group card's own resolved Auto-merge. */
  readonly ownMerge: BoardResolvedAutomationToggle;
}): ReadonlyArray<BoardAutomationRow> {
  const { vm } = input;
  const plain = (
    id: BoardAutomationToggle,
    label: string,
    setting: { readonly on: boolean; readonly note: string },
    lockReason: string | null = null,
  ): BoardAutomationRow => ({
    id,
    label,
    on: setting.on,
    note: lockReason ?? setting.note,
    tag: lockReason === null ? null : "board",
    locked: lockReason !== null,
    // Group rows lock only for the board-wide merge, which holds them on.
    switchDisabled: lockReason !== null,
    lockReason,
  });
  const rows: BoardAutomationRow[] = [
    plain("autoPlan", "Auto-plan", vm.autoPlan),
    ...(vm.autoPlan.on
      ? [{ ...plain("autoSignOff", "Auto sign-off", vm.autoSignOff), indent: true }]
      : []),
    plain("autoBuild", "Auto-build", vm.autoBuild),
    plain(
      "autoMerge",
      `Auto-merge children into ${vm.resolvedTarget}`,
      vm.autoMerge,
      vm.autoMerge.lockReason,
    ),
  ];
  if (vm.target === "own") {
    const branch = boardGroupBranchName({ key: input.groupKey });
    rows.push(
      row(
        "ownMerge",
        `Auto-merge ${branch} into ${vm.landsOn}`,
        input.ownMerge,
        input.ownMerge.value
          ? `Once the group's own review passes, ${branch} merges into ${vm.landsOn} on its own.`
          : "The group waits in Ready for merge until you click Merge.",
      ),
    );
  }
  return rows;
}

/** One tag in the collapsed Automation header: who passes that gate. */
export interface BoardAutomationGateTag {
  readonly gate: "Plan" | "Sign-off" | "Build" | "Merge";
  readonly auto: boolean;
}

export interface BoardAutomationStrip {
  readonly tags: ReadonlyArray<BoardAutomationGateTag>;
  /** Every gate that still applies is automatic. */
  readonly handsOff: boolean;
}

export const BOARD_AUTOMATION_HANDS_OFF_TOOLTIP =
  "Every gate is automatic. Proposed splits still need you.";

/**
 * The collapsed header's tag strip, one tag per gate that still applies: past Planning the Plan
 * and Sign-off gates are settled and drop out. Sign-off shows only beside automated planning,
 * which is when its row shows. A group's two merges read as one.
 */
export function boardAutomationStrip(input: {
  readonly rows: ReadonlyArray<BoardAutomationRow>;
  readonly pastPlanning: boolean;
}): BoardAutomationStrip {
  const on = (id: BoardAutomationRow["id"]) => input.rows.some((r) => r.id === id && r.on);
  const has = (id: BoardAutomationRow["id"]) => input.rows.some((r) => r.id === id);
  const tags: BoardAutomationGateTag[] = [
    ...(input.pastPlanning
      ? []
      : [
          { gate: "Plan" as const, auto: on("autoPlan") },
          ...(has("autoSignOff") ? [{ gate: "Sign-off" as const, auto: on("autoSignOff") }] : []),
        ]),
    { gate: "Build", auto: on("autoBuild") },
    { gate: "Merge", auto: on("autoMerge") || on("ownMerge") },
  ];
  return { tags, handsOff: tags.every((tag) => tag.auto) };
}

/** Whether the card sits past its Planning stage, where Plan and Sign-off are settled. */
export function boardAutomationPastPlanning(stages: BoardState, stage: string): boolean {
  const plan = boardStageWithRole(stages, "plan");
  if (plan === null) return false;
  const planIndex = boardStageIndex(stages, plan.stageId);
  const index = boardStageIndex(stages, stage as BoardStageId);
  return planIndex >= 0 && index > planIndex;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The confirmation lines for flipping one group setting: direct leaf children
 * mid-stage that inherit it (no own value). Empty means no confirmation needed.
 */
export function boardGroupAutomationEffects(input: {
  readonly shells: Shells;
  readonly stages: BoardState;
  readonly group: BoardCardShell;
  readonly toggle: BoardAutomationToggle;
  readonly next: boolean;
  readonly boardWideAutoMerge: boolean;
}): ReadonlyArray<string> {
  const settings = input.group.group;
  if (settings === undefined) return [];
  const current =
    input.toggle === "autoPlan"
      ? settings.autoPlan
      : input.toggle === "autoSignOff"
        ? settings.autoSignOff
        : input.toggle === "autoBuild"
          ? settings.autoBuild
          : settings.autoMerge;
  if (current === input.next) return [];
  if (input.toggle === "autoMerge" && input.boardWideAutoMerge) return [];

  const settingOf = (child: BoardCardShell) =>
    input.toggle === "autoPlan"
      ? child.autoPlanSetting
      : input.toggle === "autoSignOff"
        ? child.autoSignOffSetting
        : input.toggle === "autoBuild"
          ? child.autoBuildSetting
          : child.autoMergeSetting;
  const children = boardShellChildren(input.shells, String(input.group.cardId)).filter(
    (child) =>
      child.archivedAt === null &&
      child.group === undefined &&
      !isBoardDeferredStage(child.stage) &&
      boardShellChildren(input.shells, String(child.cardId)).length === 0 &&
      settingOf(child) === undefined,
  );
  const plan = boardStageWithRole(input.stages, "plan")?.stageId ?? null;
  const beforeBuild = boardStageBeforeBuild(input.stages)?.stageId ?? null;
  const build = boardStageWithRole(input.stages, "build")?.stageId ?? null;
  const merge = boardStageWithRole(input.stages, "merge");
  const live = (child: BoardCardShell) =>
    child.stepRunning || child.queued || child.stepAwaiting !== null;
  const at = (stage: string | null) => (child: BoardCardShell) =>
    stage !== null && child.stage === stage;
  const planning = children.filter(at(plan));
  const lines: string[] = [];

  if (input.toggle === "autoPlan") {
    if (input.next) {
      const n = planning.filter((child) => child.autoPlanPending !== true && live(child)).length;
      if (n > 0)
        lines.push(`${count(n, "child", "children")} being planned will finish unattended.`);
    } else {
      const n = planning.filter((child) => child.autoPlanPending === true && live(child)).length;
      if (n > 0) {
        lines.push(
          `${count(n, "child", "children")} planning unattended will go back to planning with you.`,
        );
      }
    }
    return lines;
  }

  if (input.toggle === "autoSignOff") {
    if (!input.next || !settings.autoPlan) return [];
    const waitingPlans = planning.filter(
      (child) => child.autoPlanPending === true && !live(child) && child.planCount === 1,
    ).length;
    if (waitingPlans > 0) {
      lines.push(`${count(waitingPlans, "waiting plan", "waiting plans")} will be approved.`);
    }
    return lines;
  }

  if (input.toggle === "autoBuild") {
    // Before the group starts, inherited Auto-build is armed, not on.
    if (!settings.started) return [];
    if (input.next) {
      const ready = children.filter(at(beforeBuild)).length;
      if (ready > 0) {
        lines.push(
          `${count(ready, "ready child", "ready children")} will start building once ${ready === 1 ? "its" : "their"} dependencies are done.`,
        );
      }
    }
    return lines;
  }

  if (merge === null) return lines;
  const atMerge = children.filter(at(merge.stageId)).length;
  if (input.next) {
    if (atMerge > 0) {
      lines.push(`${count(atMerge, "child", "children")} in ${merge.label} will merge now.`);
    }
    return lines;
  }
  const buildIndex = build === null ? -1 : boardStageIndex(input.stages, build);
  const mergeIndex = boardStageIndex(input.stages, merge.stageId);
  const inFlight = children.filter((child) => {
    const index = boardStageIndex(input.stages, child.stage);
    return buildIndex >= 0 && index >= buildIndex && index <= mergeIndex;
  }).length;
  if (inFlight > 0) {
    lines.push(
      `${count(inFlight, "child", "children")} in progress will no longer auto-merge; ${inFlight === 1 ? "it waits" : "they wait"} in ${merge.label} for you.`,
    );
  }
  return lines;
}

/**
 * The card face's Auto-build chip: neutral, because a card that
 * starts itself is not running, not done and asking nothing of anyone. Yields
 * to a schedule pill, which names a concrete moment.
 */
export function boardCardAutoBuildChip(input: {
  readonly armed: boolean;
  readonly done: boolean;
  readonly scheduled: boolean;
}): { readonly label: string; readonly tooltip: string } | null {
  if (!input.armed || input.done || input.scheduled) return null;
  return {
    label: "Auto-build",
    tooltip: "Starts building by itself once its dependencies are done",
  };
}
