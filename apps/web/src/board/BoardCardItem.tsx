/**
 * T3o board column card (t3o-05): the minimal shell — key pill, label chips,
 * state badges, title. The rich summary content (plans, review rounds,
 * attachments) is t3o-06's.
 *
 * State indicators are static state changes with one deliberate exception: the
 * "working" dot slowly pulses (an opacity fade, not a spinner — no per-frame
 * layout, so it stays cheap on high-refresh displays; upstream AGENTS.md warns
 * against transform/loop animations that peg the GPU) so an actively-worked card
 * reads at a glance. The same dot slot turns to a static blue dot when the card
 * is awaiting input.
 */
import type {
  BoardCardShell,
  BoardCardThreadShell,
  BoardLabel,
  BoardLabelId,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronRightIcon, LayersIcon, LockIcon, TriangleAlertIcon } from "lucide-react";
import type { DragEvent } from "react";

import { cn } from "../lib/utils";
import {
  boardCardProgressBlock,
  boardCardShellThreadState,
  pickBoardCardTodoThread,
  type BoardTodoThreadState,
} from "./boardCardProgressBlock";
import { boardCardMeta, boardCardSummary } from "./boardCardSummary";
import { BoardLabelChips } from "./BoardLabelChips";
import {
  BoardCardMetaRow,
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
  parentKey,
  onOpenSubBoard,
}: {
  readonly card: BoardCardShell;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  readonly queueSlot: BoardCardQueueSlot | undefined;
  readonly selected: boolean;
  /** The parent card's key when this is a sub-board child (t3o-23); absent on
      surfaces that do not resolve it (the drag ghost, the archive sheet). */
  readonly parentKey?: string | undefined;
  /** Configured project accent (t3o-07); falls back to the hash colour. */
  readonly accentName?: string | null | undefined;
  /** Thread todo lists (t3o-18). Absent on surfaces that do not carry them
      (the archive sheet, the drag ghost), where the card renders exactly as it
      did before. */
  readonly todos?: BoardCardTodoContext | undefined;
  /** Drill into this card's sub-board (t3o-25). Only a split parent renders
      the stack affordance, and only where the handler is supplied (the live
      root board — not the ghost, not the archive sheet). */
  readonly onOpenSubBoard?: (() => void) | undefined;
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
  // Blue means "this card is waiting on you" — the whole card, not just the
  // badge, so a board of forty cards answers "where am I needed" at a glance
  // (the prototype's treatment: tinted fill, info border, a 1px info ring).
  // Muting a Done card wins over it: a finished card is not asking for
  // anything, whatever its last thread state said.
  const awaiting = card.awaitingInput && !summary.muted;
  // A split parent wears the stack (t3o-25, AC1): the card reads as the top
  // sheet of a pile, and the strip below drills into the sub-board. Both key
  // off the client-derived `planTotal`, exactly like the pips.
  const wearsStack =
    onOpenSubBoard !== undefined && card.planTotal !== undefined && card.planTotal > 0;
  return (
    <article
      className={cn(
        // `transition-colors` alone could not animate the lift — box-shadow is
        // not a colour property, so the hover shadow snapped in. Transition
        // both, and use the prototype's lifted shadow.
        "flex cursor-pointer flex-col gap-1.5 rounded-[10px] border px-[11px] py-2.5 transition-[color,background-color,border-color,box-shadow] duration-[120ms] ease-[ease] hover:shadow-[0_4px_14px_-8px_rgb(0_0_0/0.35)]",
        // One border class, chosen here rather than layered: Tailwind resolves
        // competing `border-*` utilities by stylesheet order, not by the order
        // they appear in the class list, so stacking them decides nothing.
        // Selection darkens the card's own border rather than adding a ring:
        // `ring-2 ring-ring` painted the accent blue outside the card and read
        // as a focus ring on click.
        selected ? "border-foreground/40" : awaiting ? "border-info/55" : "border-border",
        // The tint is a colour-MIX into the card fill, not a translucent
        // overlay, so it reads the same over the light `--card` and the dark
        // lift below — a flat `bg-info/7` would wash out on one of them.
        // `dark:bg-[#1c1c20]` lifts the card above the column beneath it. The
        // stock `--card` in dark is ~3% off the page background, which landed
        // BELOW the column's fill and left cards darker than the board.
        awaiting
          ? "bg-[color-mix(in_srgb,var(--info)_7%,var(--card))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--info)_40%,transparent)] dark:bg-[color-mix(in_srgb,var(--info)_9%,#1c1c20)]"
          : "bg-card shadow-xs/5 hover:border-foreground/18 dark:bg-[#1c1c20]",
        // Done recedes: finished work is muted and lower-contrast (D15 stage).
        summary.muted && "bg-card/60 opacity-70",
        // The stacked-sheet edges: two offset underlines painted with
        // box-shadow, so the pile costs no layout and never disturbs the
        // drag-index math (shadows paint into the existing card gap).
        wearsStack &&
          "shadow-[0_5px_0_-2px_color-mix(in_srgb,var(--foreground)_16%,var(--background)),0_9px_0_-5px_color-mix(in_srgb,var(--foreground)_9%,var(--background))]",
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
        {parentKey !== undefined ? (
          // Sub-board membership (t3o-23): a child card names its parent so a
          // mixed column still reads as a whole. The chip is informational —
          // navigation stays the card click; drill-in is t3o-25.
          <span
            className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"
            title={`Part of ${parentKey}'s sub-board`}
          >
            <LayersIcon className="mr-0.5 size-2.5" />
            {parentKey}
          </span>
        ) : null}
        {card.threadState === "working" || card.stepRunning ? (
          // Green while the agent is working. `threadState === "working"` lights
          // only while a single linked thread is mid-turn; `stepRunning` is the
          // durable half — true for a card's whole admitted-and-running step — so
          // a loop stage (Code review's review/triage/adjudicate phases run as
          // separate short-lived threads) stays lit across the per-phase spin-up
          // gaps and goes dark only when genuinely queued, stalled, awaiting
          // input or done. It pulses so "working" reads at a glance; a slow
          // opacity fade (`animate-pulse`), not a spinner — no per-frame layout,
          // so it stays cheap on high-refresh displays.
          <span
            className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
            title="Thread running"
          />
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
          // A blue dot in the running-dot's slot, not an icon: the card reads
          // as "has a thread, and it needs you" — same indicator, different
          // colour — with the "Input needed" label spelling it out.
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-info-foreground">
            <span className="size-2 shrink-0 rounded-full bg-info" title="Input needed" />
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
          // Only the GATE lives up here (it starts at Ready, D18). A card
          // carries dependencies long before they gate it, and that count is
          // now the meta row's chain icon — one place, every stage, and never
          // mistaken for the warning-coloured gate.
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-warning-foreground"
            title={`Blocked by ${card.dependencyCount} ${card.dependencyCount === 1 ? "dependency" : "dependencies"}`}
          >
            <LockIcon className="size-3" />
            Blocked
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
      {/* Last, always: the meta row is the card's footer, so it sits below the
          stage summary and the todo strip however tall those grow. */}
      <BoardCardMetaRow meta={boardCardMeta(card, todoThreads.length)} />
      {wearsStack ? (
        // The drill-in door (t3o-25, AC2). A real button so it is focusable
        // on its own; clicks and keys stop here so the card underneath does
        // not also open its detail sheet.
        <button
          className="mt-0.5 flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            onOpenSubBoard();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          title="Open this card's sub-board"
          type="button"
        >
          <LayersIcon className="size-3" />
          {card.planTotal} {card.planTotal === 1 ? "card" : "cards"}
          {card.planDone !== undefined && card.planDone > 0 ? ` · ${card.planDone} done` : ""}
          <span className="flex-1" />
          <ChevronRightIcon className="size-3" />
        </button>
      ) : null}
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
  parentKey,
  onOpenSubBoard,
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
  readonly parentKey?: string | undefined;
  readonly onOpenSubBoard?: (() => void) | undefined;
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
        parentKey={parentKey}
        onOpenSubBoard={onOpenSubBoard}
      />
    </div>
  );
}
