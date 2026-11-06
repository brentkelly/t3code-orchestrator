import {
  deriveBoardCardPlanProgress,
  type BoardCardShell,
  type BoardStageDefinition,
  type BoardStageId,
  type ProjectId,
} from "@t3tools/contracts";

export function applyBoardCardPlanProgress(
  cards: ReadonlyArray<BoardCardShell>,
  stages: ReadonlyArray<BoardStageDefinition>,
): ReadonlyArray<BoardCardShell> {
  const progress = deriveBoardCardPlanProgress({ cards, stages });
  if (progress.size === 0) return cards;
  return cards.map((card) => {
    const counts = progress.get(card.cardId);
    if (counts === undefined) return card;
    return {
      ...card,
      planTotal: counts.total,
      planDone: counts.done,
      planStatuses: counts.statuses,
    };
  });
}

export function liveTopLevelBoardCards(
  cards: ReadonlyArray<BoardCardShell>,
  projectIds: ReadonlyArray<ProjectId> | null,
): ReadonlyArray<BoardCardShell> {
  return cards.filter(
    (card) =>
      card.archivedAt === null &&
      card.parentCardId === undefined &&
      (projectIds === null || projectIds.includes(card.projectId)),
  );
}

/** Live top-level cards after folding children into each parent's plan pips. */
export function liveTopLevelBoardCardsWithPlanProgress(
  cards: ReadonlyArray<BoardCardShell>,
  projectIds: ReadonlyArray<ProjectId> | null,
  stages: ReadonlyArray<BoardStageDefinition>,
): ReadonlyArray<BoardCardShell> {
  const live = cards.filter(
    (card) =>
      card.archivedAt === null && (projectIds === null || projectIds.includes(card.projectId)),
  );
  return liveTopLevelBoardCards(applyBoardCardPlanProgress(live, stages), null);
}

export function boardPagerScrollIndex(input: {
  readonly boardReady: boolean;
  readonly width: number;
  readonly resolvedStageId: BoardStageId | null;
  readonly stages: ReadonlyArray<Pick<BoardStageDefinition, "stageId">>;
}): number | null {
  if (!input.boardReady || input.width <= 0 || input.resolvedStageId === null) return null;
  const index = input.stages.findIndex((stage) => stage.stageId === input.resolvedStageId);
  return index >= 0 ? index : null;
}

export function cardsInStage(
  cards: ReadonlyArray<BoardCardShell>,
  stageId: string,
): ReadonlyArray<BoardCardShell> {
  return cards
    .filter((card) => card.stage === stageId)
    .slice()
    .sort((left, right) =>
      left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0,
    );
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
