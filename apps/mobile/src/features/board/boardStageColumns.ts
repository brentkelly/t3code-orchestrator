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

/** Stable identity for the pager's stage list; a new array of the same ids is the same key. */
export function boardPagerStageKey(
  stages: ReadonlyArray<Pick<BoardStageDefinition, "stageId">>,
): string {
  return stages.map((stage) => stage.stageId).join("\0");
}

export function boardPagerScrollIndex(input: {
  readonly boardReady: boolean;
  readonly width: number;
  readonly resolvedStageId: BoardStageId | null;
  readonly stages: ReadonlyArray<Pick<BoardStageDefinition, "stageId">>;
}): number | null {
  return boardPagerIndexForStageKey({
    boardReady: input.boardReady,
    width: input.width,
    resolvedStageId: input.resolvedStageId,
    stageKey: boardPagerStageKey(input.stages),
  });
}

export function boardPagerIndexForStageKey(input: {
  readonly boardReady: boolean;
  readonly width: number;
  readonly resolvedStageId: BoardStageId | null;
  readonly stageKey: string;
}): number | null {
  if (!input.boardReady || input.width <= 0 || input.resolvedStageId === null) return null;
  if (input.stageKey.length === 0) return null;
  const index = input.stageKey.split("\0").indexOf(input.resolvedStageId);
  return index >= 0 ? index : null;
}

/** Skip scrollToIndex when a board snapshot did not move the page or change its width. */
export function boardPagerShouldScroll(input: {
  readonly index: number | null;
  readonly lastIndex: number | null;
  readonly width: number;
  readonly lastWidth: number;
}): boolean {
  if (input.index === null) return false;
  return input.index !== input.lastIndex || input.width !== input.lastWidth;
}

export function normaliseBoardCardQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function boardCardMatchesQuery(
  card: Pick<BoardCardShell, "key" | "title">,
  normalisedQuery: string,
): boolean {
  if (normalisedQuery.length === 0) return true;
  return (
    card.title.toLowerCase().includes(normalisedQuery) ||
    card.key.toLowerCase().includes(normalisedQuery)
  );
}

export function cardsMatchingBoardQuery<T extends Pick<BoardCardShell, "key" | "title">>(
  cards: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const normalised = normaliseBoardCardQuery(query);
  if (normalised.length === 0) return cards;
  return cards.filter((card) => boardCardMatchesQuery(card, normalised));
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
