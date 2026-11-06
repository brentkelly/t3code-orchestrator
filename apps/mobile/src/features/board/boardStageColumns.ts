import type { BoardCardShell, BoardStageDefinition, ProjectId } from "@t3tools/contracts";

export function liveTopLevelBoardCards(
  cards: ReadonlyArray<BoardCardShell>,
  projectId: ProjectId | null,
): ReadonlyArray<BoardCardShell> {
  return cards.filter(
    (card) =>
      card.archivedAt === null &&
      card.parentCardId === undefined &&
      (projectId === null || card.projectId === projectId),
  );
}

export function cardsInStage(
  cards: ReadonlyArray<BoardCardShell>,
  stageId: string,
): ReadonlyArray<BoardCardShell> {
  return cards
    .filter((card) => card.stage === stageId)
    .slice()
    .sort((left, right) => (left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0));
}

export function boardStageLiveCounts(
  stages: ReadonlyArray<BoardStageDefinition>,
  cards: ReadonlyArray<BoardCardShell>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const stage of stages) counts.set(stage.stageId, 0);
  for (const card of cards) {
    counts.set(card.stage, (counts.get(card.stage) ?? 0) + 1);
  }
  return counts;
}
