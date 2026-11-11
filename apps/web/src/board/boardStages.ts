/**
 * Stage display helpers over the user-defined stage list, falling back to the
 * raw id for a since-deleted stage.
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
