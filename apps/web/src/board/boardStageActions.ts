/**
 * T3o primary stage action (t3o-06, D18/D13). The detail pane's primary button
 * is the human gate that advances a card one stage — the SAME gate a drag or a
 * thread answer resolves. Now derived generically from the user-defined stage
 * list (t3o-15): the exhaustive per-stage switch is gone, replaced by "move to
 * the next stage in order".
 *
 * The `build`-role stage has no forward button WHILE the pipeline is driving
 * it: its onward crossing is board-driven (a successful unattended run
 * auto-advances, D8), never a human click. The one exception is a SETTLED step
 * (t3o-06 held-build-forward-button, D1) — a human-in-the-loop build never
 * auto-advances and a failed one never will either, so once the step settles
 * the ordinary forward move is offered rather than nothing at all. The last
 * stage (Done) has none either — its only exit is archive.
 */
import {
  effectiveBoardStageRole,
  boardStageIndex,
  boardNextStageId,
  boardStageWithRole,
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
 * Stages a human may drop a card into directly from the detail modal's stage
 * ladder: everything before the `build` role. From the build role onward, a
 * stage describes work the board has started shepherding (a worktree, a run),
 * so it is *granted* by a gate, a run result or a review verdict rather than
 * chosen. The ladder still shows those stages; it just does not offer them as a
 * click.
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
 * The detail pane's primary button.
 *
 * A discriminated union because the merge-role stage's button does something
 * categorically different from every other stage's: it performs a git
 * operation on the forge rather than moving a card between columns. Making
 * that a `kind` rather than, say, a nullable `toStage` means the view cannot
 * accidentally treat a Merge click as a stage move.
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
      /** Set while a conflict-resolution step is running: the branch is being
          rewritten under the pull request, so merging now is meaningless. */
      readonly disabled: boolean;
      /** Why the button is disabled, for the tooltip. Null when enabled. */
      readonly disabledReason: string | null;
    };

/** What the merge-role stage's button needs to know beyond the stage list. */
export interface BoardStagePrimaryActionContext {
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
  /** Whether a step is running on this card in the merge stage. Nothing else
      runs there — the stage does not auto-execute — so a live step can only be
      the conflict-resolution one. */
  readonly conflictStepRunning?: boolean;
  /** Whether the card's step has SETTLED and left the card standing (the
      shell's `held`, ranked by `boardCardAttention`). The build role has no
      human forward gate while the pipeline is driving it — but once its step
      settles, nothing will move the card on, so the ordinary forward move is
      offered instead of nothing at all. */
  readonly stepHeld?: boolean;
}

export function boardStagePrimaryAction(
  stages: ReadonlyArray<BoardStageDefinition>,
  stageId: BoardStageId,
  context?: BoardStagePrimaryActionContext,
): BoardStagePrimaryAction | null {
  const board = stateOf(stages);
  const current = stages.find((stage) => stage.stageId === stageId) ?? null;
  // Effective, not raw: a `board_stages` row seeded before a role existed
  // carries it as NULL, and the button must not change behaviour based on how
  // old someone's database is.
  const currentRole = current === null ? null : effectiveBoardStageRole(current);
  // The build role advances board-driven (D8) — no human forward gate WHILE the
  // pipeline is driving it. A settled step is the opposite case: a
  // human-in-the-loop build that ran to the end never auto-advances, and a
  // failed one never will either, so the card would sit in Building with a
  // "Needs a human" chip and nothing to press.
  if (currentRole === "build" && context?.stepHeld !== true) return null;
  // The merge role's button merges the pull request and advances as a
  // consequence. Only with a PR still OPEN: merged, closed, or absent all fall
  // through to the ordinary forward move below, so a card whose PR someone
  // merged on GitHub — or a card that never had one — still has a way to Done.
  if (currentRole === "merge" && context?.pullRequestState === "open") {
    const disabled = context.conflictStepRunning === true;
    return {
      kind: "merge",
      label: context.pullRequestNumber == null ? "Merge" : `Merge PR #${context.pullRequestNumber}`,
      emphasised: true,
      disabled,
      disabledReason: disabled ? "Resolving conflicts…" : null,
    };
  }
  const next = boardNextStageId(board, stageId);
  if (next === null) return null;
  const nextStage = stages.find((stage) => stage.stageId === next);
  if (nextStage === undefined) return null;
  // Crossing into the build role is the "Begin build" human gate (D11).
  if (effectiveBoardStageRole(nextStage) === "build") {
    return { kind: "move", label: "Begin build", toStage: next, emphasised: true };
  }
  return { kind: "move", label: `Move to ${nextStage.label}`, toStage: next, emphasised: false };
}
