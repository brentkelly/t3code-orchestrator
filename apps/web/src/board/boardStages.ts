/**
 * T3o board stage presentation (t3o-15, D13). Stages are user-defined, so
 * column order and labels come from the read-model stage list — the old fixed
 * `BOARD_STAGE_LABELS` map is gone. These helpers resolve a stage's display
 * label from that list, falling back to the raw id for a since-deleted stage a
 * legacy card might still reference.
 */
import type { BoardStageDefinition, BoardStageId } from "@t3tools/contracts";

/** A stage's display label from the read-model stage list, or the id itself
    when the stage no longer exists (a card left in a deleted stage). */
export function boardStageLabel(
  stages: ReadonlyArray<BoardStageDefinition>,
  stageId: BoardStageId,
): string {
  return stages.find((stage) => stage.stageId === stageId)?.label ?? stageId;
}
