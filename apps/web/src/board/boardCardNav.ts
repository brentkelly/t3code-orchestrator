/**
 * Card-to-card navigation in the detail sheet (T3O-37): the pure half.
 *
 * With a card open you can step to the card before or after it **on the whole
 * board**, in board order, without closing the sheet. The sibling list is the
 * board's own `visibleColumns` — scope-, project-, stalled- and query-filtered
 * — read in stage order, so what you step through is exactly what the board is
 * currently showing, with no second filter to drift from the first. Stepping
 * runs off the bottom of one column into the top of the next (T3O-44) and back
 * again, and never wraps: only the first card of the first stage has no
 * previous, only the last card of the last stage has no next.
 *
 * Everything here is a pure function over data the caller already has: the
 * rails component and `BoardPage` own the React and the routing.
 */
import type { BoardCardShell, BoardStageId } from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";

export interface BoardCardNeighbours {
  /** The stage whose column holds the open card. Null — and both neighbours
      null with it — when the board is not showing that card at all. */
  readonly stage: BoardStageId | null;
  readonly prev: BoardCardShell | null;
  readonly next: BoardCardShell | null;
}

const NO_NEIGHBOURS: BoardCardNeighbours = { stage: null, prev: null, next: null };

/**
 * Neighbours of `cardId` across `columns`, read in `stageOrder`.
 *
 * `stageOrder` is the ordered list of stages the board is RENDERING, which is
 * what makes the step follow the columns left to right: a `BoardStageColumns`
 * is keyed by stage id with no order of its own, and a sub-board renders only
 * the stages from its materialisation floor onward. A stage missing from
 * `stageOrder`, or holding no cards, is simply not stepped through.
 *
 * A card that is not in `columns` at all — a deep link, or a card the search
 * box or the "Stalled only" filter is currently hiding — resolves to
 * `stage: null` with both neighbours null, which is how the rails and the
 * shortcuts go quiet rather than guessing at a list the user cannot see.
 */
export function resolveBoardCardNeighbours(
  columns: BoardStageColumns,
  stageOrder: ReadonlyArray<BoardStageId>,
  cardId: string | null,
): BoardCardNeighbours {
  if (cardId === null) return NO_NEIGHBOURS;
  // One walk, holding the card before the open one and stopping at the card
  // after it: the two cards the rails need are the only reason to walk at all,
  // so a board of any size is half a pass and no allocation.
  let previous: BoardCardShell | null = null;
  let stage: BoardStageId | null = null;
  for (const stageId of stageOrder) {
    for (const card of columns[stageId] ?? []) {
      if (stage !== null) return { stage, prev: previous, next: card };
      if (card.cardId === cardId) stage = stageId;
      else previous = card;
    }
  }
  return stage === null ? NO_NEIGHBOURS : { stage, prev: previous, next: null };
}

/** -1 steps to the previous card in board order, 1 to the next. */
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

/** What a rail needs to name its target card: the card's own face, plus the
    column it sits in when the step is about to leave this one. */
export interface BoardCardNavTarget {
  readonly key: string;
  readonly title: string;
  /** The target's stage label when the step CROSSES stages, null when it stays
      in this column. A step out of a column is the one thing about stepping a
      user cannot see coming from behind the sheet, so the rail says it. */
  readonly stageLabel: string | null;
}

/**
 * One rail's target (T3O-44): the neighbour card as the rail names it, or null
 * when there is no card that way.
 *
 * `fromStage` is the open card's stage and `stageLabels` maps stage id to the
 * label the columns are headed with, so an unlabelled stage — one the board is
 * not rendering, which a neighbour never is — degrades to naming the card
 * alone rather than inventing a column name.
 */
export function boardCardNavTarget(
  card: Pick<BoardCardShell, "key" | "title" | "stage"> | null,
  fromStage: BoardStageId | null,
  stageLabels: ReadonlyMap<string, string>,
): BoardCardNavTarget | null {
  if (card === null) return null;
  return {
    key: card.key,
    title: card.title,
    stageLabel: card.stage === fromStage ? null : (stageLabels.get(card.stage) ?? null),
  };
}

export interface BoardCardNav {
  readonly prev: BoardCardNavTarget | null;
  readonly next: BoardCardNavTarget | null;
  readonly onStep: (direction: BoardCardStep) => void;
}

/**
 * The step a keystroke should actually take, given what is open: null when the
 * keystroke asks for nothing, and null again when it asks for a card that is
 * not there — the end of the board, where the rail is absent too.
 *
 * This is the whole decision the sheet's key handler makes; it takes the
 * keystroke no further than that, so the handler is four lines of DOM.
 */
export function boardCardNavStep(
  nav: Pick<BoardCardNav, "prev" | "next"> | null,
  event: BoardCardNavKeyEvent,
  activeElement: Element | null,
): BoardCardStep | null {
  if (nav === null) return null;
  const step = boardCardStepForKey(event, activeElement);
  if (step === null) return null;
  return (step === -1 ? nav.prev : nav.next) === null ? null : step;
}

/**
 * Which card should be fullscreen after a step from `fromCardId` to
 * `toCardId`, given which card is fullscreen now (T3O-37, D5).
 *
 * Fullscreen belongs to the card the user maximised, and a step is the one
 * transition that hands it over — being thrown back into a window mid-read is
 * not a reset anybody asked for. Every OTHER way a card opens (a deep link, a
 * sub-board drill, clicking a different card) simply never calls this, so the
 * stored id stays on the card it was left on and the newly opened card, not
 * matching it, opens windowed.
 */
export function boardCardMaximisedAfterStep(
  maximisedCardId: string | null,
  fromCardId: string | null,
  toCardId: string,
): string | null {
  if (maximisedCardId === null || maximisedCardId !== fromCardId) return maximisedCardId;
  return toCardId;
}
