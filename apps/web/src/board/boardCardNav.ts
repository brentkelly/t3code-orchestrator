/**
 * Card-to-card stepping in the detail sheet, the pure half. Steps follow the
 * board's own `visibleColumns` in stage order, running across columns and never
 * wrapping.
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
 * Neighbours of `cardId`, reading `columns` in `stageOrder` (the rendered
 * stages; columns have no order of their own). A card not in `columns` resolves
 * to `stage: null` with no neighbours, so the rails and shortcuts go quiet.
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
 * The step a keystroke asks for: Left/K back, Right/J forward. No Up/Down: they
 * scroll a long brief. Modifiers, auto-repeat (each step opens a card
 * subscription) and text-entry targets return null.
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
 * One rail's target, or null. A neighbour's stage without a label degrades to
 * naming the card alone.
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

/** The step to take: null when the key asks for nothing or no card is there. */
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
 * Which card is fullscreen after a step. A step is the only transition that
 * hands fullscreen on; every other way a card opens skips this, so the new card
 * opens windowed.
 */
export function boardCardMaximisedAfterStep(
  maximisedCardId: string | null,
  fromCardId: string | null,
  toCardId: string,
): string | null {
  if (maximisedCardId === null || maximisedCardId !== fromCardId) return maximisedCardId;
  return toCardId;
}
