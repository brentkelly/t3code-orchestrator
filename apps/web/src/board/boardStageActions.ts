/**
 * T3o primary stage action (t3o-06, D18/D13). The detail pane's primary button
 * is the human gate that advances a card one stage — the SAME gate a drag or a
 * thread answer resolves. Now derived generically from the user-defined stage
 * list (t3o-15): the exhaustive per-stage switch is gone, replaced by "move to
 * the next stage in order".
 *
 * The `build`-role stage has NO forward button: its onward crossing is
 * board-driven (a successful unattended run auto-advances, D8), never a human
 * click. The last stage (Done) has none either — its only exit is archive.
 */
import {
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

export interface BoardStagePrimaryAction {
  readonly label: string;
  readonly toStage: BoardStageId;
  /** Whether the button is the filled, accented one — the build crossing is the
      one gate loud enough to read before clicking. */
  readonly emphasised: boolean;
}

export function boardStagePrimaryAction(
  stages: ReadonlyArray<BoardStageDefinition>,
  stageId: BoardStageId,
): BoardStagePrimaryAction | null {
  const board = stateOf(stages);
  const current = stages.find((stage) => stage.stageId === stageId) ?? null;
  // The build role advances board-driven (D8) — no human forward gate.
  if (current?.role === "build") return null;
  const next = boardNextStageId(board, stageId);
  if (next === null) return null;
  const nextStage = stages.find((stage) => stage.stageId === next);
  if (nextStage === undefined) return null;
  // Crossing into the build role is the "Begin build" human gate (D11).
  if (nextStage.role === "build") {
    return { label: "Begin build", toStage: next, emphasised: true };
  }
  return { label: `Move to ${nextStage.label}`, toStage: next, emphasised: false };
}
