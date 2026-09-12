/**
 * Card-to-card navigation in the detail sheet (T3O-37): the pure half.
 *
 * With a card open you can step to the card before or after it **in the same
 * column**, in board order, without closing the sheet. The sibling list is the
 * board's own `visibleColumns` — scope-, project-, stalled- and query-filtered
 * — so what you step through is exactly what the column is currently showing,
 * with no second filter to drift from the first. Stepping never wraps and
 * never crosses into another column.
 *
 * Everything here is a pure function over data the caller already has: the
 * rails component and `BoardPage` own the React and the routing.
 */
import type { BoardCardShell, BoardStageId } from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";

export interface BoardCardNeighbours {
  /** The stage whose column holds the open card, or null when it holds none. */
  readonly stage: BoardStageId | null;
  /** Index within that column, or -1 when the open card is not visible. */
  readonly index: number;
  /** Length of the open card's column; 0 when it is not visible. */
  readonly total: number;
  readonly prev: BoardCardShell | null;
  readonly next: BoardCardShell | null;
}

const NO_NEIGHBOURS: BoardCardNeighbours = {
  stage: null,
  index: -1,
  total: 0,
  prev: null,
  next: null,
};

/**
 * Neighbours of `cardId` within its own column of `columns`, in board order.
 *
 * A card that is not in `columns` at all — a deep link, or a card the search
 * box or the "Stalled only" filter is currently hiding — resolves to
 * `index: -1` with both neighbours null, which is how the rails and the
 * shortcuts go quiet rather than guessing at a list the user cannot see.
 */
export function resolveBoardCardNeighbours(
  columns: BoardStageColumns,
  cardId: string | null,
): BoardCardNeighbours {
  if (cardId === null) return NO_NEIGHBOURS;
  for (const [stage, cards] of Object.entries(columns)) {
    const index = cards.findIndex((card) => card.cardId === cardId);
    if (index === -1) continue;
    return {
      stage: stage as BoardStageId,
      index,
      total: cards.length,
      prev: index > 0 ? (cards[index - 1] ?? null) : null,
      next: index < cards.length - 1 ? (cards[index + 1] ?? null) : null,
    };
  }
  return NO_NEIGHBOURS;
}

/** -1 steps to the previous card in the column, 1 to the next. */
export type BoardCardStep = -1 | 1;

/**
 * Whether a text caret owns the keystroke: an input, a textarea, a select, or
 * anything contenteditable (which covers the composer's editor and CodeMirror).
 * The arrow keys have to keep moving the caret while you are typing a title, a
 * brief or a message — `J`/`K` are the collision-free path for keyboard users.
 */
export function isBoardTextEntryTarget(element: Element | null): boolean {
  if (element === null) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  // `isContentEditable` rather than the attribute: it is also true inside a
  // contenteditable region, which is where the caret actually sits, and it is
  // simply absent on elements that cannot host one (SVG, and any non-HTML
  // element), so no `instanceof` against a window global is needed.
  return (element as Partial<HTMLElement>).isContentEditable === true;
}

/** The subset of a `KeyboardEvent` the step resolution actually reads. */
export interface BoardCardNavKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
}

/**
 * The step a keystroke asks for, or null when it asks for nothing.
 *
 * `←`/`K` step back, `→`/`J` step forward. Deliberately no `↑`/`↓`: on a card
 * with no thread the focus sits on the dialog itself and those keys are how a
 * keyboard user scrolls a long brief. Held modifiers, auto-repeat (each step
 * opens a fresh card subscription, so holding a key would flood the socket),
 * and a text-entry target all return null.
 *
 * Pure on purpose — the caller passes the active element in rather than this
 * function reaching for `document`.
 */
export function boardCardStepForKey(
  event: BoardCardNavKeyEvent,
  activeElement: Element | null,
): BoardCardStep | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.repeat) return null;
  if (isBoardTextEntryTarget(activeElement)) return null;
  switch (event.key) {
    case "ArrowLeft":
    case "k":
    case "K":
      return -1;
    case "ArrowRight":
    case "j":
    case "J":
      return 1;
    default:
      return null;
  }
}
