/**
 * The stage a phone board should open on (T3O-18): first waiting/blocked
 * column, else the first non-empty column, else the first stage.
 */
import {
  boardCardAttention,
  type BoardCardShell,
  type BoardStageDefinition,
  type BoardStageId,
} from "@t3tools/contracts";

export type DefaultBoardStageCard = Parameters<typeof boardCardAttention>[0]["card"] &
  Pick<BoardCardShell, "blocked">;

/**
 * Pick the stage a monitor-and-act board should land on.
 *
 * Archived cards are ignored. A stage with a blocked card or a card that
 * `boardCardAttention` ranks (waiting on a human, stalled, held, paused)
 * wins over a merely occupied column.
 */
export function defaultBoardStageId(input: {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly cards: ReadonlyArray<DefaultBoardStageCard>;
  readonly now?: number;
}): BoardStageId | null {
  const { stages } = input;
  if (stages.length === 0) return null;
  const live = input.cards.filter((card) => card.archivedAt === null);
  const needsHuman = (card: DefaultBoardStageCard): boolean =>
    card.blocked ||
    boardCardAttention({ card, stages, now: input.now }) !== null;

  for (const stage of stages) {
    if (live.some((card) => card.stage === stage.stageId && needsHuman(card))) {
      return stage.stageId;
    }
  }
  for (const stage of stages) {
    if (live.some((card) => card.stage === stage.stageId)) {
      return stage.stageId;
    }
  }
  return stages[0]?.stageId ?? null;
}
