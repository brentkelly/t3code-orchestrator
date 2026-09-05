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
 * is awaiting input, and lights for a split parent whose CHILD is working —
 * the parent runs no step of its own while its sub-board builds.
 */
import {
  boardCardChildAttentionLabel,
  boardCardChildRunningLabel,
  isBoardCardWorking,
  isBoardReviewLoopHeld,
} from "@t3tools/contracts";
import type {
  BoardCardAttention,
  BoardCardAttentionReason,
  BoardCardAttentionTone,
  BoardCardChildAttention,
  BoardCardShell,
  BoardCardThreadShell,
  BoardLabel,
  BoardLabelId,
  ThreadId,
} from "@t3tools/contracts";
import { LayersIcon, LockIcon, PauseIcon, TriangleAlertIcon } from "lucide-react";
import type { DragEvent, ReactNode } from "react";

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
  BoardCardPlansRow,
  BoardCardReviewBlock,
  BoardCardSummaryRow,
  BoardCardTodoStrip,
  BoardCardTodoThreadRow,
} from "./BoardCardSummaryRow";
import { projectAccent } from "./projectAccent";
import { BoardHint } from "./BoardHint";

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

/**
 * The three attention tones as card-level treatments: border, fill tint, and
 * the 1px ring. One entry per tone rather than a branch per reason — the
 * reason picks the tone (`boardCardAttention`), and the card only ever renders
 * a tone.
 *
 * The tint is a colour-MIX into the card fill, not a translucent overlay, so it
 * reads the same over the light `--card` and the dark lift — a flat `bg-attention/7`
 * would wash out on one of them. Each table is a COMPLETE class per tone
 * because Tailwind resolves competing utilities by stylesheet order, not class
 * order, so a card must carry exactly one border / fill / shadow class.
 */
const TONE_BORDER: Record<BoardCardAttentionTone, string> = {
  danger: "border-destructive/60",
  warning: "border-amber-500/60",
  attention: "border-attention/55",
};

const TONE_TINT: Record<BoardCardAttentionTone, string> = {
  danger:
    "bg-[color-mix(in_srgb,var(--destructive)_9%,var(--card))] dark:bg-[color-mix(in_srgb,var(--destructive)_12%,#1c1c20)]",
  warning:
    "bg-[color-mix(in_srgb,#f59e0b_9%,var(--card))] dark:bg-[color-mix(in_srgb,#f59e0b_11%,#1c1c20)]",
  attention:
    "bg-[color-mix(in_srgb,var(--attention)_7%,var(--card))] dark:bg-[color-mix(in_srgb,var(--attention)_9%,#1c1c20)]",
};

const TONE_RING: Record<BoardCardAttentionTone, string> = {
  danger:
    "shadow-[0_0_0_1px_color-mix(in_srgb,var(--destructive)_45%,transparent)] hover:shadow-[0_0_0_1px_color-mix(in_srgb,var(--destructive)_45%,transparent),0_4px_14px_-8px_rgb(0_0_0/0.35)]",
  warning:
    "shadow-[0_0_0_1px_color-mix(in_srgb,#f59e0b_45%,transparent)] hover:shadow-[0_0_0_1px_color-mix(in_srgb,#f59e0b_45%,transparent),0_4px_14px_-8px_rgb(0_0_0/0.35)]",
  attention:
    "shadow-[0_0_0_1px_color-mix(in_srgb,var(--attention)_40%,transparent)] hover:shadow-[0_0_0_1px_color-mix(in_srgb,var(--attention)_40%,transparent),0_4px_14px_-8px_rgb(0_0_0/0.35)]",
};

/** The chip's leading mark per reason. The violet question keeps its DOT rather
    than an icon — the card reads as "has a thread, and it needs you", the same
    indicator as the running dot in a different colour — while the states where
    nothing is running at all wear an icon. */
const ATTENTION_ICON: Record<BoardCardAttentionReason, ReactNode> = {
  stalled: <TriangleAlertIcon className="size-3" />,
  approval: <LayersIcon className="size-3" />,
  "review-held": <TriangleAlertIcon className="size-3" />,
  held: <PauseIcon className="size-3" />,
  input: <span className="size-2 shrink-0 rounded-full bg-attention" />,
};

/** The chip's own colours, which are text-weight rather than surface-weight —
    the card fill is already carrying the tone. */
const TONE_CHIP: Record<BoardCardAttentionTone, string> = {
  danger: "text-destructive-foreground",
  warning: "text-amber-700 dark:text-amber-300",
  attention: "text-attention-foreground",
};

export function BoardCardContent({
  card,
  labelsById,
  queueSlot,
  selected,
  accentName,
  todos,
  parentKey,
  onOpenSubBoard,
  attention,
  childAttention,
  childRunning,
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
      the plan row's drill-in chip as a live button, and only where the
      handler is supplied (the live root board — not the ghost, not the
      archive sheet, where the chip is a static twin). */
  readonly onOpenSubBoard?: (() => void) | undefined;
  /** Why this card is waiting on a human, or null when it is not
      (`boardCardAttention`). Derived client-side by the board page, which is
      the surface that holds the stage list; absent on the surfaces that do not
      resolve it (the drag ghost, the archive sheet), where the card renders as
      it always did. */
  readonly attention?: BoardCardAttention | null | undefined;
  /** The same question asked of this card's CHILDREN (`deriveBoardCardChildAttention`).
      A split parent builds through its children, so one stuck child blocks the
      parent too and the parent wears the child's tone. */
  readonly childAttention?: BoardCardChildAttention | undefined;
  /** How many of this card's CHILDREN are working right now
      (`deriveBoardCardChildRunning`), which is what lights the working dot on a
      parent that runs no step of its own. Absent on the surfaces that do not
      resolve it (the drag ghost, the archive sheet). */
  readonly childRunning?: number | undefined;
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
  // Exactly one progress block per card (D8), with review outranking subcards
  // outranking todos — so a card in code review shows the loop reading its
  // merged branch, not a finished child's plan bar or a todo strip.
  const progress = boardCardProgressBlock(summary, winner, {
    liveThreadCount: todoThreads.length,
    winnerStopped: winner === null ? undefined : stateOf(winner.threadId)?.stopped,
  });
  const otherThreads =
    progress.kind === "todos" && todos?.expanded === true
      ? todoThreads.filter((entry) => entry.threadId !== progress.todo.threadId)
      : EMPTY_TODO_THREADS;
  // The card's own turn wins the dot's wording; a parent with nothing running
  // of its own borrows its children's, counted.
  const workingLabel = isBoardCardWorking(card)
    ? "Thread running"
    : childRunning !== undefined && childRunning > 0
      ? boardCardChildRunningLabel(childRunning)
      : null;
  // "This card is waiting on you" — the whole card, not just a badge, so a
  // board of forty cards answers "where am I needed" at a glance (the
  // prototype's treatment: tinted fill, coloured border, a 1px ring). The
  // reason picks the colour: red for a stalled step, amber for a decision, blue
  // for a thread's question — one vocabulary, ranked by `boardCardAttention`.
  //
  // A parent with no problem of its own inherits its worst child's, tone and
  // all: a split parent builds THROUGH its children (t3o-23, D4), so while one
  // is stuck the parent cannot advance either and the board has to say so on
  // both — otherwise the parent reads healthy and the stuck child is buried in
  // a column nobody is looking at.
  //
  // Muting a Done card wins over all of it: a finished card is not asking for
  // anything, whatever its last thread state said.
  const own = summary.muted ? null : (attention ?? null);
  const inherited = summary.muted || own !== null ? null : (childAttention ?? null);
  const flag = own ?? inherited;
  const tone = flag?.tone ?? null;
  // A held review loop already spells itself out in the summary's round row
  // ("No convergence" / "Stopped"), so it tints the card and skips the chip
  // rather than saying the same thing twice. Keyed on the row ACTUALLY being
  // rendered, not on the reason alone: the round row is stage-conditional, so
  // on a board whose review-role stage is not the seed `review` stage the row
  // is absent — and suppressing on the reason would leave the card tinted amber
  // with nothing on it saying why.
  const roundRowExplainsIt = summary.items.some(
    (item) =>
      item.kind === "round" && item.outcome !== undefined && isBoardReviewLoopHeld(item.outcome),
  );
  const chip =
    flag === null || (own !== null && own.reason === "review-held" && roundRowExplainsIt)
      ? null
      : {
          tone: flag.tone,
          label: inherited === null ? flag.label : boardCardChildAttentionLabel(inherited),
          title: inherited === null ? flag.detail : `A child of this card: ${inherited.detail}`,
          icon: ATTENTION_ICON[flag.reason],
        };
  // A split parent wears the stack (t3o-25, AC1): the card reads as the top
  // sheet of a pile. Purely visual now — the drill-in affordance is the plan
  // row's chip — so it keys off `planTotal` alone and the drag ghost / archive
  // sheet keep the pile.
  const wearsStack = card.planTotal !== undefined && card.planTotal > 0;
  return (
    <article
      className={cn(
        // `transition-colors` alone could not animate the lift — box-shadow is
        // not a colour property, so the hover shadow snapped in. Transition
        // both; the hover lift itself rides the per-state shadow branch below.
        "flex cursor-pointer flex-col gap-1.5 rounded-[10px] border px-[11px] py-2.5 transition-[color,background-color,border-color,box-shadow] duration-[120ms] ease-[ease]",
        // One border class, chosen here rather than layered: Tailwind resolves
        // competing `border-*` utilities by stylesheet order, not by the order
        // they appear in the class list, so stacking them decides nothing.
        // Selection darkens the card's own border rather than adding a ring:
        // `ring-2 ring-ring` painted the accent blue outside the card and read
        // as a focus ring on click.
        selected ? "border-foreground/40" : tone === null ? "border-border" : TONE_BORDER[tone],
        // The tint is a colour-MIX into the card fill, not a translucent
        // overlay, so it reads the same over the light `--card` and the dark
        // lift below — a flat `bg-attention/7` would wash out on one of them.
        // `dark:bg-[#1c1c20]` lifts the card above the column beneath it. The
        // stock `--card` in dark is ~3% off the page background, which landed
        // BELOW the column's fill and left cards darker than the board.
        tone === null ? "bg-card hover:border-foreground/18 dark:bg-[#1c1c20]" : TONE_TINT[tone],
        // Done recedes: finished work is muted and lower-contrast (D15 stage).
        summary.muted && "bg-card/60 opacity-70",
        // EXACTLY one box-shadow branch per card — shadow utilities conflict by
        // stylesheet order, not class order, so each state carries its own
        // resting AND hover shadow. Precedence is the prototype's: the stack
        // beats the approval/awaiting ring beats the resting shadow.
        //
        // The stacked-sheet edges (t3o-25, AC1) are the prototype's: two full
        // card-coloured sheets each closed by a 1px border line — not grey
        // underlines, which read as bars rather than cards. `--sheet` tracks
        // the card fill (`dark:bg-[#1c1c20]` above, where `--card` is wrong in
        // dark), and the pile gets the prototype's 8px of breathing room below.
        wearsStack
          ? "mb-2 [--sheet:var(--card)] dark:[--sheet:#1c1c20] shadow-[0_5px_0_-1px_var(--sheet),0_5px_0_0_var(--border),0_10px_0_-2px_var(--sheet),0_10px_0_-1px_var(--border)] hover:shadow-[0_4px_14px_-8px_rgb(0_0_0/0.35),0_5px_0_-1px_var(--sheet),0_5px_0_0_var(--border),0_10px_0_-2px_var(--sheet),0_10px_0_-1px_var(--border)]"
          : tone === null
            ? "shadow-xs/5 hover:shadow-[0_4px_14px_-8px_rgb(0_0_0/0.35)]"
            : TONE_RING[tone],
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
          <BoardHint label={`Part of ${parentKey}'s sub-board`}>
            <span className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              <LayersIcon className="mr-0.5 size-2.5" />
              {parentKey}
            </span>
          </BoardHint>
        ) : null}
        {workingLabel === null ? null : (
          // Blue while the agent is working — green is reserved for done, and
          // nothing else on the board may wear it. `isBoardCardWorking` covers
          // both halves: `threadState === "working"` lights only while a single
          // linked thread is mid-turn, and `stepRunning` is the durable one —
          // true for a card's whole admitted-and-running step — so a loop stage
          // (Code review's review/triage/adjudicate phases run as separate
          // short-lived threads) stays lit across the per-phase spin-up gaps and
          // goes dark only when genuinely queued, stalled, awaiting input or
          // done. It pulses so "working" reads at a glance; a slow opacity fade
          // (`animate-pulse`), not a spinner — no per-frame layout, so it stays
          // cheap on high-refresh displays.
          //
          // A split parent lights the SAME dot for a working child: it builds
          // THROUGH its children and runs no step of its own while they go, so
          // without the roll-up it reads identically whether the split is
          // moving or the whole thing is queued behind a slot — which is the
          // one distinction this dot exists to make. Only the tooltip differs.
          <BoardHint label={workingLabel}>
            <span
              aria-label={workingLabel}
              role="img"
              className="size-2 shrink-0 animate-pulse rounded-full bg-info"
            />
          </BoardHint>
        )}
        {chip === null ? null : (
          // ONE chip, whatever the reason: the card face has room for a single
          // status word, and rendering two was what let "Stalled" and "Input
          // needed" fight for the same slot. `boardCardAttention` already
          // ranked them, so the chip just says what won — and on a parent with
          // no problem of its own, it names the child that has one.
          <BoardHint label={chip.title}>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold",
                TONE_CHIP[chip.tone],
              )}
            >
              {chip.icon}
              {chip.label}
            </span>
          </BoardHint>
        )}
        <span className="flex-1" />
        {queueSlot !== undefined ? (
          <BoardHint
            label={
              queueSlot.startsNext
                ? "Queued — starts next"
                : `Queued — position ${queueSlot.position}`
            }
          >
            <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              {queueSlot.startsNext ? "Next" : `Queued #${queueSlot.position}`}
            </span>
          </BoardHint>
        ) : null}
        {card.blocked ? (
          // Only the GATE lives up here (it starts at Ready, D18). A card
          // carries dependencies long before they gate it, and that count is
          // now the meta row's chain icon — one place, every stage, and never
          // mistaken for the warning-coloured gate.
          <BoardHint
            label={`Blocked by ${card.dependencyCount} ${card.dependencyCount === 1 ? "dependency" : "dependencies"}`}
          >
            <span
              aria-label={`Blocked by ${card.dependencyCount} ${card.dependencyCount === 1 ? "dependency" : "dependencies"}`}
              className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium text-warning-foreground"
            >
              <LockIcon className="size-3" />
              Blocked
            </span>
          </BoardHint>
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
      {progress.kind === "review" ? (
        // The review ledger is the card's progress block while it sits in code
        // review — even for a split parent, whose plan bar it outranks (D8).
        <BoardCardReviewBlock items={progress.items} />
      ) : null}
      {progress.kind === "subcards"
        ? // The plan bar with its drill-in chip (t3o-25, AC2) — the D8 progress
          // block a split parent shows. The chip is the sub-board door where the
          // handler is supplied (the live root board); elsewhere it is static.
          (() => {
            const plans = progress.items.find((item) => item.kind === "plans");
            return plans === undefined ? null : (
              <BoardCardPlansRow
                done={plans.done}
                onOpen={onOpenSubBoard}
                statuses={plans.statuses}
                total={plans.total}
              />
            );
          })()
        : null}
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
  attention,
  childAttention,
  childRunning,
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
  readonly attention?: BoardCardAttention | null | undefined;
  readonly childAttention?: BoardCardChildAttention | undefined;
  readonly childRunning?: number | undefined;
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
        attention={attention}
        childAttention={childAttention}
        childRunning={childRunning}
      />
    </div>
  );
}
