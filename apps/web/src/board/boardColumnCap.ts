/**
 * Long columns mount their first cards and a quiet "Show all": a 171-card Done column is
 * mostly history, and mounting it all costs every board render.
 */
import type { BoardCardShell } from "@t3tools/contracts";

export const BOARD_COLUMN_CARD_CAP = 30;

export interface BoardColumnShownCards {
  readonly shown: ReadonlyArray<BoardCardShell>;
  /** The control under the cards: offer the rest, offer to fold back, or nothing. */
  readonly toggle: "show-all" | "show-fewer" | null;
}

/**
 * A card past the cap that the user is acting on (`keepVisible`: the open card, the one being
 * dragged) uncaps the column rather than hiding it; there is nothing to fold back then.
 */
export function boardColumnShownCards(input: {
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly showAll: boolean;
  readonly keepVisible: ReadonlyArray<string | null>;
}): BoardColumnShownCards {
  const { cards, showAll } = input;
  if (cards.length <= BOARD_COLUMN_CARD_CAP) return { shown: cards, toggle: null };
  if (showAll) return { shown: cards, toggle: "show-fewer" };
  const hidden = new Set(cards.slice(BOARD_COLUMN_CARD_CAP).map((card) => String(card.cardId)));
  if (input.keepVisible.some((cardId) => cardId !== null && hidden.has(cardId))) {
    return { shown: cards, toggle: null };
  }
  return { shown: cards.slice(0, BOARD_COLUMN_CARD_CAP), toggle: "show-all" };
}
