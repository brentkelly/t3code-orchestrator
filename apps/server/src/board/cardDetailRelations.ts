/**
 * Which cards an open card's detail embeds, read off the in-memory board, so a card
 * subscription re-reads only for events that can change what it shows (T3O-108).
 */
import type {
  BoardCard,
  BoardCardDependencyRef,
  BoardCardDetail,
  BoardCardId,
  BoardState,
} from "@t3tools/contracts";

import type { BoardEvent } from "./projector.ts";

/** Same depth cap as the SQL ancestor walks: guards a corrupt parent cycle. */
const MAX_ANCESTOR_DEPTH = 64;

const toDependencyRef = (card: BoardCard): BoardCardDependencyRef => ({
  cardId: card.id,
  key: card.key,
  title: card.title,
  stage: card.stage,
  archivedAt: card.archivedAt,
});

/** Cards whose `dependsOn` names this one, archived included, in card-number order:
    the detail's `dependents`, without scanning every row's JSON in SQL. */
export function boardCardDependentRefs(
  board: BoardState,
  cardId: BoardCardId,
): ReadonlyArray<BoardCardDependencyRef> {
  return board.cards
    .filter((card) => card.dependsOn.includes(cardId))
    .sort((left, right) => left.cardNumber - right.cardNumber)
    .map(toDependencyRef);
}

/**
 * Every card id whose change can alter `cardId`'s detail: itself, its dependencies,
 * dependents, children, ancestors and the ancestors' dependencies. `lastSent` adds the
 * cards the last frame showed, so an edge removed since then still wakes the viewer.
 */
export function boardCardDetailRelatedIds(
  board: BoardState | undefined,
  cardId: BoardCardId,
  lastSent: BoardCardDetail | null,
): ReadonlySet<string> {
  const related = new Set<string>([cardId]);
  if (lastSent !== null) {
    for (const ref of lastSent.dependencies) related.add(ref.cardId);
    for (const ref of lastSent.dependents) related.add(ref.cardId);
    for (const ref of lastSent.children) related.add(ref.cardId);
    for (const ref of lastSent.groupDependencies) related.add(ref.cardId);
    if (lastSent.card.parentCardId !== null) related.add(lastSent.card.parentCardId);
  }
  if (board === undefined) return related;
  const byId = new Map(board.cards.map((card) => [card.id as string, card]));
  const self = byId.get(cardId);
  if (self !== undefined) {
    for (const id of self.dependsOn) related.add(id);
    let parentId = self.parentCardId;
    for (let depth = 0; parentId !== null && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      related.add(parentId);
      const parent = byId.get(parentId);
      if (parent === undefined) break;
      for (const id of parent.dependsOn) related.add(id);
      parentId = parent.parentCardId;
    }
  }
  for (const card of board.cards) {
    if (card.parentCardId === cardId || card.dependsOn.includes(cardId)) related.add(card.id);
  }
  return related;
}

/** Whether a board event can change `cardId`'s detail. An event that is not about a
    card (labels, stages, workers, project config) always wakes: conservative by design. */
export function boardCardDetailWakes(
  event: BoardEvent,
  board: BoardState | undefined,
  cardId: BoardCardId,
  lastSent: BoardCardDetail | null,
): boolean {
  if (event.aggregateKind !== "card") return true;
  return boardCardDetailRelatedIds(board, cardId, lastSent).has(event.aggregateId);
}
