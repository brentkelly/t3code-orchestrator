/**
 * The card detail's Automation section (T3O-38), as pure decisions: which
 * toggles are on, what each row says, the source tag beside it, and what a
 * group toggle would do to the children that inherit it. Resolution itself is
 * `resolveBoardCardAutomation` in contracts — the one reading the server uses —
 * so the switch and the server can never disagree about a card.
 */
import {
  BOARD_AUTOMATION_TOGGLE_LABELS,
  boardStageBeforeBuild,
  boardStageById,
  boardStageIndex,
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
  readonly planningFinished?: boolean | undefined;
}): BoardResolvedAutomation {
  const nodes = nodesOf(input.shells);
  return resolveBoardCardAutomation({
    stages: input.stages.stages ?? [],
    lookup: (id) => nodes.get(id),
    card: input.card,
    boardWideAutoMerge: input.boardWideAutoMerge,
    planningFinished: input.planningFinished,
  });
}

/**
 * Whether the card's planning run for this stay has finished, from what the
 * detail carries: it sits in the plan stage, no step is live, and its latest
 * plan-stage completion succeeded. The client's reading of
 * `boardCardPlanningFinished`; the server re-checks the lock either way.
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

const SHORT_NAMES: Readonly<Record<BoardAutomationToggle, string>> = {
  autoPlan: "Plan",
  autoBuild: "Build",
  autoMerge: "Merge",
};

/** The collapsed header's summary: the toggles that are on, or "Off". */
export function boardAutomationSummary(on: ReadonlyArray<BoardAutomationToggle>): string {
  const names = (["autoPlan", "autoBuild", "autoMerge"] as const)
    .filter((toggle) => on.includes(toggle))
    .map((toggle) => SHORT_NAMES[toggle]);
  return names.length === 0 ? "Off" : names.join(" · ");
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
  /** Turning it on would be refused: the switch is disabled. */
  readonly locked: boolean;
  readonly lockReason: string | null;
  /** The card has its own value under a parent group, so it can go back to
      the group's. */
  readonly canInherit: boolean;
}

function lockState(toggle: BoardResolvedAutomationToggle) {
  return { locked: toggle.locked, lockReason: toggle.lockReason };
}

function canInherit(toggle: BoardResolvedAutomationToggle): boolean {
  return (
    toggle.own !== null &&
    toggle.inheritedFrom !== null &&
    !toggle.locked &&
    toggle.source !== "board"
  );
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
    canInherit: canInherit(toggle),
  };
}

/** A leaf card's three rows. */
export function boardCardAutomationRows(input: {
  readonly resolved: BoardResolvedAutomation;
  readonly inPlanning: boolean;
}): ReadonlyArray<BoardAutomationRow> {
  const { autoPlan, autoBuild, autoMerge } = input.resolved;
  const planNote = autoPlan.value
    ? autoBuild.value
      ? "The agent plans this card unattended; the plan is approved and built."
      : "The agent plans this card unattended; the plan waits for your approval."
    : input.inPlanning
      ? "Turn on to have the agent decide the remaining questions and finish the plan."
      : "Planned with you when it enters Planning.";
  const buildNote = autoBuild.waitingForGroupStart
    ? `Starts building once ${autoBuild.inheritedFrom?.key ?? "the group"} has started and every dependency is done.`
    : autoBuild.value
      ? "Starts building once it is Ready and every dependency is done."
      : "Waits at Ready until you start it.";
  const mergeNote = autoMerge.value
    ? "Merges itself as soon as the forge accepts. A refusal retries on a backoff."
    : "Waits in Ready for merge until you click Merge.";
  return [
    row("autoPlan", BOARD_AUTOMATION_TOGGLE_LABELS.autoPlan, autoPlan, planNote),
    row("autoBuild", BOARD_AUTOMATION_TOGGLE_LABELS.autoBuild, autoBuild, buildNote),
    row("autoMerge", BOARD_AUTOMATION_TOGGLE_LABELS.autoMerge, autoMerge, mergeNote),
  ];
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
    lockReason,
    canInherit: false,
  });
  const rows: BoardAutomationRow[] = [
    plain("autoPlan", "Auto-plan", vm.autoPlan),
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

/** The header summary for any set of rows: a group's two merges read as one. */
export function boardAutomationRowsSummary(rows: ReadonlyArray<BoardAutomationRow>): string {
  return boardAutomationSummary(
    rows.filter((r) => r.on).map((r) => (r.id === "ownMerge" ? "autoMerge" : r.id)),
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What flipping one group setting does to the children that inherit it and are
 * already mid-stage — the confirmation's lines. Empty when nothing in flight
 * changes, which is when the flip needs no confirmation. Counts only direct
 * leaf children with no value of their own for the toggle: inheritance is from
 * the nearest group alone, and an own value is untouched by the group.
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
      : input.toggle === "autoBuild"
        ? settings.autoBuild
        : settings.autoMerge;
  if (current === input.next) return [];
  if (input.toggle === "autoMerge" && input.boardWideAutoMerge) return [];

  const settingOf = (child: BoardCardShell) =>
    input.toggle === "autoPlan"
      ? child.autoPlanSetting
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

  if (input.toggle === "autoBuild") {
    // Before the group starts, inherited Auto-build is armed, not on.
    if (!settings.started) return [];
    const waitingPlans = planning.filter(
      (child) => child.autoPlanPending === true && !live(child),
    ).length;
    if (input.next) {
      if (waitingPlans > 0) {
        lines.push(
          `${count(waitingPlans, "waiting plan", "waiting plans")} will be approved and built.`,
        );
      }
      const ready = children.filter(at(beforeBuild)).length;
      if (ready > 0) {
        lines.push(
          `${count(ready, "ready child", "ready children")} will start building once ${ready === 1 ? "its" : "their"} dependencies are done.`,
        );
      }
    } else {
      const unattended = planning.filter((child) => child.autoPlanPending === true).length;
      if (unattended > 0) {
        lines.push(
          `${count(unattended, "plan", "plans")} from unattended planning will wait for your approval instead of building.`,
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
 * The card face's Auto-build chip (T3O-38): neutral, because a card that
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
