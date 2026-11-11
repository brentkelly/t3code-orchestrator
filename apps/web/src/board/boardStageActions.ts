/**
 * The detail pane's primary stage action: move to the next stage in order. The
 * build role has none while the pipeline drives it, only once its step settles;
 * the last stage has none (its exit is archive).
 */
import {
  BOARD_SEED_STAGE_IDS,
  effectiveBoardStageRole,
  boardStageById,
  boardStageIndex,
  boardNextStageId,
  boardStageWithRole,
  compareBoardStages,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
} from "@t3tools/contracts";

/** A view of the stage list as a `BoardState` slice, so the read-model helpers
    (`boardStageIndex`, `boardNextStageId`, …) apply to a bare stage array. */
function stateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

/**
 * Stages a human may pick from the detail modal's ladder: everything before
 * the build role. Later stages are granted by a gate, run result or verdict.
 */
export function isBoardStageManuallySelectable(
  stages: ReadonlyArray<BoardStageDefinition>,
  stageId: BoardStageId,
): boolean {
  const board = stateOf(stages);
  const build = boardStageWithRole(board, "build");
  if (build === null) return true;
  const index = boardStageIndex(board, stageId);
  const buildIndex = boardStageIndex(board, build.stageId);
  return index >= 0 && buildIndex >= 0 && index < buildIndex;
}

/**
 * The primary button. A union because Merge is a forge operation, not a stage
 * move, and the view must not treat it as one.
 */
export type BoardStagePrimaryAction =
  | {
      readonly kind: "move";
      readonly label: string;
      readonly toStage: BoardStageId;
      /** Whether the button is the filled, accented one — the build crossing is
          the one gate loud enough to read before clicking. */
      readonly emphasised: boolean;
    }
  | {
      readonly kind: "merge";
      readonly label: string;
      readonly emphasised: true;
      /** Set while a merge conflict fix is live: the branch is being rewritten
          under the pull request, so merging now is meaningless. */
      readonly disabled: boolean;
      /** Why the button is disabled, for the tooltip. Null when enabled. */
      readonly disabledReason: string | null;
    };

/** What the merge-role stage's button needs to know beyond the stage list. */
export interface BoardStagePrimaryActionContext {
  /** The card has a CI entry: only passing or Skip CI moves it on. */
  readonly ciEntryLive?: boolean;
  /** The card's pull request state, or null when it has none. Only `open` puts
      a Merge button on the card: a merged or closed PR has nothing left to
      merge, and the card falls back to the ordinary forward move so it is
      never stranded short of Done. */
  readonly pullRequestState?: "open" | "closed" | "merged" | null;
  /** The number of the pull request the button would merge, so it can say
      which one. A card can accumulate several over its life — worked on,
      merged, dragged back out of Done, worked on again — and an unnumbered
      "Merge" leaves the one moment that matters ambiguous. */
  readonly pullRequestNumber?: number | null;
  /** Whether a merge conflict fix is live, from the shell's `stepConflictFix`,
      not inferred from a running merge-stage step (which a human-started
      conversation also is). */
  readonly conflictFixLive?: boolean;
  /** Why Merge is disabled while that fix runs ("Fixing CI…" for a CI fix).
      Defaults to the conflict wording. */
  readonly conflictFixReason?: string | null;
  /** Whether the card's step has settled and left it standing. A settled build
      step gets the ordinary forward move, since nothing else will move it. */
  readonly stepHeld?: boolean;
}

/**
 * A secondary action offered BESIDE the primary one, behind a caret. A list, not a nullable, so
 * a second entry is a list entry rather than a second shape — the popover is already a list.
 */
export type BoardStageSecondaryAction = {
  readonly kind: "submit-no-review";
  readonly label: string;
  /** The subtitle under the item: what the click actually does, which is not
      obvious from a label that says what it skips. */
  readonly detail: string;
};

/** What the secondary actions need to know beyond the stage list. */
export interface BoardStageSecondaryActionContext extends BoardStagePrimaryActionContext {
  /** Whether the card has a worktree branch. With none there is nothing to
      push, so there is nothing to submit. */
  readonly hasBranch?: boolean;
  /** Unmet dependencies hold the card where it is, and the gate is not
      overridable — so the caret would only offer a move the server refuses. */
  readonly blocked?: boolean;
}

/**
 * The caret beside the forward button: "Submit for merge (no review)" only
 * when the forward button shows, the next stage is review, a merge stage
 * exists, the card has a branch, and it is not blocked.
 */
export function boardStageSecondaryActions(
  stages: ReadonlyArray<BoardStageDefinition>,
  stageId: BoardStageId,
  context?: BoardStageSecondaryActionContext,
): ReadonlyArray<BoardStageSecondaryAction> {
  const primary = boardStagePrimaryAction(stages, stageId, context);
  if (primary === null || primary.kind !== "move") return [];
  const board = stateOf(stages);
  const current = stages.find((stage) => stage.stageId === stageId) ?? null;
  if (current === null || effectiveBoardStageRole(current) !== "build") return [];
  if (context?.hasBranch !== true || context.blocked === true) return [];
  const next = stages.find((stage) => stage.stageId === primary.toStage) ?? null;
  if (next === null || effectiveBoardStageRole(next) !== "review") return [];
  if (boardStageWithRole(board, "merge") === null) return [];
  return [
    {
      kind: "submit-no-review",
      label: "Submit for merge (no review)",
      detail: "Opens the PR as normal, straight to Ready for merge.",
    },
  ];
}

/**
 * The forward target, CI aware: the stage before CI moves into it, and a card
 * leaves CI only by passing or Skip CI. `boardNextStageId` reads a bare list as
 * the global pipeline, which never has CI, so CI is walked here.
 */
export function boardCiAwareNextStageId(
  stages: ReadonlyArray<BoardStageDefinition>,
  stageId: BoardStageId,
  ciEntryLive: boolean,
): BoardStageId | null {
  const ci = BOARD_SEED_STAGE_IDS.ci;
  const ordered = [...stages].sort(compareBoardStages);
  const ciIndex = ordered.findIndex((stage) => stage.stageId === ci);
  if (ciIndex < 0) return boardNextStageId(stateOf(stages), stageId, null);
  if (stageId === ci) return ciEntryLive ? null : (ordered[ciIndex + 1]?.stageId ?? null);
  const next = boardNextStageId(stateOf(stages), stageId, null);
  if (next === null) return null;
  const fromIndex = ordered.findIndex((stage) => stage.stageId === stageId);
  const nextIndex = ordered.findIndex((stage) => stage.stageId === next);
  return fromIndex < ciIndex && nextIndex > ciIndex ? ci : next;
}

export function boardStagePrimaryAction(
  stages: ReadonlyArray<BoardStageDefinition>,
  stageId: BoardStageId,
  context?: BoardStagePrimaryActionContext,
): BoardStagePrimaryAction | null {
  const current = stages.find((stage) => stage.stageId === stageId) ?? null;
  // Effective, not raw: a `board_stages` row seeded before a role existed
  // carries it as NULL, and the button must not change behaviour based on how
  // old someone's database is.
  const currentRole = current === null ? null : effectiveBoardStageRole(current);
  // No human gate while the pipeline drives the build; a settled step would
  // otherwise leave the card with nothing to press.
  if (currentRole === "build" && context?.stepHeld !== true) return null;
  // The merge role's button merges the pull request and advances as a
  // consequence. Only with a PR still OPEN: merged, closed, or absent all fall
  // through to the ordinary forward move below, so a card whose PR someone
  // merged on GitHub — or a card that never had one — still has a way to Done.
  if (currentRole === "merge" && context?.pullRequestState === "open") {
    const disabled = context.conflictFixLive === true;
    return {
      kind: "merge",
      label: context.pullRequestNumber == null ? "Merge" : `Merge PR #${context.pullRequestNumber}`,
      emphasised: true,
      disabled,
      disabledReason: disabled ? (context.conflictFixReason ?? "Resolving conflicts…") : null,
    };
  }
  // The stage list is already the card's own project's pipeline.
  const next = boardCiAwareNextStageId(stages, stageId, context?.ciEntryLive === true);
  if (next === null) return null;
  const nextStage = stages.find((stage) => stage.stageId === next);
  if (nextStage === undefined) return null;
  // Crossing into the build role is the "Begin build" human gate.
  if (effectiveBoardStageRole(nextStage) === "build") {
    return { kind: "move", label: "Begin build", toStage: next, emphasised: true };
  }
  return { kind: "move", label: `Move to ${nextStage.label}`, toStage: next, emphasised: false };
}

/**
 * Whether a forward move leaves the plan-role stage with no plan written, which
 * the board confirms first. Backward moves go unasked. A split child owns a copy
 * of its plan, so `planCount` alone decides.
 */
export function boardMoveLeavesPlanningUnwritten(input: {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly card: { readonly stage: BoardStageId };
  readonly toStage: BoardStageId;
  readonly planCount: number;
}): boolean {
  const { card, toStage } = input;
  if (input.planCount > 0) return false;
  const board = stateOf(input.stages);
  const from = boardStageById(board, card.stage);
  if (from === null || effectiveBoardStageRole(from) !== "plan") return false;
  return boardStageIndex(board, toStage) > boardStageIndex(board, card.stage);
}
