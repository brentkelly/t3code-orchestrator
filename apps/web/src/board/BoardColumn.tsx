/**
 * T3o board column (t3o-05): header with count and inline add, a plain card
 * list, and a collapsed rail that stays a drop target.
 *
 * Ordering is native HTML5 drag-and-drop (the prototype's model): the column
 * is a drop zone (`onDragOver`/`onDrop`), and while a card hovers it a dashed
 * placeholder opens a gap at the computed drop index. The previous
 * `@legendapp/list` virtualiser is gone here — its absolute item positioning
 * was incompatible with a live reorder gap; a kanban column's card count is
 * bounded enough to render in full.
 */
import {
  type BoardCardAttention,
  type BoardCardChildAttention,
  type BoardCardShell,
  type BoardLabel,
  type BoardLabelId,
  type BoardStageId,
  type ProjectIconColor,
  type ProjectId,
} from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import { Fragment } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { BoardHint } from "./BoardHint";
import { DraggableBoardCard, type BoardCardTodoContext } from "./BoardCardItem";
import type { BoardQueueInfo } from "./boardQueueInfo";
import type { BoardGroupCardVm } from "./boardGroups";

/** Vertical gap (px) between cards; kept in sync with the list's `gap-2` so
    the drop-index math can subtract the placeholder it inserts. */
export const BOARD_CARD_GAP = 8;

/**
 * The dark-mode column fill, opaque rather than a foreground tint.
 *
 * The board stacks three surfaces — page, column, card — and dark mode needs
 * them strictly increasing in lightness. A translucent tint composites over
 * whatever sits behind it, so the column tint landed ABOVE `--card` and the
 * cards came out darker than the board they sit on. Opaque values fix the
 * order by construction. Light mode keeps the tint, where it reads correctly.
 */
export const BOARD_COLUMN_DARK_SURFACE = "dark:bg-[#131316]";

export interface BoardAddProject {
  readonly id: ProjectId;
  readonly title: string;
}

export interface BoardColumnDragProps {
  /** The card currently being dragged (dimmed in place), or null. */
  readonly draggedCardId: string | null;
  /** Insertion index the placeholder opens at, when the drag is over THIS
      column; null when the drag is elsewhere or absent. */
  readonly dragOverIndex: number | null;
  /** Height (px) of the dragged card, for the placeholder gap. */
  readonly dragHeight: number;
  readonly onColumnDragOver: (stage: BoardStageId, event: DragEvent<HTMLElement>) => void;
  readonly onColumnDrop: (stage: BoardStageId, event: DragEvent<HTMLElement>) => void;
  /** A drag over a REFUSED column (T3O-29): never `preventDefault`ed, so the
      browser shows its no-drop cursor; the page shows why at the pointer. */
  readonly onRefusedDragOver?:
    | ((stage: BoardStageId, refusal: string, event: DragEvent<HTMLElement>) => void)
    | undefined;
  /** The drag left a refused column, so its pointer tip goes. */
  readonly onRefusedDragLeave?: (() => void) | undefined;
  readonly onCardDragStart: (card: BoardCardShell, event: DragEvent<HTMLDivElement>) => void;
  readonly onCardDragEnd: () => void;
  /** Keyboard reorder (Ctrl/Cmd+ArrowUp/Down on a focused card): the pointer
      drag's keyboard analogue, moving the card one visible slot in its column. */
  readonly onCardReorder: (card: BoardCardShell, direction: -1 | 1) => void;
  /** Why the card being dragged cannot land here (T3O-29), or null. A refused
      column draws a dashed outline and never accepts the drop. */
  readonly dropRefusal?: string | null | undefined;
}

export interface BoardColumnProps extends BoardColumnDragProps {
  readonly stage: BoardStageId;
  /** Whether this column IS the merge-role stage (T3O-38, D13). Only there
      does an armed card wear the grey `Auto` glyph — everywhere else an armed
      card is an ordinary card and should look like one. */
  readonly atMergeStage?: boolean | undefined;
  /** Each card's resolved auto-merge arm (T3O-28), read with `atMergeStage`
      to draw the `Auto` glyph. */
  readonly autoMergeArmedFor?: ((card: BoardCardShell) => boolean) | undefined;
  /** The column's display label from the read-model stage list (D13). */
  readonly label: string;
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  readonly collapsed: boolean;
  readonly queueSlots: ReadonlyMap<string, BoardQueueInfo>;
  readonly selectedCardId: string | null;
  /** Projects new cards may be created in; empty hides the add button, which
      also only shows on creation stages (t3o-06a). */
  readonly addProjects: ReadonlyArray<BoardAddProject>;
  /** Resolves a project's icon colour (T3O-4); hash fallback when null. */
  readonly accentNameFor: (projectId: ProjectId) => ProjectIconColor | null;
  /** Resolves a sub-board child's parent key for its chip (t3o-23). */
  readonly parentKeyFor: (cardId: string) => string | undefined;
  /** Why a card is waiting on a human, or null (`boardCardAttention`), and the
      same for its children — both resolved by the page, which holds the stage
      list and the whole card set. */
  readonly attentionFor: (card: BoardCardShell) => BoardCardAttention | null;
  readonly childAttentionFor: (card: BoardCardShell) => BoardCardChildAttention | undefined;
  /** How many of a card's children are working right now
      (`deriveBoardCardChildRunning`) — what lights the working dot on a split
      parent, which runs no step of its own while its children build. */
  readonly childRunningFor: (card: BoardCardShell) => number | undefined;
  /** T3o (T3O-48): whether the card is parked at the merge role with no pull
      request (`boardCardNoPullRequest`). Resolved by the page for the same
      reason `attentionFor` is: the settle grace it applies is keyed on when the
      card's thread went quiet, which is a join across the thread shells only
      the page holds. */
  readonly noPullRequestFor: (card: BoardCardShell) => boolean;
  /** T3O-52: why a finished card kept its worktree, or null
      (`boardCardWorktreeKept`). Resolved by the page, which holds the settings. */
  readonly worktreeKeptFor: (card: BoardCardShell) => string | null;
  /** Thread todo lists for one card (t3o-18) — built once by the page and read
      per card, so the column adds no state of its own. */
  readonly todosFor: (cardId: string) => BoardCardTodoContext;
  readonly onSetCollapsed: (stage: BoardStageId, collapsed: boolean) => void;
  readonly onSelectCard: (card: BoardCardShell) => void;
  /** Opens the create dialog onto this column's stage (t3o-06). */
  readonly onRequestCreate: (stage: BoardStageId) => void;
  /** Drill into a group's board (t3o-25, T3O-29), at any depth. */
  readonly onOpenSubBoard?: ((card: BoardCardShell) => void) | undefined;
  /** A group card's face (T3O-29), or null for a leaf. */
  readonly groupFor?: ((card: BoardCardShell) => BoardGroupCardVm | null) | undefined;
  /** A line under the header, e.g. the Deferred column's rule. */
  readonly hint?: string | undefined;
  /** A control beside the hint, e.g. Deferred's New phase. */
  readonly headerAction?: ReactNode;
}

/** The column's drag-over and drop handlers, which route a refused column to
    `onRefusedDragOver` and drop nothing on it. */
function columnDropHandlers(props: BoardColumnProps) {
  const refusal = props.draggedCardId !== null ? (props.dropRefusal ?? null) : null;
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (refusal !== null) {
        props.onRefusedDragOver?.(props.stage, refusal, event);
        return;
      }
      props.onColumnDragOver(props.stage, event);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (refusal === null) return;
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      props.onRefusedDragLeave?.();
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (refusal !== null) return;
      props.onColumnDrop(props.stage, event);
    },
  };
}

export function BoardColumn(props: BoardColumnProps) {
  return props.collapsed ? <CollapsedColumn {...props} /> : <ExpandedColumn {...props} />;
}

function CollapsedColumn(props: BoardColumnProps) {
  const { stage, label, cards, draggedCardId, dragOverIndex, dropRefusal, onSetCollapsed } = props;
  const dropHandlers = columnDropHandlers(props);
  // The rail stays a drop target so a card can be dropped on a collapsed
  // column (it appends at the column tail).
  const refused = draggedCardId !== null && dropRefusal != null;
  const isOver = draggedCardId !== null && dragOverIndex !== null && !refused;
  return (
    <BoardHint label="Expand column">
      <button
        className={cn(
          // `self-stretch` against the row's `items-start`: a collapsed rail is a
          // full-height target, while expanded columns size to their cards.
          "flex w-11 shrink-0 cursor-pointer flex-col items-center gap-2.5 self-stretch rounded-xl border border-transparent bg-foreground/5 py-2.5 transition-colors hover:bg-foreground/10",
          BOARD_COLUMN_DARK_SURFACE,
          isOver && "border-ring bg-foreground/10 dark:bg-[#1e1e22]",
          refused && "border-dashed border-foreground/30",
        )}
        data-board-drop-refused={refused ? "" : undefined}
        onClick={() => onSetCollapsed(stage, false)}
        onDragLeave={dropHandlers.onDragLeave}
        onDragOver={dropHandlers.onDragOver}
        onDrop={dropHandlers.onDrop}
        type="button"
      >
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="text-[11px] font-medium text-muted-foreground">{cards.length}</span>
        <span className="text-sm font-semibold text-muted-foreground [writing-mode:vertical-rl]">
          {label}
        </span>
      </button>
    </BoardHint>
  );
}

function ExpandedColumn(props: BoardColumnProps) {
  const dropHandlers = columnDropHandlers(props);
  const {
    stage,
    atMergeStage,
    autoMergeArmedFor,
    label,
    cards,
    labelsById,
    queueSlots,
    todosFor,
    selectedCardId,
    addProjects,
    accentNameFor,
    parentKeyFor,
    attentionFor,
    childAttentionFor,
    childRunningFor,
    noPullRequestFor,
    worktreeKeptFor,
    draggedCardId,
    dragOverIndex,
    dragHeight,
    onSetCollapsed,
    onSelectCard,
    onRequestCreate,
    onCardDragStart,
    onCardDragEnd,
    onCardReorder,
    onOpenSubBoard,
    groupFor,
    dropRefusal,
    hint,
    headerAction,
  } = props;
  // Cards may be created only into Backlog, Sprint or Planning (t3o-06a); the
  // add affordance is absent from the other five columns entirely.
  const canAdd = addProjects.length > 0;

  // The placeholder gap: clamp the target index, and suppress it when it lands
  // on the dragged card's own slot (dropping back where it started is a no-op).
  const own = draggedCardId === null ? -1 : cards.findIndex((c) => c.cardId === draggedCardId);
  const at = dragOverIndex === null ? null : Math.max(0, Math.min(cards.length, dragOverIndex));
  const refused = draggedCardId !== null && dropRefusal != null;
  const showPlaceholder = !refused && at !== null && !(own >= 0 && (at === own || at === own + 1));
  const isOver = draggedCardId !== null && dragOverIndex !== null && !refused;

  const placeholder = (
    <div
      data-board-ph
      className="shrink-0 rounded-lg border border-dashed border-foreground/25 bg-foreground/5"
      style={{ height: dragHeight || 62 }}
    />
  );

  return (
    <div
      // The column panel is a tint of the FOREGROUND, not `--muted`: `--muted`
      // is zinc-50, so a muted wash over a near-white page was invisible and
      // the columns read as one undivided sheet.
      // Height follows the cards (with a floor so an empty column is still a
      // visible target), rather than stretching to the viewport. The board row
      // scrolls when a column outgrows it.
      className={cn(
        "flex min-h-[104px] w-[268px] shrink-0 flex-col rounded-xl border border-transparent bg-foreground/5 p-2.5 transition-colors",
        BOARD_COLUMN_DARK_SURFACE,
        isOver && "border-ring/60 bg-foreground/10 dark:bg-[#1e1e22]",
        refused && "border-dashed border-foreground/30",
      )}
      data-board-column={stage}
      data-board-drop-refused={refused ? "" : undefined}
    >
      <div className="group/column-header flex shrink-0 items-center gap-1 px-1 pb-2">
        {/* `hidden` until hover, not `opacity-0`: an invisible button still
            occupies its slot, which left every header permanently indented.
            Taking it out of flow lets the title sit flush and indent only
            while the header is hovered. */}
        <Button
          className="-ml-1 hidden group-hover/column-header:inline-flex"
          onClick={() => onSetCollapsed(stage, true)}
          size="icon-xs"
          title="Collapse column"
          variant="ghost"
        >
          {/* Colour on the icon, not the button: the ghost variant pipes svg
              fill through --control-icon-color, so a class on the button is
              ignored. Lighter than the muted token, which read too heavy. */}
          <ChevronLeftIcon className="text-muted-foreground/70" />
        </Button>
        <span className="truncate text-sm font-semibold text-muted-foreground">{label}</span>
        <span className="flex-1" />
        <span className="text-[11px] font-medium text-muted-foreground">{cards.length}</span>
        {canAdd ? (
          <Button
            onClick={() => onRequestCreate(stage)}
            size="icon-xs"
            title="New card here"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
        ) : null}
      </div>
      {hint === undefined && headerAction == null ? null : (
        <div className="flex shrink-0 items-center gap-2 px-1 pb-2">
          {hint === undefined ? null : (
            <span className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">{hint}</span>
          )}
          {headerAction}
        </div>
      )}
      {/* `flex-1` would stretch the list to the column and reintroduce the
          full-height look; the list is exactly as tall as its cards. It still
          fills the empty-column floor so the whole panel stays a drop target. */}
      <div
        className="flex flex-1 flex-col gap-2"
        onDragLeave={dropHandlers.onDragLeave}
        onDragOver={dropHandlers.onDragOver}
        onDrop={dropHandlers.onDrop}
      >
        {cards.length === 0 && !showPlaceholder ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground">
            No cards
          </div>
        ) : (
          <>
            {cards.map((card, index) => (
              <Fragment key={card.cardId}>
                {showPlaceholder && at === index ? placeholder : null}
                <DraggableBoardCard
                  card={card}
                  labelsById={labelsById}
                  queueSlot={queueSlots.get(card.cardId)}
                  selected={card.cardId === selectedCardId}
                  dragging={card.cardId === draggedCardId}
                  onSelect={onSelectCard}
                  onDragStart={onCardDragStart}
                  onDragEnd={onCardDragEnd}
                  onReorder={onCardReorder}
                  accentName={accentNameFor(card.projectId)}
                  parentKey={parentKeyFor(card.cardId)}
                  attention={attentionFor(card)}
                  atMergeStage={atMergeStage === true}
                  autoMergeArmed={autoMergeArmedFor?.(card)}
                  childAttention={childAttentionFor(card)}
                  childRunning={childRunningFor(card)}
                  noPullRequest={noPullRequestFor(card)}
                  worktreeKeptReason={worktreeKeptFor(card)}
                  todos={todosFor(card.cardId)}
                  onOpenSubBoard={
                    onOpenSubBoard === undefined ? undefined : () => onOpenSubBoard(card)
                  }
                  group={groupFor?.(card) ?? null}
                />
              </Fragment>
            ))}
            {showPlaceholder && at === cards.length ? placeholder : null}
          </>
        )}
      </div>
    </div>
  );
}
