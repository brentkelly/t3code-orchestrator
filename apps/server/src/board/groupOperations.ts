/**
 * Regrouping gestures (T3O-27) as one shared service: indent, outdent and
 * "group into new" all resolve to the one `board.card.move-cards` primitive,
 * so the list view, keyboard, drag and MCP agree on where cards land. Pure:
 * the decider still validates every move.
 */
import {
  isBoardCardStarted,
  boardStageIndex,
  type BoardCard,
  type BoardCardId,
  type BoardState,
} from "@t3tools/contracts";

/** Where a regroup sends its cards, or why it cannot. */
export type BoardRegroupPlan =
  | {
      readonly kind: "move";
      readonly cardIds: ReadonlyArray<BoardCardId>;
      readonly parentCardId: BoardCardId | null;
      readonly afterCardId?: BoardCardId;
    }
  | { readonly kind: "refused"; readonly reason: string };

/** A group's live children in board order: stage order, then column order. */
export function boardSiblingsInOrder(
  board: BoardState,
  parentCardId: BoardCardId | null,
): ReadonlyArray<BoardCard> {
  return board.cards
    .filter((card) => card.parentCardId === parentCardId && card.archivedAt === null)
    .toSorted(
      (left, right) =>
        boardStageIndex(board, left.stage) - boardStageIndex(board, right.stage) ||
        (left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0),
    );
}

function selection(
  board: BoardState,
  cardIds: ReadonlyArray<BoardCardId>,
): { readonly cards: ReadonlyArray<BoardCard> } | { readonly reason: string } {
  if (cardIds.length === 0) return { reason: "Select cards first." };
  const cards: Array<BoardCard> = [];
  for (const id of cardIds) {
    const card = board.cards.find((candidate) => candidate.id === id);
    if (card === undefined || card.archivedAt !== null) {
      return { reason: `Card '${id}' does not exist or is archived.` };
    }
    cards.push(card);
  }
  const parent = cards[0]!.parentCardId;
  if (cards.some((card) => card.parentCardId !== parent)) {
    return { reason: "Select cards that share a parent." };
  }
  return { cards };
}

/** Indent: under the previous sibling of the first selected card. */
export function boardIndentPlan(
  board: BoardState,
  cardIds: ReadonlyArray<BoardCardId>,
): BoardRegroupPlan {
  const picked = selection(board, cardIds);
  if ("reason" in picked) return { kind: "refused", reason: picked.reason };
  const ids = new Set(picked.cards.map((card) => card.id));
  const siblings = boardSiblingsInOrder(board, picked.cards[0]!.parentCardId);
  const first = siblings.findIndex((card) => ids.has(card.id));
  for (let index = first - 1; index >= 0; index -= 1) {
    const target = siblings[index]!;
    if (!ids.has(target.id)) {
      return {
        kind: "move",
        cardIds: picked.cards.map((card) => card.id),
        parentCardId: target.id,
      };
    }
  }
  return { kind: "refused", reason: "There is nothing above these cards to indent under." };
}

/** Outdent: directly after the parent, one level up. */
export function boardOutdentPlan(
  board: BoardState,
  cardIds: ReadonlyArray<BoardCardId>,
): BoardRegroupPlan {
  const picked = selection(board, cardIds);
  if ("reason" in picked) return { kind: "refused", reason: picked.reason };
  const parentId = picked.cards[0]!.parentCardId;
  if (parentId === null)
    return { kind: "refused", reason: "These cards are already at the top level." };
  const parent = board.cards.find((card) => card.id === parentId);
  if (parent === undefined)
    return { kind: "refused", reason: `Parent '${parentId}' does not exist.` };
  return {
    kind: "move",
    cardIds: picked.cards.map((card) => card.id),
    parentCardId: parent.parentCardId,
    afterCardId: parent.id,
  };
}

/**
 * Group into new: where the new heading goes — beside the selection, under
 * their shared parent — so "Group into new…" never moves the cards anywhere
 * but one level down.
 */
export function boardGroupIntoNewPlan(
  board: BoardState,
  cardIds: ReadonlyArray<BoardCardId>,
):
  | {
      readonly kind: "group";
      readonly parent: BoardCard | null;
      readonly cards: ReadonlyArray<BoardCard>;
    }
  | { readonly kind: "refused"; readonly reason: string } {
  const picked = selection(board, cardIds);
  if ("reason" in picked) return { kind: "refused", reason: picked.reason };
  const parentId = picked.cards[0]!.parentCardId;
  const parent =
    parentId === null ? null : (board.cards.find((card) => card.id === parentId) ?? null);
  return { kind: "group", parent, cards: picked.cards };
}

/**
 * Shared parent (T3O-28, decision 12): a started card cannot become a group,
 * so a new group is made where it sits and it and `cardIds` move in side by
 * side. The started card's merge target is unchanged: the new group inherits.
 */
export function boardSharedParentPlan(
  board: BoardState,
  startedCardId: BoardCardId,
  cardIds: ReadonlyArray<BoardCardId>,
):
  | {
      readonly kind: "share";
      readonly started: BoardCard;
      readonly parentCardId: BoardCardId | null;
      readonly cardIds: ReadonlyArray<BoardCardId>;
    }
  | { readonly kind: "refused"; readonly reason: string } {
  const started = board.cards.find((card) => card.id === startedCardId);
  if (started === undefined || started.archivedAt !== null) {
    return { kind: "refused", reason: `Card '${startedCardId}' does not exist or is archived.` };
  }
  if (!isBoardCardStarted(board, started)) {
    return {
      kind: "refused",
      reason: `Work has not started on '${started.key}'; move the cards into it directly.`,
    };
  }
  const others = cardIds.filter((id) => id !== started.id);
  if (others.length === 0) return { kind: "refused", reason: "Pick the cards to put beside it." };
  return {
    kind: "share",
    started,
    parentCardId: started.parentCardId,
    cardIds: [started.id, ...others],
  };
}
