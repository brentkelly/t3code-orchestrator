/**
 * T3o board column card (t3o-05): the minimal shell — key pill, label chips,
 * state badges, title. The rich summary content (plans, review rounds,
 * attachments) is t3o-06's.
 *
 * State indicators are static state changes, never continuously repainting
 * animations (upstream AGENTS.md: loops peg the GPU on high-refresh
 * displays) — a running thread is a solid dot, not a spinner.
 */
import type {
  BoardCardShell,
  BoardCardThreadShell,
  BoardLabel,
  BoardLabelId,
  ThreadId,
} from "@t3tools/contracts";
import { CircleAlertIcon, LockIcon, TriangleAlertIcon } from "lucide-react";
import type { DragEvent } from "react";

import { cn } from "../lib/utils";
import {
  boardCardProgressBlock,
  boardCardShellThreadState,
  pickBoardCardTodoThread,
  type BoardTodoThreadState,
} from "./boardCardProgressBlock";
import { boardCardSummary } from "./boardCardSummary";
import { BoardLabelChips } from "./BoardLabelChips";
import {
  BoardCardSummaryRow,
  BoardCardTodoStrip,
  BoardCardTodoThreadRow,
} from "./BoardCardSummaryRow";
import { projectAccent } from "./projectAccent";

/** What a card needs to render its todo strip (t3o-18). All of it is joined
    client-side from state the client already holds — `boardCardThreads` off the
    shell snapshot and the thread shells beside it — so `BoardCardShell` gains no
    field and nothing is duplicated onto the wire. */
export interface BoardCardTodoContext {
  /** The card's live-linked threads and their cached lists. */
  readonly threads: ReadonlyArray<BoardCardThreadShell>;
  /** Live state of one thread, for the strip's winner rule (D7). */
  readonly stateOf: (threadId: ThreadId) => BoardTodoThreadState | undefined;
  /** A thread's display title, for the expanded rows. */
  readonly titleOf: (threadId: ThreadId) => string;
  /** Whether the non-winning threads are revealed (client-only, session-scoped
      React state keyed by card id — D9). */
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
}

const EMPTY_TODO_THREADS: ReadonlyArray<BoardCardThreadShell> = [];

export interface BoardCardQueueSlot {
  readonly position: number;
  readonly startsNext: boolean;
}

export function BoardCardContent({
  card,
  labelsById,
  queueSlot,
  selected,
  accentName,
  todos,
}: {
  readonly card: BoardCardShell;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  readonly queueSlot: BoardCardQueueSlot | undefined;
  readonly selected: boolean;
  /** Configured project accent (t3o-07); falls back to the hash colour. */
  readonly accentName?: string | null | undefined;
  /** Thread todo lists (t3o-18). Absent on surfaces that do not carry them
      (the archive sheet, the drag ghost), where the card renders exactly as it
      did before. */
  readonly todos?: BoardCardTodoContext | undefined;
}) {
  const accent = projectAccent(card.projectId, accentName);
  const summary = boardCardSummary(card);
  const todoThreads = todos?.threads ?? EMPTY_TODO_THREADS;
  const stateOf = todos?.stateOf ?? (() => boardCardShellThreadState(card));
  const winner = pickBoardCardTodoThread({
    threads: todoThreads,
    stateOf,
    activeThreadId: card.activeThreadId,
  });
  // Exactly one progress block per card (D8), with subcards outranking review
  // outranking todos — so a parent card's plan pips and a review ledger are never
  // pushed off the card by a todo strip.
  const progress = boardCardProgressBlock(summary, winner, {
    liveThreadCount: todoThreads.length,
    winnerStopped: winner === null ? undefined : stateOf(winner.threadId)?.stopped,
  });
  const otherThreads =
    progress.kind === "todos" && todos?.expanded === true
      ? todoThreads.filter((entry) => entry.threadId !== progress.todo.threadId)
      : EMPTY_TODO_THREADS;
  return (
    <article
      className={cn(
        // `transition-colors` alone could not animate the lift — box-shadow is
        // not a colour property, so the hover shadow snapped in. Transition
        // both, and use the prototype's lifted shadow.
        // `dark:bg-[#1c1c20]` lifts the card above the column beneath it. The
        // stock `--card` in dark is ~3% off the page background, which landed
        // BELOW the column's fill and left cards darker than the board.
        "flex cursor-pointer flex-col gap-1.5 rounded-[10px] border border-border bg-card px-[11px] py-2.5 shadow-xs/5 transition-[color,background-color,border-color,box-shadow] duration-[120ms] ease-[ease] dark:bg-[#1c1c20] hover:border-foreground/18 hover:shadow-[0_4px_14px_-8px_rgb(0_0_0/0.35)]",
        // Selection darkens the card's own border rather than adding a ring:
        // `ring-2 ring-ring` painted the accent blue outside the card and read
        // as a focus ring on click. Blue on a board card means "needs input",
        // and selection is already unmistakable — the detail pane opens.
        selected && "border-foreground/40",
        // Done recedes: finished work is muted and lower-contrast (D15 stage).
        summary.muted && "bg-card/60 opacity-70",
      )}
      data-board-card={card.cardId}
      data-board-card-stage={card.stage}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-semibold tracking-wide",
            accent.pill,
          )}
        >
          {card.key}
        </span>
        {card.threadState === "working" ? (
          <span className="size-2 shrink-0 rounded-full bg-emerald-500" title="Thread running" />
        ) : null}
        {card.stalled ? (
          // Stalled (t3o-17, D3): recovery gave up — loud and distinct from the
          // blue "Input needed", because nobody is working until a human acts.
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-semibold text-destructive-foreground"
            title="Stalled — recovery gave up; needs a human to retry or take over"
          >
            <TriangleAlertIcon className="size-3" />
            Stalled
          </span>
        ) : null}
        {card.awaitingInput ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-info-foreground">
            <CircleAlertIcon className="size-3" />
            Input needed
          </span>
        ) : null}
        <span className="flex-1" />
        {queueSlot !== undefined ? (
          <span
            className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"
            title={
              queueSlot.startsNext
                ? "Queued — starts next"
                : `Queued — position ${queueSlot.position}`
            }
          >
            {queueSlot.startsNext ? "Next" : `Queued #${queueSlot.position}`}
          </span>
        ) : null}
        {card.blocked ? (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-warning-foreground"
            title={`Blocked by ${card.dependencyCount} ${card.dependencyCount === 1 ? "dependency" : "dependencies"}`}
          >
            <LockIcon className="size-3" />
            Blocked
          </span>
        ) : card.dependencyCount > 0 ? (
          // A card carries dependencies long before they gate it — the gate
          // itself starts at Ready (D18). Muted, and a count rather than the
          // word "Blocked", so the badge reads as "this waits on something"
          // and never gets mistaken for the warning-coloured gate above.
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-muted-foreground"
            title={`Depends on ${card.dependencyCount} ${card.dependencyCount === 1 ? "card" : "cards"} — gates from Ready onward`}
          >
            <LockIcon className="size-3" />
            {card.dependencyCount}
          </span>
        ) : null}
      </div>
      {/* Labels sit on their own row beneath the key, so a multi-label card
          reads as a stack of tags and never crowds the status badges. */}
      {card.labelIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <BoardLabelChips labelIds={card.labelIds} labelsById={labelsById} />
        </div>
      ) : null}
      <div
        className={cn(
          "text-[13px]/[1.35] font-medium text-pretty",
          summary.muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {card.title}
      </div>
      <BoardCardSummaryRow items={summary.items} />
      {progress.kind === "todos" ? (
        <BoardCardTodoStrip
          expanded={todos?.expanded ?? false}
          onToggleThreads={todos?.onToggleExpanded}
          otherThreadCount={progress.otherThreadCount}
          todo={progress.todo}
        />
      ) : null}
      {otherThreads.length === 0 ? null : (
        <div className="flex flex-col gap-0.5 border-t border-border/60 pt-1">
          {otherThreads.map((entry) => (
            <BoardCardTodoThreadRow
              key={entry.threadId}
              title={todos?.titleOf(entry.threadId) ?? "Thread"}
              todo={entry}
            />
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * A board card wired for native HTML5 drag-and-drop (the prototype's model).
 * dnd-kit's sortable transforms fought `@legendapp/list`'s absolute
 * positioning — cards vanished mid-drag and no gap opened — so ordering uses
 * the platform drag with a rotated ghost clone (built by the page) and a
 * measured placeholder gap. `dragging` dims the source in place while its
 * clone is what the cursor carries.
 */
export function DraggableBoardCard({
  card,
  labelsById,
  queueSlot,
  selected,
  dragging,
  onSelect,
  onDragStart,
  onDragEnd,
  onReorder,
  accentName,
  todos,
}: {
  readonly card: BoardCardShell;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  readonly queueSlot: BoardCardQueueSlot | undefined;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly onSelect: (card: BoardCardShell) => void;
  readonly onDragStart: (card: BoardCardShell, event: DragEvent<HTMLDivElement>) => void;
  readonly onDragEnd: () => void;
  /** Keyboard analogue of the pointer drag: move one visible slot up/down. */
  readonly onReorder: (card: BoardCardShell, direction: -1 | 1) => void;
  readonly accentName?: string | null | undefined;
  readonly todos?: BoardCardTodoContext | undefined;
}) {
  return (
    // Keyboard path: the card is a focusable button-role element — Enter/Space
    // opens the detail dialog, whose stage actions are real buttons, so moving
    // a card never REQUIRES the pointer drag (which has no keyboard analogue).
    <div
      draggable
      role="button"
      tabIndex={0}
      aria-label={`${card.key} — ${card.title}`}
      className={cn(
        "cursor-grab rounded-xl focus-visible:outline-2 focus-visible:outline-ring",
        dragging && "opacity-40",
      )}
      onClick={() => onSelect(card)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(card);
          return;
        }
        // Ctrl/Cmd+Arrow reorders within the column — plain arrows stay free
        // for scrolling and focus movement. Stage moves ride the detail
        // dialog's stage actions (Enter opens it).
        if (
          (event.ctrlKey || event.metaKey) &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          onReorder(card, event.key === "ArrowUp" ? -1 : 1);
        }
      }}
      onDragStart={(event) => onDragStart(card, event)}
      onDragEnd={onDragEnd}
    >
      <BoardCardContent
        card={card}
        labelsById={labelsById}
        queueSlot={queueSlot}
        selected={selected}
        accentName={accentName}
        todos={todos}
      />
    </div>
  );
}
