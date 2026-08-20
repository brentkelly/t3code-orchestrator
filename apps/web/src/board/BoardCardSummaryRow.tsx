/**
 * T3o stage-specific summary row (t3o-06). Renders the `BoardCardSummaryItem`s
 * `boardCardSummary` derives from a `BoardCardShell` — plan pips, review round
 * pips, the severity triple (with the tooltip that makes three bare numbers
 * mean something), the issue tally, PR and attachment counts.
 *
 * Static presentation only: no animations (upstream AGENTS.md — repainting
 * loops peg the GPU on high-refresh displays). The row renders nothing when
 * `items` is empty, so a stage with no data adds no height to the card.
 */
import type { BoardCardThreadShell } from "@t3tools/contracts";
import {
  BOARD_THREAD_TODO_STATUS_DONE,
  BOARD_THREAD_TODO_STATUS_IN_PROGRESS,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, GitPullRequestIcon, PaperclipIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { formatRelativeTime } from "../timestampFormat";
import type { BoardCardSummaryItem } from "./boardCardSummary";

/** Max pips rendered for either the review-round or plan-progress rows, so a
    pathological count cannot blow out the card width. */
const MAX_SUMMARY_PIPS = 6;

function RoundPips({ current, max }: { readonly current: number; readonly max: number }) {
  const shown = Math.min(max, MAX_SUMMARY_PIPS);
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={`Round ${current} of ${max}`}
      aria-label={`Round ${current} of ${max}`}
    >
      <span className="text-[10.5px] font-medium text-muted-foreground">
        Round {current} of {max}
      </span>
      <span className="ml-0.5 inline-flex items-center gap-0.5">
        {Array.from({ length: shown }, (_, index) => (
          <span
            key={index}
            className={cn(
              "size-1.5 rounded-full",
              index < current ? "bg-foreground/70" : "bg-muted-foreground/30",
            )}
          />
        ))}
      </span>
    </span>
  );
}

function PlanPips({ done, total }: { readonly done: number; readonly total: number }) {
  const shown = Math.min(total, MAX_SUMMARY_PIPS);
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={`${done} of ${total} plans done`}
      aria-label={`${done} of ${total} plans done`}
    >
      <span className="inline-flex items-center gap-0.5">
        {Array.from({ length: shown }, (_, index) => (
          <span
            key={index}
            className={cn(
              "size-1.5 rounded-full",
              index < done ? "bg-emerald-500" : "bg-muted-foreground/30",
            )}
          />
        ))}
      </span>
      <span className="ml-0.5 text-[10.5px] font-medium text-muted-foreground">
        {done}/{total} plans
      </span>
    </span>
  );
}

function SeverityTriple({
  critical,
  improvement,
  nitpick,
}: {
  readonly critical: number;
  readonly improvement: number;
  readonly nitpick: number;
}) {
  // Three bare numbers are meaningless to anyone who has not read the spec —
  // the tooltip spells them out (t3o-06 verification).
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-muted px-1.5 text-[10.5px] font-medium tabular-nums"
      title={`${critical} critical · ${improvement} improvements · ${nitpick} nitpicks`}
    >
      <span className="text-red-600 dark:text-red-400">{critical}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-amber-600 dark:text-amber-400">{improvement}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-sky-600 dark:text-sky-400">{nitpick}</span>
    </span>
  );
}

function IssueTally({
  fixed,
  rejected,
  open,
  disputed,
}: {
  readonly fixed: number;
  readonly rejected: number;
  readonly open: number;
  readonly disputed: number;
}) {
  return (
    <span
      className="text-[10.5px] font-medium text-muted-foreground"
      title={`${fixed} fixed · ${rejected} rejected · ${open} open · ${disputed} disputed`}
    >
      {fixed} fixed · {rejected} rejected · {open} open · {disputed} disputed
    </span>
  );
}

function SummaryItem({ item }: { readonly item: BoardCardSummaryItem }) {
  switch (item.kind) {
    case "attachments":
      return (
        <span className="inline-flex items-center gap-0.5 text-[10.5px] font-medium text-muted-foreground">
          <PaperclipIcon className="size-3" />
          {item.count}
        </span>
      );
    case "plans":
      return <PlanPips done={item.done} total={item.total} />;
    case "pr":
      return (
        <span className="inline-flex items-center gap-0.5 text-[10.5px] font-medium text-muted-foreground">
          <GitPullRequestIcon className="size-3" />#{item.number}
        </span>
      );
    case "round":
      return <RoundPips current={item.current} max={item.max} />;
    case "step":
      return (
        <span className="inline-flex items-center rounded bg-muted px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {item.label}
        </span>
      );
    case "severity":
      return (
        <SeverityTriple
          critical={item.critical}
          improvement={item.improvement}
          nitpick={item.nitpick}
        />
      );
    case "issues":
      return (
        <IssueTally
          fixed={item.fixed}
          rejected={item.rejected}
          open={item.open}
          disputed={item.disputed}
        />
      );
  }
}

export function BoardCardSummaryRow({
  items,
}: {
  readonly items: ReadonlyArray<BoardCardSummaryItem>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {items.map((item) => (
        <SummaryItem item={item} key={item.kind} />
      ))}
    </div>
  );
}

// ── Thread todo strip (t3o-18, D4/D5) ──────────────────────────────────

/**
 * One pip per STORED todo item, coloured by that item's real status.
 *
 * Deriving pips from `(done, total, hasDoing)` renders a tidy
 * `[done…][doing][pending…]` fiction that is wrong whenever an agent completes an
 * item out of order — which they do — so the server sends a status STRING and
 * every character renders where it actually is.
 *
 * All stored pips render, at `flex:1`. At 24 items each pip is ~7px on a ~230px
 * card: thin, but it reads as the progress bar it is, and the `2/24` beside it
 * carries the precision. `MAX_SUMMARY_PIPS` is deliberately NOT reused — six pips
 * standing for twenty-four items is actively misleading rather than merely
 * coarse.
 *
 * Static presentation only: no animation (upstream AGENTS.md — repainting loops
 * peg the GPU on high-refresh displays).
 */
export function BoardTodoPips({
  statuses,
  done,
  total,
}: {
  readonly statuses: string;
  readonly done: number;
  readonly total: number;
}) {
  const label = `${done} of ${total} todos done`;
  return (
    <span aria-label={label} className="flex items-center gap-[2px]" title={label}>
      {/* Indexed rather than mapped over the characters: a pip IS its position
          — the row is a positional progress bar and items never reorder within a
          render — which is the same shape `PlanPips` and `RoundPips` use. */}
      {Array.from({ length: statuses.length }, (_, index) => (
        <span
          className={cn(
            "h-[3px] min-w-[2px] flex-1 rounded-full",
            statuses[index] === BOARD_THREAD_TODO_STATUS_DONE
              ? "bg-emerald-500"
              : statuses[index] === BOARD_THREAD_TODO_STATUS_IN_PROGRESS
                ? "bg-info"
                : "bg-muted-foreground/25",
          )}
          key={index}
        />
      ))}
    </span>
  );
}

/** "13m" / "2h" on the item the agent is currently on (D6). Elapsed is anchored
    to the moment the in-progress item's TEXT changed, so reordering and
    insertion do not reset it. */
function todoElapsedLabel(startedAt: string | undefined): string | null {
  if (startedAt === undefined) return null;
  const relative = formatRelativeTime(startedAt);
  return relative === null || relative.suffix === null ? null : relative.value;
}

/**
 * The card's todo strip: the pip row, the honest `done/total` (TRUE counts, even
 * when only 30 pips were stored), the in-progress item, and how long it has been
 * on it.
 *
 * A card with more than one live thread gets a chip carrying the count. The chip
 * adds no height — it sits on the existing meta row — and clicking it expands the
 * other threads WITHOUT opening the card.
 */
export function BoardCardTodoStrip({
  todo,
  otherThreadCount,
  expanded,
  onToggleThreads,
}: {
  readonly todo: BoardCardThreadShell;
  readonly otherThreadCount: number;
  readonly expanded: boolean;
  readonly onToggleThreads?: (() => void) | undefined;
}) {
  const done = todo.todoDone ?? 0;
  const total = todo.todoTotal ?? 0;
  const elapsed = todoElapsedLabel(todo.todoStartedAt);
  return (
    <div className="flex flex-col gap-1">
      <BoardTodoPips done={done} statuses={todo.todoStatuses ?? ""} total={total} />
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-[10.5px] font-medium tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        {todo.todoCurrent === undefined ? null : (
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
            {todo.todoCurrent}
          </span>
        )}
        {elapsed === null ? null : (
          <span
            className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70"
            title="Time on the current todo"
          >
            {elapsed}
          </span>
        )}
        {otherThreadCount > 0 && onToggleThreads !== undefined ? (
          <button
            className="-my-0.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            // The chip must NOT open the card: clicking it expands the other
            // threads in place.
            onClick={(event) => {
              event.stopPropagation();
              onToggleThreads();
            }}
            title={
              expanded
                ? "Hide the other threads on this card"
                : `Show ${otherThreadCount} other ${otherThreadCount === 1 ? "thread" : "threads"}`
            }
            type="button"
          >
            {expanded ? (
              <ChevronDownIcon className="size-2.5" />
            ) : (
              <ChevronRightIcon className="size-2.5" />
            )}
            +{otherThreadCount}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** One non-winning thread, revealed only after the chip is clicked (D8: a second
    thread adds no card height until then). Rendered from what is STORED, so a
    finished list still reads `5/5` here even though the strip above hid it. */
export function BoardCardTodoThreadRow({
  todo,
  title,
}: {
  readonly todo: BoardCardThreadShell;
  readonly title: string;
}) {
  const done = todo.todoDone ?? 0;
  const total = todo.todoTotal ?? 0;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">{title}</span>
      {total === 0 ? null : (
        <span className="shrink-0 text-[10.5px] font-medium tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
      )}
    </div>
  );
}
