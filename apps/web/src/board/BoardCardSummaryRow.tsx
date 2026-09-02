/**
 * T3o card summary rows (t3o-06). Two of them:
 *
 * `BoardCardSummaryRow` renders the `BoardCardSummaryItem`s `boardCardSummary`
 * derives from a `BoardCardShell` — plan pips, review round pips, the severity
 * triple (with the tooltip that makes three bare numbers mean something), the
 * issue tally, attachment counts — and changes with the card's stage.
 *
 * `BoardCardMetaRow` is the stage-independent footer: dependencies, agent
 * threads, plans and the pull request as icon+count pairs, with the brief's
 * image flag pushed to the far end.
 *
 * Static presentation only: no animations (upstream AGENTS.md — repainting
 * loops peg the GPU on high-refresh displays). Either row renders nothing when
 * it has nothing to say, so a card with no data adds no height.
 */
import {
  isBoardReviewLoopHeld,
  type BoardCardThreadShell,
  type BoardReviewLoopOutcome,
} from "@t3tools/contracts";
import {
  BOARD_THREAD_TODO_STATUS_DONE,
  BOARD_THREAD_TODO_STATUS_IN_PROGRESS,
  BOARD_THREAD_TODO_STATUS_PENDING,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GitPullRequestIcon,
  ImageIcon,
  Link2Icon,
  ListIcon,
  MessageSquareIcon,
  PaperclipIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../lib/utils";
import { formatRelativeTime } from "../timestampFormat";
import type { BoardCardMeta, BoardCardSummaryItem } from "./boardCardSummary";
import { BoardHint } from "./BoardHint";

/** Max pips rendered for either the review-round or plan-progress rows, so a
    pathological count cannot blow out the card width. */
const MAX_SUMMARY_PIPS = 6;

/**
 * The review-round pips, plus the flag a loop that never converged carries
 * (t3o-22, D7/D9).
 *
 * "Round 5 of 5, 12 raised, 7 fixed" describes a loop that PASSED and a loop
 * that ran out of road in exactly the same numbers, so the counts cannot be
 * left to speak for themselves. A held loop tints EVERY pip — the finding is
 * about the loop, not about round 5 — and says so in words beside them.
 */
function RoundPips({
  current,
  max,
  outcome,
}: {
  readonly current: number;
  /** Absent when the producer could not see the budget — the row then reports
      the round reached rather than inventing a total. */
  readonly max: number | undefined;
  readonly outcome: BoardReviewLoopOutcome | undefined;
}) {
  const shown = Math.min(max ?? current, MAX_SUMMARY_PIPS);
  const held = outcome !== undefined && isBoardReviewLoopHeld(outcome);
  const rounds = max === undefined ? `Round ${current}` : `Round ${current} of ${max}`;
  const label = `${rounds}${
    held ? (outcome === "stopped" ? " — stopped, no convergence" : " — no convergence") : ""
  }`;
  return (
    <BoardHint label={label}>
      <span className="inline-flex items-center gap-0.5" aria-label={label}>
        <span className="text-[10.5px] font-medium text-muted-foreground">{rounds}</span>
        <span className="ml-0.5 inline-flex items-center gap-0.5">
          {Array.from({ length: shown }, (_, index) => (
            <span
              key={index}
              className={cn(
                "size-1.5 rounded-full",
                held
                  ? "bg-amber-500/70"
                  : index < current
                    ? "bg-foreground/70"
                    : "bg-muted-foreground/30",
              )}
            />
          ))}
        </span>
        {held ? (
          <span className="ml-1 inline-flex items-center rounded bg-amber-500/18 px-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
            {outcome === "stopped" ? "Stopped" : "No convergence"}
          </span>
        ) : null}
      </span>
    </BoardHint>
  );
}

/**
 * The split parent's plan bar (t3o-25, prototype `hasPlans`): one segment per
 * child plan card at `flex:1`, coloured by where that plan stands — done,
 * started (at or after the build role), not started — with the drill-in chip
 * on the right. This row IS the sub-board affordance: the chip replaces the
 * old full-width "N cards" footer button the prototype never had.
 *
 * `statuses` is the derived `d`/`i`/`p` string; a shell that was never
 * decorated with it (the archive sheet) falls back to done-then-pending from
 * the counts. Without `onOpen` (the drag ghost, the archive sheet) the chip
 * renders as a static twin so the card face does not reflow between surfaces.
 */
export function BoardCardPlansRow({
  done,
  total,
  statuses,
  onOpen,
}: {
  readonly done: number;
  readonly total: number;
  readonly statuses: string | undefined;
  readonly onOpen?: (() => void) | undefined;
}) {
  const chars =
    statuses !== undefined && statuses.length === total
      ? statuses
      : BOARD_THREAD_TODO_STATUS_DONE.repeat(Math.min(done, total)) +
        BOARD_THREAD_TODO_STATUS_PENDING.repeat(Math.max(0, total - done));
  const label = `${done}/${total} plans`;
  const chipClass =
    "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 text-[10.5px] font-medium text-muted-foreground";
  const chipBody = (
    <>
      {label}
      <ChevronRightIcon className="size-3" />
    </>
  );
  return (
    <BoardHint label={`${done} of ${total} plans done`}>
      <div aria-label={`${done} of ${total} plans done`} className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-[3px]">
          {Array.from(chars, (status, index) => (
            <span
              className={cn(
                "h-[3px] min-w-[2px] flex-1 rounded-[2px]",
                status === BOARD_THREAD_TODO_STATUS_DONE
                  ? "bg-emerald-500"
                  : status === BOARD_THREAD_TODO_STATUS_IN_PROGRESS
                    ? "bg-info/60"
                    : "bg-muted-foreground/25",
              )}
              key={index}
            />
          ))}
        </span>
        {onOpen === undefined ? (
          <span className={chipClass}>{chipBody}</span>
        ) : (
          // A real button so it is focusable on its own; clicks and keys stop
          // here so the card underneath does not also open its detail sheet.
          <BoardHint label="Open this card's sub-board">
            <button
              className={cn(
                chipClass,
                "cursor-pointer transition-colors hover:bg-accent hover:text-foreground",
              )}
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
              type="button"
            >
              {chipBody}
            </button>
          </BoardHint>
        )}
      </div>
    </BoardHint>
  );
}

/** Exported for the sub-board parent header (t3o-25, D2), which wears the
    same pips the parent's card face does. */
export function PlanPips({ done, total }: { readonly done: number; readonly total: number }) {
  const shown = Math.min(total, MAX_SUMMARY_PIPS);
  return (
    <BoardHint label={`${done} of ${total} plans done`}>
      <span
        className="inline-flex items-center gap-0.5"
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
    </BoardHint>
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
    <BoardHint label={`${critical} critical · ${improvement} improvements · ${nitpick} nitpicks`}>
      <span
        aria-label={`${critical} critical · ${improvement} improvements · ${nitpick} nitpicks`}
        className="inline-flex items-center gap-1 rounded bg-muted px-1.5 text-[10.5px] font-medium tabular-nums"
      >
        <span className="text-red-600 dark:text-red-400">{critical}</span>
        <span className="text-muted-foreground">/</span>
        <span className="text-amber-600 dark:text-amber-400">{improvement}</span>
        <span className="text-muted-foreground">/</span>
        <span className="text-sky-600 dark:text-sky-400">{nitpick}</span>
      </span>
    </BoardHint>
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
    <BoardHint
      label={`${fixed} fixed · ${rejected} rejected · ${open} open · ${disputed} disputed`}
    >
      <span className="text-[10.5px] font-medium text-muted-foreground">
        {fixed} fixed · {rejected} rejected · {open} open · {disputed} disputed
      </span>
    </BoardHint>
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
      // Not inline: the plan bar is its own full-width row (`BoardCardPlansRow`,
      // rendered by the card itself) so its segments can stretch the card.
      return null;
    case "round":
      return <RoundPips current={item.current} max={item.max} outcome={item.outcome} />;
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
  // Plans render as their own row (`BoardCardPlansRow`); counting them here
  // would leave an empty div claiming a slot of the card's column gap.
  const inline = items.filter((item) => item.kind !== "plans");
  if (inline.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {inline.map((item) => (
        <SummaryItem item={item} key={item.kind} />
      ))}
    </div>
  );
}

/** One count with its icon. The number is never on its own: three bare glyphs
    in a row mean nothing without the tooltip that spells them out. */
function MetaCount({
  children,
  icon: Icon,
  tint,
  title,
}: {
  readonly children: number | string;
  readonly icon: LucideIcon;
  readonly tint?: string | undefined;
  readonly title: string;
}) {
  return (
    <BoardHint label={title}>
      <span
        aria-label={title}
        className={cn(
          "inline-flex items-center gap-1 text-[10.5px] font-medium tabular-nums",
          tint ?? "text-muted-foreground",
        )}
      >
        <Icon className="size-3" />
        {children}
      </span>
    </BoardHint>
  );
}

/**
 * The card's footer: dependencies, agent threads, plans and the pull request,
 * left to right, with the brief's image flag pushed to the far end. Renders
 * nothing at all when the card is tied to nothing, so a bare card keeps its
 * height.
 */
export function BoardCardMetaRow({ meta }: { readonly meta: BoardCardMeta }) {
  if (meta.empty) return null;
  return (
    <div className="flex items-center gap-2.5 text-muted-foreground">
      {meta.dependencyCount === 0 ? null : (
        <MetaCount
          icon={Link2Icon}
          title={`Depends on ${meta.dependencyCount} ${meta.dependencyCount === 1 ? "card" : "cards"}`}
        >
          {meta.dependencyCount}
        </MetaCount>
      )}
      {meta.threadCount === 0 ? null : (
        <MetaCount
          icon={MessageSquareIcon}
          title={`${meta.threadCount} agent ${meta.threadCount === 1 ? "thread" : "threads"} on this card`}
        >
          {meta.threadCount}
        </MetaCount>
      )}
      {meta.planCount === 0 ? null : (
        <MetaCount
          icon={ListIcon}
          title={`${meta.planCount} ${meta.planCount === 1 ? "plan" : "plans"}`}
        >
          {meta.planCount}
        </MetaCount>
      )}
      {meta.prNumber === undefined ? null : (
        <MetaCount
          icon={GitPullRequestIcon}
          tint="text-info-foreground"
          title={`Pull request #${meta.prNumber}`}
        >
          {`#${meta.prNumber}`}
        </MetaCount>
      )}
      <span className="flex-1" />
      {meta.briefHasImage ? (
        // The one indicator with no number: a brief either has a picture in it
        // or it does not, and "1 image" would be a count of nothing useful.
        <BoardHint label="Brief contains an image">
          <span aria-label="Brief contains an image">
            <ImageIcon className="size-3" />
          </span>
        </BoardHint>
      ) : null}
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
    <BoardHint label={label}>
      <span aria-label={label} className="flex items-center gap-[2px]">
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
    </BoardHint>
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
          <BoardHint label="Time on the current todo">
            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70">
              {elapsed}
            </span>
          </BoardHint>
        )}
        {otherThreadCount > 0 && onToggleThreads !== undefined ? (
          <BoardHint
            label={
              expanded
                ? "Hide the other threads on this card"
                : `Show ${otherThreadCount} other ${otherThreadCount === 1 ? "thread" : "threads"}`
            }
          >
            <button
              className="-my-0.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              // The chip must NOT open the card: clicking it expands the other
              // threads in place.
              onClick={(event) => {
                event.stopPropagation();
                onToggleThreads();
              }}
              type="button"
            >
              {expanded ? (
                <ChevronDownIcon className="size-2.5" />
              ) : (
                <ChevronRightIcon className="size-2.5" />
              )}
              +{otherThreadCount}
            </button>
          </BoardHint>
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
