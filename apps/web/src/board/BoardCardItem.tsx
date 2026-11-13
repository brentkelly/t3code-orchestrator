/**
 * The "working" dot is the one animated indicator: a slow opacity fade, no
 * per-frame layout. It also lights for a split parent whose child is working.
 */
import {
  BOARD_SEED_STAGE_IDS,
  boardSplitProposedNote,
  boardCardChildRunningLabel,
  isBoardCardWorking,
  boardCardWorkingLabel,
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
  ProjectIconColor,
  ThreadId,
} from "@t3tools/contracts";
import {
  ClockIcon,
  HardDriveIcon,
  LayersIcon,
  LockIcon,
  PauseIcon,
  TriangleAlertIcon,
  ArrowRightLeftIcon,
  ChevronRightIcon,
  ServerOffIcon,
  CircleSlashIcon,
} from "lucide-react";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import type { DragEvent, ReactNode } from "react";

import { cn } from "../lib/utils";
import {
  boardCardProgressBlock,
  boardCardShellThreadState,
  pickBoardCardTodoThread,
  type BoardTodoThreadState,
} from "./boardCardProgressBlock";
import { boardCardSetupFace } from "./boardCardCapacity";
import { BoardCardCiFace } from "./BoardCardCiFace";
import { boardCardAutoBuildChip } from "./boardCardAutomation";
import { boardCardScheduleLabel } from "./boardCardScheduleLabel";
import { boardCardFace } from "./boardCardFace";
import type { BoardCardNotice } from "./boardCardNotice";
import { boardCardMeta, boardCardSummary } from "./boardCardSummary";
import { BoardLabelChips } from "./BoardLabelChips";
import {
  BOARD_CHIP_CLASS,
  BoardCardMetaRow,
  BoardCardPlansRow,
  BoardCardReviewBlock,
  BoardCardSummaryRow,
  BoardCardTodoStrip,
  BoardCardTodoThreadRow,
} from "./BoardCardSummaryRow";
import { projectAccent } from "./projectAccent";
import { useBoardWorkersState } from "./workers/BoardWorkersContext";
import { boardCardWorkerChip } from "./workers/cardWorker";
import { BoardHint } from "./BoardHint";
import type { BoardQueueInfo } from "./boardQueueInfo";
import type { BoardGroupCardVm, BoardGroupChildState } from "./boardGroups";

/** A group's progress pips in the fixed status vocabulary: green is
    done and only done, violet needs you, amber blocked, blue running. */
const PIP_CLASS: Record<BoardGroupChildState, string> = {
  done: "bg-success",
  waiting: "bg-attention",
  blocked: "bg-warning",
  running: "bg-info/65",
  idle: "bg-foreground/13",
};

/** The group card's body: pips, `n/m`, who needs you, what is
    blocked, the drill-in, and a meta line. Stats truncate; the Board button
    never wraps. */
function BoardGroupBlock({
  group,
  onOpenSubBoard,
  costSlot,
}: {
  readonly group: BoardGroupCardVm;
  readonly onOpenSubBoard?: (() => void) | undefined;
  readonly costSlot?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {group.pips.length > 0 ? (
        <div className="flex items-center gap-0.75" data-board-group-pips>
          {group.pips.map((pip) => (
            <BoardHint key={pip.tooltip} label={pip.tooltip}>
              <span
                aria-label={pip.tooltip}
                className={cn("h-1 min-w-1 flex-1 rounded-xs", PIP_CLASS[pip.state])}
                data-state={pip.state}
                role="img"
              />
            </BoardHint>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2 text-board-11-5 font-medium">
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span
            className={cn(
              "shrink-0 tabular-nums",
              group.complete ? "text-success-foreground" : "text-muted-foreground",
            )}
          >
            {group.doneLabel}
          </span>
          {group.needs === null ? null : (
            <span className="truncate text-attention-foreground">{group.needs}</span>
          )}
          {group.blocked === null ? null : (
            <span className="truncate text-warning-foreground">{group.blocked}</span>
          )}
        </span>
        {onOpenSubBoard === undefined ? null : (
          <BoardHint label="Open this group's board">
            <button
              className={cn(
                BOARD_CHIP_CLASS,
                "cursor-pointer transition-colors hover:bg-accent hover:text-foreground",
              )}
              onClick={(event) => {
                event.stopPropagation();
                onOpenSubBoard();
              }}
              onKeyDown={(event) => event.stopPropagation()}
              type="button"
            >
              Board
              <ChevronRightIcon className="size-3" />
            </button>
          </BoardHint>
        )}
      </div>
      {group.meta.length === 0 && costSlot == null ? null : (
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-board-11 text-muted-foreground">
            {group.meta}
          </span>
          {costSlot}
        </div>
      )}
    </div>
  );
}

/** What a card needs to render its todo strip. All of it is joined
    client-side from state the client already holds — `boardCardThreads` off the
    shell snapshot and the thread shells beside it — so `BoardCardShell` gains no
    field and nothing is duplicated onto the wire. */
export interface BoardCardTodoContext {
  /** The card's live-linked threads and their cached lists. */
  readonly threads: ReadonlyArray<BoardCardThreadShell>;
  /** Live state of one thread, for the strip's winner rule. */
  readonly stateOf: (threadId: ThreadId) => BoardTodoThreadState | undefined;
  /** A thread's display title, for the expanded rows. */
  readonly titleOf: (threadId: ThreadId) => string;
  /** Whether the non-winning threads are revealed (client-only, session-scoped
      React state keyed by card id). */
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
}

const EMPTY_TODO_THREADS: ReadonlyArray<BoardCardThreadShell> = [];

/**
 * Tailwind resolves competing utilities by stylesheet order, not class order,
 * so each table holds one COMPLETE class per tone. `neutral` maps to the
 * untinted card's own classes: a paused card asserts nothing about work.
 */
const TONE_BORDER: Record<BoardCardAttentionTone, string> = {
  warning: "border-warning/60",
  attention: "border-attention/55",
  neutral: "border-border",
};

const TONE_TINT: Record<BoardCardAttentionTone, string> = {
  warning: "bg-board-warning-tint dark:bg-board-warning-tint-dark",
  attention: "bg-board-attention-tint dark:bg-board-attention-tint-dark",
  neutral: "bg-card hover:border-foreground/18 dark:bg-board-card-dark",
};

const TONE_RING: Record<BoardCardAttentionTone, string> = {
  warning: "shadow-board-card-warning hover:shadow-board-card-warning-hover",
  attention: "shadow-board-card-attention hover:shadow-board-card-attention-hover",
  neutral: "shadow-xs/5 hover:shadow-board-card-hover",
};

/** The chip's leading mark per reason. The violet question keeps its DOT rather
    than an icon — the card reads as "has a thread, and it needs you", the same
    indicator as the running dot in a different colour — while the states where
    nothing is running at all wear an icon. */
const ATTENTION_ICON: Record<BoardCardAttentionReason, ReactNode> = {
  // The literal meaning of the glyph, for once: a human pressed Stop.
  paused: <PauseIcon className="size-3" />,
  stalled: <TriangleAlertIcon className="size-3" />,
  approval: <LayersIcon className="size-3" />,
  "review-held": <TriangleAlertIcon className="size-3" />,
  // A stuck review waits on the human's ruling.
  "review-stuck": <TriangleAlertIcon className="size-3" />,
  // CI stopped for a human — the same mark as a held step.
  "ci-stopped": <PauseIcon className="size-3" />,
  held: <PauseIcon className="size-3" />,
  // Same mark as `held`: both say "the pipeline is finished with
  // this card and only a human moves it on", one settled and one not.
  stopped: <PauseIcon className="size-3" />,
  input: <span className="size-2 shrink-0 rounded-full bg-attention" />,
  // A permission prompt is the same "a thread needs you" fact.
  permission: <span className="size-2 shrink-0 rounded-full bg-attention" />,
};

/** The chip's own colours, which are text-weight rather than surface-weight —
    the card fill is already carrying the tone. */
const TONE_CHIP: Record<BoardCardAttentionTone, string> = {
  warning: "text-board-amber-text",
  attention: "text-attention-foreground",
  neutral: "text-muted-foreground",
};

/**
 * Truncates rather than pushing: the notice shares a narrow column with the key
 * pill, parent chip and working dot. Tooltip and aria-label keep the full text.
 */
function BoardCardNoticeChip({ notice }: { readonly notice: BoardCardNotice }) {
  const view =
    notice.kind === "attention"
      ? {
          icon: ATTENTION_ICON[notice.attention.reason],
          label: notice.attention.label,
          tooltip: notice.attention.tooltip,
          tint: TONE_CHIP[notice.attention.tone],
        }
      : notice.kind === "conflicts"
        ? {
            icon: <PullRequestGlyph.merged className="size-3 shrink-0" />,
            label: notice.fix.label,
            tooltip: notice.fix.tooltip,
            tint: "text-warning-foreground",
          }
        : notice.kind === "auto-merge"
          ? {
              icon:
                notice.pill.icon === "alert" ? (
                  <TriangleAlertIcon className="size-3 shrink-0" />
                ) : (
                  <ClockIcon className="size-3 shrink-0" />
                ),
              label: notice.pill.label,
              tooltip: notice.pill.tooltip,
              tint: "text-warning-foreground",
            }
          : notice.kind === "no-pull-request"
            ? {
                // T3o. Amber, making the same claim `Needs a human`
                // does: nobody is working, the board cannot move this card on by
                // itself, and it is waiting on something outside itself.
                // `docs/t3o/status-colours.md` gives amber to blocked or held.
                icon: <PullRequestGlyph.pullRequest className="size-3 shrink-0" />,
                label: "No PR",
                // Not "…and check again": the re-check needs a branch, and a
                // merge-stage card that never built one has none. The pane
                // explains either way, so the tooltip points there and lets it
                // say which of the two this card is.
                tooltip: "Ready to merge, but this card has no pull request. Open it to see why",
                tint: "text-warning-foreground",
              }
            : notice.kind === "worker-move"
              ? {
                  // Blue while the move runs (something is working on
                  // it), amber once it failed (only a human can retry it).
                  icon: <ArrowRightLeftIcon className="size-3 shrink-0" />,
                  label: notice.move.label,
                  tooltip: notice.move.tooltip,
                  tint:
                    notice.move.status === "moving"
                      ? "text-info-foreground"
                      : "text-warning-foreground",
                }
              : notice.kind === "worker"
                ? {
                    // Amber either way — the card's worker is gone or
                    // out of reach, and nothing moves until it is back or a
                    // human moves the card.
                    icon: <ServerOffIcon className="size-3 shrink-0" />,
                    label: notice.trouble.label,
                    tooltip: notice.trouble.tooltip,
                    tint: "text-warning-foreground",
                  }
                : notice.kind === "stage-gone"
                  ? {
                      // Amber: held — the card's project dropped this
                      // stage, so nothing moves the card on but a human.
                      icon: <CircleSlashIcon className="size-3 shrink-0" />,
                      label: "Stage removed",
                      tooltip: `${notice.note}. Move the card on; the column goes once it's empty.`,
                      tint: "text-warning-foreground",
                    }
                  : notice.kind === "worktree-kept"
                    ? {
                        // Amber: the card is finished but its cleanup is
                        // blocked, and only a human can clear what is in the way.
                        icon: <HardDriveIcon className="size-3 shrink-0" />,
                        label: "Worktree kept",
                        tooltip: `Worktree kept: ${notice.reason}`,
                        tint: "text-warning-foreground",
                      }
                    : {
                        icon: <LockIcon className="size-3 shrink-0" />,
                        label: "Blocked",
                        tooltip: `Blocked by ${notice.dependencyCount} ${notice.dependencyCount === 1 ? "dependency" : "dependencies"}`,
                        tint: "text-warning-foreground",
                      };
  return (
    <BoardHint label={view.tooltip}>
      <span
        aria-label={view.tooltip}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 text-board-10-5 font-semibold",
          view.tint,
        )}
      >
        {view.icon}
        <span className="truncate">{view.label}</span>
      </span>
    </BoardHint>
  );
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
  attention,
  childAttention,
  childRunning,
  noPullRequest,
  atMergeStage,
  autoMergeArmed,
  autoBuildArmed,
  worktreeKeptReason,
  stageGone,
  group = null,
  costSlot = null,
}: {
  readonly card: BoardCardShell;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  readonly queueSlot: BoardQueueInfo | undefined;
  readonly selected: boolean;
  /** T3o: the card's cost (T3O-77), drawn only once the card is Done; null otherwise.
      At the meta row's right end on a leaf, on the group block's last line on a group. */
  readonly costSlot?: ReactNode;
  /** The group face, or null for a leaf. A group's own thread,
      review, todo, PR and plan indicators are hidden: its pipeline is paused,
      and its children carry the work. */
  readonly group?: BoardGroupCardVm | null | undefined;
  /** Why this finished card kept its worktree, or null when it has not
      — `boardCardWorktreeKept`, resolved by the board page, which holds the
      settings and the stage roles. Absent on the surfaces that do not resolve
      it (the drag ghost). */
  readonly worktreeKeptReason?: string | null | undefined;
  /** The card's project no longer uses the stage it sits in. */
  readonly stageGone?: string | null | undefined;
  /** The parent card's key when this is a sub-board child; absent on
      surfaces that do not resolve it (the drag ghost, the archive sheet). */
  readonly parentKey?: string | undefined;
  /** The project's icon colour; null falls back to the hash colour. */
  readonly accentName?: ProjectIconColor | null | undefined;
  /** Thread todo lists. Absent on surfaces that do not carry them
      (the archive sheet, the drag ghost), where the card renders exactly as it
      did before. */
  readonly todos?: BoardCardTodoContext | undefined;
  /** Drill into this card's sub-board. Only a split parent renders
      the plan row's drill-in chip as a live button, and only where the
      handler is supplied (the live root board — not the ghost, not the
      archive sheet, where the chip is a static twin). */
  readonly onOpenSubBoard?: (() => void) | undefined;
  /** Why this card is waiting on a human, or null (`boardCardAttention`).
      Absent on surfaces that do not resolve it (drag ghost, archive sheet). */
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
  /** T3o: the card is parked at the merge-role stage with no pull
      request, already past the settle grace — `boardCardNoPullRequest`, resolved
      by the board page. Absent on the surfaces that do not resolve it (the drag
      ghost, the archive sheet), where the card renders as it always did. */
  readonly noPullRequest?: boolean | undefined;
  /** Whether this card is sitting in the merge-role stage —
      the only place an armed card wears the grey `Auto` glyph. Absent on the
      surfaces that do not resolve it (the drag ghost, the archive sheet). */
  readonly atMergeStage?: boolean | undefined;
  /** The card's resolved Auto-merge (`boardShellAutoMergeArmedByCard`):
      its own setting, its nearest group's, or the board-wide one.
      Absent reads the card's own setting alone. */
  readonly autoMergeArmed?: boolean | undefined;
  /** The card waits in the stage before build with Auto-build on,
      resolved by the board page. Absent on the drag ghost and archive sheet. */
  readonly autoBuildArmed?: boolean | undefined;
}) {
  const accent = projectAccent(card.projectId, accentName);
  const summary = boardCardSummary(card);
  // Where the card runs, said only once a second worker exists.
  const workers = useBoardWorkersState();
  const todoThreads = todos?.threads ?? EMPTY_TODO_THREADS;
  const stateOf = todos?.stateOf ?? (() => boardCardShellThreadState(card));
  const winner = pickBoardCardTodoThread({
    threads: todoThreads,
    stateOf,
    activeThreadId: card.activeThreadId,
  });
  // Exactly one progress block per card, with review outranking subcards
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
  const isGroup = group !== null;
  const inCi = card.stage === BOARD_SEED_STAGE_IDS.ci;
  const workingLabel =
    isBoardCardWorking(card) && !isGroup
      ? boardCardWorkingLabel(card)
      : childRunning !== undefined && childRunning > 0
        ? boardCardChildRunningLabel(childRunning)
        : null;
  // oxlint-disable-next-line react/purity -- the face samples the clock whenever the card re-renders on a board push.
  const faceNow = Date.now();
  const { own, tone, notice } = boardCardFace({
    card,
    summary,
    attention: attention ?? null,
    childAttention: childAttention ?? null,
    isGroup,
    noPullRequest: noPullRequest === true,
    worktreeKeptReason,
    stageGone,
    workers,
    now: faceNow,
  });
  const autoMergeHeld = !summary.muted && card.autoMergeHeldSince != null;
  // A split parent wears the stack: the card reads as the top
  // sheet of a pile. Purely visual now — the drill-in affordance is the plan
  // row's chip — so it keys off `planTotal` alone and the drag ghost / archive
  // sheet keep the pile.
  const wearsStack = isGroup || (card.planTotal !== undefined && card.planTotal > 0);
  // The card's scheduled start. Null on a done card and on
  // one whose time has already passed — the server clears the field within a
  // tick, and a pill for a moment that has gone is a stale label.
  const scheduleLabel = boardCardScheduleLabel({
    scheduledStartAt: card.scheduledStartAt ?? null,
    done: summary.muted,
    parked: card.stepAwaiting !== null || card.stalled,
    // oxlint-disable-next-line react/purity -- the pill samples the clock whenever the card re-renders on a board push.
    nowMs: Date.now(),
  });
  // The card's Auto-build. Yields the single right-hand slot to a
  // schedule pill, which names a concrete moment and is the more specific
  // claim; the queue pill below yields to both.
  const autoBuildChip = boardCardAutoBuildChip({
    armed: autoBuildArmed === true,
    done: summary.muted,
    scheduled: scheduleLabel !== null,
  });
  return (
    <article
      className={cn(
        // `transition-colors` alone could not animate the lift — box-shadow is
        // not a colour property, so the hover shadow snapped in. Transition
        // both; the hover lift itself rides the per-state shadow branch below.
        "flex cursor-pointer flex-col gap-1.5 rounded-board-10 border px-2.75 py-2.5 transition-[color,background-color,border-color,box-shadow] duration-120 ease-board",
        // One border class: competing `border-*` utilities resolve by
        // stylesheet order, so stacking them decides nothing.
        selected ? "border-foreground/40" : tone === null ? "border-border" : TONE_BORDER[tone],
        // `dark:bg-board-card-dark` lifts the card above the column; the stock dark
        // `--card` lands below the column's fill.
        tone === null
          ? "bg-card hover:border-foreground/18 dark:bg-board-card-dark"
          : TONE_TINT[tone],
        // Done recedes: finished work is muted and lower-contrast.
        summary.muted && "bg-card/60 opacity-70",
        // EXACTLY one box-shadow branch per card (stylesheet order wins), each
        // with its own resting and hover shadow. `--sheet` tracks the card fill.
        wearsStack
          ? "mb-2 [--board-card-sheet:var(--card)] dark:[--board-card-sheet:var(--color-board-card-dark)] shadow-board-card-stack hover:shadow-board-card-stack-hover"
          : tone === null
            ? "shadow-xs/5 hover:shadow-board-card-hover"
            : TONE_RING[tone],
      )}
      data-board-card={card.cardId}
      data-board-card-stage={card.stage}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-board-10 font-semibold tracking-wide",
            accent.pill,
          )}
        >
          {card.key}
        </span>
        {parentKey !== undefined ? (
          // Sub-board membership: a child card names its parent so a
          // mixed column still reads as a whole. The chip is informational —
          // navigation stays the card click; drill-in is separate.
          <BoardHint label={`Part of ${parentKey}'s sub-board`}>
            <span className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1.5 text-board-10 font-medium text-muted-foreground">
              <LayersIcon className="mr-0.5 size-2.5" />
              {parentKey}
            </span>
          </BoardHint>
        ) : null}
        {workingLabel === null ? null : (
          // `stepRunning` keeps the dot lit across a loop stage's per-phase
          // thread gaps; every candidate thread having FAILED vetoes it. A split
          // parent lights it for a working child — only the tooltip differs.
          <BoardHint label={workingLabel}>
            <span
              aria-label={workingLabel}
              role="img"
              className="size-2 shrink-0 animate-pulse rounded-full bg-info"
            />
          </BoardHint>
        )}
        {card.waitingOnBackground === true && notice === null ? (
          // T3o: the agent ended its turn to wait on a background
          // command, a monitor or subagents. Beside the dot, which stays lit
          // because something really is running. Muted, never violet: no human
          // is needed, and the board checks in on the wait by itself.
          <BoardHint label="Waiting for background task">
            <span
              aria-label="Waiting for background task"
              className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1.5 text-board-10 font-medium text-muted-foreground"
            >
              Waiting
            </span>
          </BoardHint>
        ) : null}
        {notice === null ? null : (
          // The face has room for one status word; `boardCardNotice` ranks the
          // sources and, on a healthy parent, names the child with a problem.
          <BoardCardNoticeChip notice={notice} />
        )}
        <span className="flex-1" />
        {scheduleLabel === null ? null : (
          // Wins over the queue pill (`boardBuildQueue` excludes scheduled
          // cards). Neutral: a scheduled card moves on its own. The label is
          // absolute and only the tooltip relative, so it repaints with its card.
          <BoardHint label={scheduleLabel.tooltip}>
            <span
              aria-label={scheduleLabel.tooltip}
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 text-board-10 font-medium text-muted-foreground"
            >
              <ClockIcon className="size-2.5" />
              {scheduleLabel.label}
            </span>
          </BoardHint>
        )}
        {autoBuildChip === null ? null : (
          // Neutral, never coloured, for the schedule pill's reason above: the
          // card is not running, not done, and nothing is waiting on a human.
          // Amber's claim — "this will never move until someone acts" — is
          // exactly what an armed card disproves.
          <BoardHint label={autoBuildChip.tooltip}>
            <span
              aria-label={autoBuildChip.tooltip}
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 text-board-10 font-medium text-muted-foreground"
            >
              <ClockIcon className="size-2.5" />
              {autoBuildChip.label}
            </span>
          </BoardHint>
        )}
        {scheduleLabel === null &&
        autoBuildChip === null &&
        queueSlot !== undefined &&
        // A card held by its worker says so in the notice instead.
        notice?.kind !== "worker" ? (
          // The tooltip carries the WHOLE reason, so why a card is
          // waiting — and that it will start on its own — is readable without
          // opening it.
          <BoardHint label={`${queueSlot.headline}. ${queueSlot.detail}`}>
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded px-1.5 text-board-10 font-medium",
                queueSlot.blocked === true
                  ? "bg-warning/14 text-board-amber-text"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {queueSlot.label}
            </span>
          </BoardHint>
        ) : null}
        {/* Keyed on the HOLD, not on which notice won it: a held card
            whose slot went to a pending question is still held, and "merges
            itself as soon as the forge accepts it" is not true of it. */}
        {(autoMergeArmed ?? card.autoMergeSetting === true) &&
        !autoMergeHeld &&
        !summary.muted &&
        atMergeStage ? (
          // Armed and quiet, merge stage only. Counts the board-wide arm exactly as
          // `BoardCardDetailView` does, so the two never answer differently.
          <BoardHint label="Merges itself as soon as the forge accepts it">
            <span
              aria-label="Auto-merge armed"
              className="inline-flex shrink-0 items-center gap-0.5 text-board-10-5 font-medium text-muted-foreground"
            >
              <PullRequestGlyph.merged className="size-3" />
              Auto
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
          "text-board-13 leading-board-1-35 font-medium text-pretty",
          summary.muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {card.title}
      </div>
      {own?.reason === "approval" ? (
        // A pending split: the chip says it needs you, this says what.
        <div className="text-board-11-5 font-medium text-attention-foreground">
          {boardSplitProposedNote(card.planCount ?? 0)}
        </div>
      ) : null}
      {group === null ? null : (
        <BoardGroupBlock costSlot={costSlot} group={group} onOpenSubBoard={onOpenSubBoard} />
      )}
      {isGroup ? null : <BoardCardSummaryRow items={summary.items} />}
      {!isGroup && progress.kind === "review" ? (
        // The review ledger is the card's progress block while it sits in code
        // review — even for a split parent, whose plan bar it outranks.
        <BoardCardReviewBlock items={progress.items} />
      ) : null}
      {!isGroup && progress.kind === "subcards"
        ? // The plan bar with its drill-in chip — the progress
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
      {isGroup ? null : (
        // CI: the steps while the card is in CI, or how it last left.
        <BoardCardCiFace ci={card.ci} inCi={inCi} lastOutcome={card.ciLastOutcome} />
      )}
      {isGroup ? null : <BoardCardSetupFace card={card} />}
      {!isGroup && progress.kind === "todos" && !(inCi && card.ci !== undefined) ? (
        <BoardCardTodoStrip
          expanded={todos?.expanded ?? false}
          onToggleThreads={todos?.onToggleExpanded}
          otherThreadCount={progress.otherThreadCount}
          todo={progress.todo}
        />
      ) : null}
      {isGroup || otherThreads.length === 0 ? null : (
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
      {isGroup ? null : (
        <BoardCardMetaRow
          cost={costSlot}
          meta={boardCardMeta(card, todoThreads.length)}
          worker={boardCardWorkerChip(card, workers)}
        />
      )}
    </article>
  );
}

/**
 * Native HTML5 drag-and-drop: dnd-kit's sortable transforms fought
 * `@legendapp/list`'s absolute positioning. `dragging` dims the source while
 * the page-built clone follows the cursor.
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
  noPullRequest,
  atMergeStage,
  autoMergeArmed,
  autoBuildArmed,
  worktreeKeptReason,
  stageGone,
  group = null,
  costSlot = null,
}: {
  readonly card: BoardCardShell;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  readonly queueSlot: BoardQueueInfo | undefined;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly costSlot?: ReactNode;
  readonly group?: BoardGroupCardVm | null | undefined;
  readonly onSelect: (card: BoardCardShell) => void;
  readonly onDragStart: (card: BoardCardShell, event: DragEvent<HTMLDivElement>) => void;
  readonly onDragEnd: () => void;
  /** Keyboard analogue of the pointer drag: move one visible slot up/down. */
  readonly onReorder: (card: BoardCardShell, direction: -1 | 1) => void;
  readonly accentName?: ProjectIconColor | null | undefined;
  readonly todos?: BoardCardTodoContext | undefined;
  readonly parentKey?: string | undefined;
  readonly onOpenSubBoard?: (() => void) | undefined;
  readonly attention?: BoardCardAttention | null | undefined;
  readonly childAttention?: BoardCardChildAttention | undefined;
  readonly childRunning?: number | undefined;
  /** T3o: forwarded to the card face. */
  readonly noPullRequest?: boolean | undefined;
  readonly atMergeStage?: boolean | undefined;
  readonly autoMergeArmed?: boolean | undefined;
  readonly autoBuildArmed?: boolean | undefined;
  readonly worktreeKeptReason?: string | null | undefined;
  readonly stageGone?: string | null | undefined;
}) {
  return (
    // Keyboard path: the card is a focusable button-role element — Enter/Space
    // opens the detail dialog, whose stage actions are real buttons, so moving
    // a card never REQUIRES the pointer drag (which has no keyboard analogue).
    <div
      draggable
      role="button"
      tabIndex={0}
      aria-label={`${card.key}: ${card.title}`}
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
        // Ctrl/Cmd+Arrow reorders; plain arrows stay free for scrolling and focus.
        // Alt+Down drills into a group's board.
        if (event.altKey && event.key === "ArrowDown" && group !== null && onOpenSubBoard) {
          event.preventDefault();
          onOpenSubBoard();
          return;
        }
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
        noPullRequest={noPullRequest}
        atMergeStage={atMergeStage}
        autoMergeArmed={autoMergeArmed}
        autoBuildArmed={autoBuildArmed}
        worktreeKeptReason={worktreeKeptReason}
        stageGone={stageGone}
        group={group}
        costSlot={costSlot}
      />
    </div>
  );
}

/** T3o: a card's setup on its face: Preparing n/4 with a stepped bar, or Setup failed (T3O-86). */
function BoardCardSetupFace({ card }: { readonly card: BoardCardShell }) {
  const face = boardCardSetupFace(card.setup, card.stepRunning === true);
  if (face === null) return null;
  return (
    <div className="flex items-center gap-2 text-board-11-5">
      <span
        className={face.tone === "running" ? "text-info-foreground" : "text-warning-foreground"}
      >
        {face.label}
      </span>
      <span aria-hidden className="flex flex-1 gap-0.5">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className={cn(
              "h-1 flex-1 rounded-full",
              index < face.done ? (face.tone === "running" ? "bg-info" : "bg-warning") : "bg-muted",
            )}
          />
        ))}
      </span>
    </div>
  );
}
