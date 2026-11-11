/**
 * Card face summary rows: inline summary items, the full-width progress blocks
 * (plans bar, review ledger), and the stage-independent meta footer. Static only:
 * no animations. A row with nothing to say renders nothing.
 */
import {
  boardReviewHeldLabel,
  isBoardReviewLoopHeld,
  type BoardCardThreadShell,
} from "@t3tools/contracts";
import {
  BOARD_THREAD_TODO_STATUS_DONE,
  BOARD_THREAD_TODO_STATUS_IN_PROGRESS,
  BOARD_THREAD_TODO_STATUS_PENDING,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ImageIcon,
  Link2Icon,
  ListIcon,
  MessageSquareIcon,
  PaperclipIcon,
  type LucideIcon,
} from "lucide-react";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";

import { cn } from "../lib/utils";
import { BOARD_CARD_REVIEW_ITEM_KINDS } from "./boardCardProgressBlock";
import { formatRelativeTime } from "../timestampFormat";
import type { BoardCardWorkerChip } from "./workers/cardWorker";
import type { BoardCardMeta, BoardCardSummaryItem } from "./boardCardSummary";
import { BoardHint } from "./BoardHint";

/**
 * One segment per round in the budget. Neutral on purpose (`docs/t3o/status-colours.md`):
 * a passed loop and an exhausted one can show the same counts, so a held loop
 * tints every segment amber and the label says so in words.
 */
function RoundBar({
  current,
  max,
  held,
}: {
  readonly current: number;
  /** Absent when the producer could not see the budget — the bar then draws
      only the rounds that actually ran rather than inventing a total. */
  readonly max: number | undefined;
  readonly held: boolean;
}) {
  const total = Math.max(max ?? current, current, 1);
  return (
    <span className="flex items-center gap-0.75">
      {/* Indexed rather than mapped over data: a segment IS its position, the
          same shape `BoardTodoPips` and `BoardCardPlansRow` use. */}
      {Array.from({ length: total }, (_, index) => (
        <span
          className={cn(
            "h-[3px] min-w-[2px] flex-1 rounded-xs",
            held
              ? "bg-warning/55"
              : index < current - 1
                ? "bg-foreground/30"
                : index === current - 1
                  ? "bg-foreground/60"
                  : "bg-muted-foreground/25",
          )}
          key={index}
        />
      ))}
    </span>
  );
}

/** Narrowing `find` over the item union — `Array.find` alone returns the whole
    union, and the block needs each part's own fields. */
function pickItem<K extends BoardCardSummaryItem["kind"]>(
  items: ReadonlyArray<BoardCardSummaryItem>,
  kind: K,
): Extract<BoardCardSummaryItem, { readonly kind: K }> | undefined {
  return items.find(
    (item): item is Extract<BoardCardSummaryItem, { readonly kind: K }> => item.kind === kind,
  );
}

/**
 * The review ledger as the card's one progress block, replacing the plan bar or
 * todo strip while the card is in code review. Renders only the ledger parts it
 * was given, never a row of zeroes.
 */
export function BoardCardReviewBlock({
  items,
}: {
  readonly items: ReadonlyArray<BoardCardSummaryItem>;
}) {
  const round = pickItem(items, "round");
  const step = pickItem(items, "step");
  const severity = pickItem(items, "severity");
  const issues = pickItem(items, "issues");
  if (round === undefined && step === undefined && severity === undefined && issues === undefined) {
    return null;
  }
  const held = round?.outcome !== undefined && isBoardReviewLoopHeld(round.outcome);
  const rounds =
    round === undefined
      ? null
      : round.max === undefined
        ? `Round ${round.current}`
        : `Round ${round.current} of ${round.max}`;
  return (
    <div className="flex flex-col gap-1.5">
      {rounds === null && step === undefined && !held ? null : (
        <div className="flex items-center gap-2">
          {rounds === null ? null : (
            <span className="text-board-10-5 font-medium text-foreground">{rounds}</span>
          )}
          <span className="flex-1" />
          {/* One chip slot, and the held flag owns it: "the loop stopped without
              converging" outranks "it is triaging" every time. */}
          {held ? (
            <span
              className={
                round?.outcome === "stuck"
                  ? "inline-flex shrink-0 items-center rounded bg-attention/16 px-1.5 text-board-10 font-medium uppercase tracking-wide text-attention-foreground"
                  : "inline-flex shrink-0 items-center rounded bg-warning/18 px-1.5 text-board-10 font-medium uppercase tracking-wide text-board-amber-text"
              }
            >
              {round?.outcome === undefined
                ? "No convergence"
                : boardReviewHeldLabel(round.outcome)}
            </span>
          ) : step === undefined ? null : (
            <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 text-board-10 font-medium uppercase tracking-wide text-muted-foreground">
              {step.label}
            </span>
          )}
        </div>
      )}
      {round === undefined ? null : (
        <BoardHint
          label={`${rounds}${
            held
              ? round.outcome === "stopped"
                ? " (stopped, no convergence)"
                : round.outcome === "stuck"
                  ? " (stuck, needs your call)"
                  : " (no convergence)"
              : ""
          }`}
        >
          <span
            aria-label={`${rounds}${
              held
                ? round.outcome === "stopped"
                  ? " (stopped, no convergence)"
                  : round.outcome === "stuck"
                    ? " (stuck, needs your call)"
                    : " (no convergence)"
                : ""
            }`}
            className="flex items-center"
          >
            <RoundBar current={round.current} held={held} max={round.max} />
          </span>
        </BoardHint>
      )}
      {severity === undefined && issues === undefined ? null : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {severity === undefined ? null : (
            <SeverityTriple
              critical={severity.critical}
              improvement={severity.improvement}
              nitpick={severity.nitpick}
            />
          )}
          {issues === undefined ? null : (
            <IssueTally
              disputed={issues.disputed}
              escalated={issues.escalated}
              fixed={issues.fixed}
              open={issues.open}
              rejected={issues.rejected}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The small bordered chip that opens a card's plans or a group's sub-board. */
export const BOARD_CHIP_CLASS =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 text-board-10-5 font-medium whitespace-nowrap text-muted-foreground";

/**
 * The split parent's plan bar: one segment per child plan plus the drill-in chip.
 * Without `statuses` it falls back to done-then-pending from the counts; without
 * `onOpen` the chip renders static so the face does not reflow between surfaces.
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
  const chipBody = (
    <>
      {label}
      <ChevronRightIcon className="size-3" />
    </>
  );
  return (
    <BoardHint label={`${done} of ${total} plans done`}>
      <div aria-label={`${done} of ${total} plans done`} className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-0.75">
          {Array.from(chars, (status, index) => (
            <span
              className={cn(
                "h-[3px] min-w-[2px] flex-1 rounded-xs",
                status === BOARD_THREAD_TODO_STATUS_DONE
                  ? "bg-success"
                  : status === BOARD_THREAD_TODO_STATUS_IN_PROGRESS
                    ? "bg-info/60"
                    : "bg-muted-foreground/25",
              )}
              key={index}
            />
          ))}
        </span>
        {onOpen === undefined ? (
          <span className={BOARD_CHIP_CLASS}>{chipBody}</span>
        ) : (
          // A real button so it is focusable on its own; clicks and keys stop
          // here so the card underneath does not also open its detail sheet.
          <BoardHint label="Open this card's sub-board">
            <button
              className={cn(
                BOARD_CHIP_CLASS,
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
  // the tooltip spells them out.
  return (
    <BoardHint label={`${critical} critical · ${improvement} improvements · ${nitpick} nitpicks`}>
      <span
        aria-label={`${critical} critical · ${improvement} improvements · ${nitpick} nitpicks`}
        className="inline-flex items-center gap-1 rounded bg-muted px-1.5 text-board-10-5 font-medium tabular-nums"
      >
        <span className="text-board-red-text">{critical}</span>
        <span className="text-muted-foreground">/</span>
        <span className="text-board-amber-icon">{improvement}</span>
        <span className="text-muted-foreground">/</span>
        <span className="text-board-sky-text">{nitpick}</span>
      </span>
    </BoardHint>
  );
}

function IssueTally({
  fixed,
  rejected,
  open,
  disputed,
  escalated,
}: {
  readonly fixed: number;
  readonly rejected: number;
  readonly open: number;
  readonly disputed: number;
  readonly escalated: number;
}) {
  const text = `${fixed} fixed · ${rejected} rejected · ${open} open · ${disputed} disputed${escalated > 0 ? ` · ${escalated} escalated` : ""}`;
  return (
    <BoardHint label={text}>
      <span className="text-board-10-5 font-medium text-muted-foreground">{text}</span>
    </BoardHint>
  );
}

function SummaryItem({ item }: { readonly item: BoardCardSummaryItem }) {
  switch (item.kind) {
    case "attachments":
      return (
        <span className="inline-flex items-center gap-0.5 text-board-10-5 font-medium text-muted-foreground">
          <PaperclipIcon className="size-3" />
          {item.count}
        </span>
      );
    case "plans":
      // Not inline: the plan bar is its own full-width row (`BoardCardPlansRow`,
      // rendered by the card itself) so its segments can stretch the card.
      return null;
    case "review-advanced":
      // Neutral: not a pass, and not a call for a human.
      return (
        <span className="text-board-10-5 font-medium text-muted-foreground">
          Advanced past stuck round {item.round}
          {item.unreviewedFixes > 0
            ? ` · ${item.unreviewedFixes} ${item.unreviewedFixes === 1 ? "fix" : "fixes"} not re-reviewed`
            : ""}
        </span>
      );
    case "round":
    case "step":
    case "severity":
    case "issues":
      // The review ledger is one block, not four inline chips
      // (`BoardCardReviewBlock`), so that the round bar can stretch the card
      // the way the plan bar and the todo strip do.
      return null;
  }
}

export function BoardCardSummaryRow({
  items,
}: {
  readonly items: ReadonlyArray<BoardCardSummaryItem>;
}) {
  // Plans and the review ledger render as their own full-width blocks
  // (`BoardCardPlansRow`, `BoardCardReviewBlock`); counting them here would
  // leave an empty div claiming a slot of the card's column gap.
  const inline = items.filter(
    (item) => item.kind !== "plans" && !BOARD_CARD_REVIEW_ITEM_KINDS.has(item.kind),
  );
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
          "inline-flex items-center gap-1 text-board-10-5 font-medium tabular-nums",
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
export function BoardCardMetaRow({
  meta,
  worker,
}: {
  readonly meta: BoardCardMeta;
  /** The worker chip, at the row's right end; null on a board with
      one worker. */
  readonly worker?: BoardCardWorkerChip | null | undefined;
}) {
  if (meta.empty && worker == null) return null;
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
          icon={PullRequestGlyph.pullRequest}
          // A draft is neutral: not running, not done, not blocked —
          // the board marks it ready when the card reaches Ready for merge.
          tint={meta.prDraft ? "text-muted-foreground" : "text-info-foreground"}
          title={
            meta.prDraft ? `Draft pull request #${meta.prNumber}` : `Pull request #${meta.prNumber}`
          }
        >
          {meta.prDraft ? `#${meta.prNumber} · Draft` : `#${meta.prNumber}`}
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
      {worker == null ? null : (
        // Never a status colour: worker trouble goes in the notice
        // slot. Solid when the card is bound to its worker, dashed while it
        // follows the default and hasn't started.
        <BoardHint label={worker.tooltip}>
          <span
            aria-label={worker.tooltip}
            className={cn(
              "inline-flex h-4 max-w-[110px] shrink-0 items-center rounded border px-1.5 text-board-10 font-medium text-muted-foreground",
              worker.bound ? "border-border" : "border-dashed border-border",
            )}
          >
            <span className="truncate">{worker.label}</span>
          </span>
        </BoardHint>
      )}
    </div>
  );
}

// ── Thread todo strip ──────────────────────────────────

/**
 * One pip per stored todo item, coloured by that item's real status, since agents
 * complete items out of order. All stored pips render; `MAX_SUMMARY_PIPS` is
 * deliberately not reused because a few pips standing for many items misleads.
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
      <span aria-label={label} className="flex items-center gap-0.5">
        {/* Indexed rather than mapped over the characters: a pip IS its position
          — the row is a positional progress bar and items never reorder within a
          render — which is the same shape `RoundBar` uses. */}
        {Array.from({ length: statuses.length }, (_, index) => (
          <span
            className={cn(
              "h-[3px] min-w-[2px] flex-1 rounded-full",
              statuses[index] === BOARD_THREAD_TODO_STATUS_DONE
                ? "bg-success"
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

/** "13m" / "2h" on the item the agent is currently on. Elapsed is anchored
    to the moment the in-progress item's TEXT changed, so reordering and
    insertion do not reset it. */
function todoElapsedLabel(startedAt: string | undefined): string | null {
  if (startedAt === undefined) return null;
  const relative = formatRelativeTime(startedAt);
  return relative === null || relative.suffix === null ? null : relative.value;
}

/**
 * The todo strip: pips, the true `done/total`, and the in-progress item with how
 * long it has run. More than one live thread adds a count chip on the meta row.
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
        <span className="shrink-0 text-board-10-5 font-medium tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        {todo.todoCurrent === undefined ? null : (
          <span className="min-w-0 flex-1 truncate text-board-10-5 text-muted-foreground">
            {todo.todoCurrent}
          </span>
        )}
        {elapsed === null ? null : (
          <BoardHint label="Time on the current todo">
            <span className="shrink-0 text-board-10-5 tabular-nums text-muted-foreground/70">
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
              className="-my-0.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-board-10 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
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

/** One non-winning thread, revealed only after the chip is clicked (a second
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
      <span className="min-w-0 flex-1 truncate text-board-10-5 text-muted-foreground">{title}</span>
      {total === 0 ? null : (
        <span className="shrink-0 text-board-10-5 font-medium tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
      )}
    </div>
  );
}
