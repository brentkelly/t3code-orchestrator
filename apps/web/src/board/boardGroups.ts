/**
 * Groups on the board (T3O-29): everything the card face, the drag, the
 * sub-board header, the settings popover and the dialogs ask about a group,
 * answered over the client's shells. The decider owns the rules
 * (`@t3tools/contracts` `boardGroups.ts`); these mirror the ones a human hits
 * before a command is sent, so a refused column says why instead of bouncing.
 */
import {
  boardStageBeforeBuild,
  boardStageIndex,
  effectiveBoardStageRole,
  boardStageWithRole,
  isBoardDeferredStage,
  isBoardStageAtOrAfterBuild,
  type BoardCardAttention,
  type BoardCardGroup,
  type BoardCardShell,
  type BoardStageId,
  type BoardState,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";

type Shells = ReadonlyArray<BoardCardShell>;

/** The name trunk goes by on the client, which never sees a project's default
    branch name. */
export const BOARD_TRUNK_LABEL = "trunk";

function byId(shells: Shells): ReadonlyMap<string, BoardCardShell> {
  return new Map(shells.map((shell) => [String(shell.cardId), shell]));
}

export function boardShellChildren(shells: Shells, cardId: string): Shells {
  return shells.filter(
    (shell) => shell.parentCardId !== undefined && String(shell.parentCardId) === cardId,
  );
}

/** A card is a group while it has settings or a live child (a split parent
    written before groups carries no settings, exactly as on the server). */
export function isBoardGroupShell(shells: Shells, card: BoardCardShell): boolean {
  return card.group !== undefined || boardShellChildren(shells, String(card.cardId)).length > 0;
}

/** The group's settings, with the legacy split parent's backfilled reading. */
export function boardShellGroup(shells: Shells, card: BoardCardShell): BoardCardGroup | null {
  if (card.group !== undefined) return card.group;
  if (boardShellChildren(shells, String(card.cardId)).length === 0) return null;
  return {
    target: "own",
    autoBuild: true,
    autoMerge: false,
    autoPlan: false,
    started: false,
    placed: card.stage,
    prevStage: card.stage,
    heading: false,
    integrated: false,
  };
}

/** The integration branch an `own` group cuts — the server's `board/<key>`. */
export function boardGroupBranchName(card: Pick<BoardCardShell, "key">): string {
  return `board/${sanitizeBranchFragment(card.key)}`;
}

/** Ancestors, nearest first; stops on a corrupt cycle. */
export function boardShellAncestors(shells: Shells, card: BoardCardShell): Shells {
  const index = byId(shells);
  const out: BoardCardShell[] = [];
  const seen = new Set<string>([String(card.cardId)]);
  let parentId = card.parentCardId === undefined ? null : String(card.parentCardId);
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = index.get(parentId);
    if (parent === undefined) break;
    out.push(parent);
    parentId = parent.parentCardId === undefined ? null : String(parent.parentCardId);
  }
  return out;
}

/** Where a group's CHILDREN merge: its own branch, else whatever it lands on. */
export function boardGroupTargetLabel(shells: Shells, card: BoardCardShell): string {
  const group = boardShellGroup(shells, card);
  if (group?.target === "own") return boardGroupBranchName(card);
  return boardCardLandsOnLabel(shells, card);
}

/** Where a card ITSELF merges: its parent's target, or trunk at the top. */
export function boardCardLandsOnLabel(shells: Shells, card: BoardCardShell): string {
  const parent = boardShellAncestors(shells, card)[0];
  return parent === undefined ? BOARD_TRUNK_LABEL : boardGroupTargetLabel(shells, parent);
}

function isLeafStarted(stages: BoardState, card: BoardCardShell): boolean {
  return isBoardStageAtOrAfterBuild(stages, card.stage) || card.worktreeReady === true;
}

/** Every descendant, depth-first. */
export function boardShellDescendants(shells: Shells, cardId: string): Shells {
  const out: BoardCardShell[] = [];
  const seen = new Set<string>([cardId]);
  const walk = (id: string) => {
    for (const child of boardShellChildren(shells, id)) {
      const childId = String(child.cardId);
      if (seen.has(childId)) continue;
      seen.add(childId);
      out.push(child);
      walk(childId);
    }
  };
  walk(cardId);
  return out;
}

/** Whether work has started on a leaf; a group never has, its children have. */
export function isBoardShellStarted(
  shells: Shells,
  stages: BoardState,
  card: BoardCardShell,
): boolean {
  return !isBoardGroupShell(shells, card) && isLeafStarted(stages, card);
}

// ── Stats and the card face ─────────────────────────────────────────────

export type BoardGroupChildState = "done" | "waiting" | "blocked" | "running" | "idle";

export interface BoardGroupStats {
  readonly all: Shells;
  /** Children that count toward done: every child not in Deferred. */
  readonly active: Shells;
  readonly states: ReadonlyArray<BoardGroupChildState>;
  readonly done: number;
  readonly waiting: number;
  readonly blocked: number;
  readonly running: number;
  readonly deferred: number;
}

export interface BoardGroupStatsInput {
  readonly shells: Shells;
  readonly stages: BoardState;
  /** The page's attention resolver, so "needs you" agrees with the leaf face. */
  readonly attentionFor: (card: BoardCardShell) => BoardCardAttention | null;
}

export function boardGroupStats(input: BoardGroupStatsInput, cardId: string): BoardGroupStats {
  return statsWithMemo(input, cardId, new Map(), new Set());
}

function statsWithMemo(
  input: BoardGroupStatsInput,
  cardId: string,
  memo: Map<string, BoardGroupStats>,
  visiting: Set<string>,
): BoardGroupStats {
  const known = memo.get(cardId);
  if (known !== undefined) return known;
  visiting.add(cardId);
  const doneStageId = boardStageWithRole(input.stages, "done")?.stageId ?? null;
  const all = boardShellChildren(input.shells, cardId);
  const active = all.filter((child) => !isBoardDeferredStage(child.stage));
  const stateOf = (child: BoardCardShell): BoardGroupChildState => {
    if (child.stage === doneStageId) return "done";
    const childId = String(child.cardId);
    if (isBoardGroupShell(input.shells, child) && !visiting.has(childId)) {
      const inner = statsWithMemo(input, childId, memo, visiting);
      if (inner.waiting > 0) return "waiting";
      if (inner.blocked > 0) return "blocked";
      return inner.running > 0 ? "running" : "idle";
    }
    const attention = input.attentionFor(child);
    if (attention?.tone === "attention") return "waiting";
    if (child.blocked || attention?.tone === "warning") return "blocked";
    return isBoardStageAtOrAfterBuild(input.stages, child.stage) ? "running" : "idle";
  };
  const states = active.map(stateOf);
  const count = (state: BoardGroupChildState) => states.filter((s) => s === state).length;
  const stats: BoardGroupStats = {
    all,
    active,
    states,
    done: count("done"),
    waiting: count("waiting"),
    blocked: count("blocked"),
    running: count("running"),
    deferred: all.length - active.length,
  };
  visiting.delete(cardId);
  memo.set(cardId, stats);
  return stats;
}

const CHILD_STATE_NAME: Record<BoardGroupChildState, string> = {
  done: "done",
  waiting: "needs you",
  blocked: "blocked",
  running: "running",
  idle: "not started",
};

export interface BoardGroupCardVm {
  readonly pips: ReadonlyArray<{
    readonly state: BoardGroupChildState;
    readonly tooltip: string;
  }>;
  /** `n/m`, or `0` for a group with no active children. */
  readonly doneLabel: string;
  /** Violet "N need(s) you", or null. */
  readonly needs: string | null;
  /** Amber "N blocked", or null. */
  readonly blocked: string | null;
  /** `+N deferred · → branch · auto-build on`, empty parts dropped. */
  readonly meta: string;
  /** Whether every active child is done and nothing is deferred — the only
      state a group may wear green in. */
  readonly complete: boolean;
}

export function boardGroupCardVm(
  input: BoardGroupStatsInput,
  card: BoardCardShell,
): BoardGroupCardVm | null {
  const group = boardShellGroup(input.shells, card);
  if (group === null) return null;
  const stats = boardGroupStats(input, String(card.cardId));
  return {
    pips: stats.active.map((child, index) => ({
      state: stats.states[index]!,
      tooltip: `${child.key} · ${child.title} — ${CHILD_STATE_NAME[stats.states[index]!]}`,
    })),
    doneLabel: stats.active.length > 0 ? `${stats.done}/${stats.active.length}` : "0",
    needs: stats.waiting > 0 ? `${stats.waiting} need${stats.waiting === 1 ? "s" : ""} you` : null,
    blocked: stats.blocked > 0 ? `${stats.blocked} blocked` : null,
    meta: [
      stats.deferred > 0 ? `+${stats.deferred} deferred` : "",
      group.target === "own" ? `→ ${boardGroupBranchName(card)}` : "",
      boardGroupAutoBuildLabel(group),
    ]
      .filter((part) => part.length > 0)
      .join(" · "),
    complete: stats.active.length > 0 && stats.done === stats.active.length && stats.deferred === 0,
  };
}

/** "auto-build on" once started, "auto-build armed" before; empty when off. */
export function boardGroupAutoBuildLabel(group: BoardCardGroup): string {
  if (!group.autoBuild) return "";
  return group.started ? "auto-build on" : "auto-build armed";
}

// ── Drag rules ──────────────────────────────────────────────────────────

/** Ready children with their dependencies met: what a start would move. */
export function boardGroupReadyChildren(
  shells: Shells,
  stages: BoardState,
  group: BoardCardShell,
): Shells {
  const readyStageId = boardStageBeforeBuild(stages)?.stageId;
  if (readyStageId === undefined) return [];
  return boardShellChildren(shells, String(group.cardId)).filter(
    (child) => !isBoardGroupShell(shells, child) && child.stage === readyStageId && !child.blocked,
  );
}

function roleOfStage(stages: BoardState, stageId: BoardStageId) {
  const stage = stages.stages.find((candidate) => candidate.stageId === stageId);
  return stage === undefined ? null : effectiveBoardStageRole(stage);
}

/**
 * Why a drag of `card` cannot land on `toStage`, or null when it may. Leaves
 * only meet the Deferred rule here — the dependency gate and the rest are the
 * decider's, as before. A group reaches its later columns by derivation, so
 * a drag can only place its heading, or start it.
 */
export function boardDropRefusal(input: {
  readonly shells: Shells;
  readonly stages: BoardState;
  readonly card: BoardCardShell;
  readonly toStage: BoardStageId;
}): string | null {
  const { shells, stages, card, toStage } = input;
  if (toStage === card.stage) return null;
  if (isBoardDeferredStage(toStage)) {
    if (isBoardShellStarted(shells, stages, card)) {
      return `Work has started on ${card.key}. Let it finish, or archive it.`;
    }
    const startedInside = boardShellDescendants(shells, String(card.cardId)).find((descendant) =>
      isBoardShellStarted(shells, stages, descendant),
    );
    if (startedInside !== undefined) {
      return `Work has started on ${startedInside.key} inside ${card.key}. Let it finish, or archive it.`;
    }
    return null;
  }
  const group = boardShellGroup(shells, card);
  if (group === null) return null;
  const build = boardStageWithRole(stages, "build");
  const buildIndex = build === null ? -1 : boardStageIndex(stages, build.stageId);
  const toIndex = boardStageIndex(stages, toStage);
  const live = isBoardStageAtOrAfterBuild(stages, card.stage);
  const target = boardGroupTargetLabel(shells, card);
  const role = roleOfStage(stages, toStage);
  if (role === "done") {
    return "Done when all active children are done. Defer or archive the rest.";
  }
  if (role === "merge") {
    return "Reached automatically. A group never merges by hand; its children do.";
  }
  if (buildIndex >= 0 && toIndex > buildIndex) {
    return group.target === "own"
      ? `Reached automatically. The integration review of ${target} opens when every active child is done.`
      : `This group merges straight into ${target}, so it has no review of its own. Give it an integration branch in Group settings.`;
  }
  if (build !== null && toStage === build.stageId) {
    if (live || group.autoBuild) return null;
    return boardGroupReadyChildren(shells, stages, card).length > 0
      ? null
      : "No children are ready to start. Plan them first.";
  }
  if (buildIndex > 0 && toIndex === buildIndex - 1) {
    return "Ready holds a single card's approved plan. Drag the group to Building to start its children.";
  }
  if (live) {
    return "Children are already building. To pause, turn off auto-build: running children finish and no new ones start.";
  }
  return null;
}

/** What dropping a group on Building does, for the start confirmation. */
export interface BoardGroupStartPlan {
  readonly autoBuild: boolean;
  readonly ready: Shells;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
}

export function boardGroupStartPlan(
  shells: Shells,
  stages: BoardState,
  group: BoardCardShell,
): BoardGroupStartPlan {
  const settings = boardShellGroup(shells, group);
  const ready = boardGroupReadyChildren(shells, stages, group);
  const autoBuild = settings?.autoBuild === true;
  if (autoBuild) {
    return {
      autoBuild,
      ready,
      title: "Start auto-build?",
      body:
        ready.length === 0
          ? `No children of ${group.key} are ready yet. Auto-build is armed: each one starts as soon as it is ready with its dependencies met.`
          : `${ready.length} ${ready.length === 1 ? "child is" : "children are"} ready with dependencies met. They start now, and the rest of ${group.key} follows as each one unblocks the next.`,
      confirmLabel: "Start auto-build",
    };
  }
  return {
    autoBuild,
    ready,
    title:
      ready.length === 1
        ? "Start the ready child?"
        : `Start the ${ready.length} ready, unblocked children?`,
    body: `Auto-build is off for ${group.key}, so this is a one-off start. Children that become ready later wait for you.`,
    confirmLabel: `Start ${ready.length}`,
  };
}

// ── Group settings ──────────────────────────────────────────────────────

export interface BoardGroupSettingsVm {
  readonly target: BoardCardGroup["target"];
  /** Where the children merge, resolved. */
  readonly resolvedTarget: string;
  /** Where the group's own integration review merges (own groups only). */
  readonly ownReviewNote: string | null;
  /** Why the target cannot change, or null. */
  readonly targetLockReason: string | null;
  readonly autoBuild: { readonly on: boolean; readonly note: string };
  readonly autoMerge: {
    readonly on: boolean;
    readonly disabled: boolean;
    readonly note: string;
  };
  readonly autoPlan: { readonly on: boolean; readonly note: string };
}

export function boardGroupSettingsVm(
  shells: Shells,
  stages: BoardState,
  card: BoardCardShell,
): BoardGroupSettingsVm | null {
  const group = boardShellGroup(shells, card);
  if (group === null) return null;
  const doneStageId = boardStageWithRole(stages, "done")?.stageId ?? null;
  const started = boardShellDescendants(shells, String(card.cardId)).filter(
    (descendant) =>
      isBoardShellStarted(shells, stages, descendant) && descendant.stage !== doneStageId,
  );
  const resolved = boardGroupTargetLabel(shells, card);
  const landsOn = boardCardLandsOnLabel(shells, card);
  const atTrunk = resolved === BOARD_TRUNK_LABEL;
  return {
    target: group.target,
    resolvedTarget: resolved,
    ownReviewNote:
      group.target === "own"
        ? `Children merge into ${resolved}. Once they are all done, its review merges it into ${landsOn}.`
        : `Children merge straight into ${resolved}; the group has no review of its own.`,
    targetLockReason:
      started.length === 0
        ? null
        : `Locked: work has started on ${started.map((s) => s.key).join(", ")}, whose branch was cut from the current target.`,
    autoBuild: {
      on: group.autoBuild,
      note: group.autoBuild
        ? group.started
          ? "Ready children whose dependencies are met build, review and merge on their own."
          : "Armed. The cascade starts when you drag the group to Building."
        : "Children wait for you to start them. Turning this off never interrupts a running child.",
    },
    autoMerge: {
      on: atTrunk && group.autoMerge,
      disabled: !atTrunk,
      note: !atTrunk
        ? `Only applies when children merge into ${BOARD_TRUNK_LABEL}. These merge into ${resolved}.`
        : group.autoMerge
          ? `Children merge into ${BOARD_TRUNK_LABEL} as soon as the forge accepts.`
          : "Children stop at Ready for merge for you, unless a card has its own auto-merge on.",
    },
    autoPlan: {
      on: group.autoPlan,
      note: group.autoPlan
        ? "Children entering Planning are planned by the agent and stop at Ready."
        : "Children entering Planning are planned with you.",
    },
  };
}

/** One line on why a group sits in its stage, for the popup's action area. */
export function boardGroupNote(input: BoardGroupStatsInput, card: BoardCardShell): string {
  const group = boardShellGroup(input.shells, card);
  if (group === null) return "";
  const stats = boardGroupStats(input, String(card.cardId));
  const roleOf = roleOfStage(input.stages, card.stage);
  if (roleOf === "done") return "Done: every active child is done.";
  if (isBoardStageAtOrAfterBuild(input.stages, card.stage) && roleOf !== "build") {
    return `Every child has merged into ${boardGroupBranchName(card)}. This review merges it into ${boardCardLandsOnLabel(input.shells, card)}.`;
  }
  if (roleOf === "build") {
    return `Building while any child is underway. ${stats.done} of ${stats.active.length} active children done${
      stats.deferred > 0 ? `; ${stats.deferred} deferred don't count.` : "."
    }`;
  }
  return "Stays where you put it until a child starts. Drag it to Building to start the ready children.";
}

// ── New phase and confirmations ─────────────────────────────────────────

/** The deferred children of a group, which a new phase may take. */
export function boardDeferredChildren(shells: Shells, groupId: string): Shells {
  return boardShellChildren(shells, groupId).filter((child) => isBoardDeferredStage(child.stage));
}

/** The typed-ID gate: the card's key, case-insensitive, ignoring outer space. */
export function isBoardTypedKeyConfirmed(typed: string, key: string): boolean {
  return typed.trim().toLowerCase() === key.trim().toLowerCase();
}
