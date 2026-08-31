/**
 * T3o card detail — pure view (t3o-06). Everything the modal renders is a
 * prop; the connected `BoardCardDetail` wires the atoms and command dispatch.
 *
 * The card opens as a CENTRED MODAL, not a side pane, and it has the
 * prototype's two forms (`.plans/prototype/T3 Code Kanban v4.dc.html`):
 *
 * - **Backlog and Sprint** — a 760px sheet. The work has not started, so the
 *   card is what you read: brief, dependencies and threads on the left, the
 *   stage action, labels, the stage ladder and provenance in a 244px rail.
 * - **Planning onward** — a 1220px working surface. The card's thread runs in
 *   the modal (`BoardCardThreadPane`), with everything else stacked into a
 *   336px rail beside it and the brief one tab away. This is the prototype's
 *   `hasThreadPane` split, at its exact stage boundary.
 *
 * `BoardCardDetailPanel` is the sheet's contents, split out so the markup
 * stays testable with `renderToStaticMarkup` (the dialog itself portals, and
 * portals render nothing on the server). The D7 line is unchanged: the modal
 * renders from `board.subscribeCard` detail, the column view never does.
 *
 * The modal renders fully for an archived card whose worktree is long gone —
 * nothing here reads the repo (`projectName === null` is a first-class state,
 * not a crash). Sections with no data source yet (Plan body, Review ledger,
 * Activity) are deliberately ABSENT, not empty skeletons (no-speculative-
 * inventory); their owning specs are named in comments.
 */
import {
  DEFAULT_BOARD_REVIEW_ROUNDS,
  activeBoardCardThreadId,
  boardCardArchiveNeedsConfirmation,
  boardCardDisplayPullRequest,
  boardStageIndex,
  boardNextStageId,
  boardStagesInOrder,
  boardStageWithRole,
  liveBoardCardDependents,
  parseReviewStepId,
  sortBoardCardThreadLinks,
  type BoardCardDetail,
  type BoardCardId,
  type BoardCardThreadLink,
  type BoardCardThreadShell,
  type BoardCardThreadState,
  type BoardLabel,
  type BoardLabelId,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
  type EnvironmentId,
  type ThreadId,
  type BoardCardReviewOverrides,
  type BoardReviewRoundOverride,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  EllipsisVerticalIcon,
  GitPullRequestIcon,
  ExternalLinkIcon,
  FileIcon,
  FileTextIcon,
  LayersIcon,
  LockIcon,
  MessageSquareIcon,
  SquareIcon,
  RefreshCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Suspense, lazy, useState } from "react";

import { Button } from "../components/ui/button";
import { Dialog, DialogPopup } from "../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { BoardArchiveConfirmDialog } from "./BoardArchiveConfirmDialog";
import { BoardDeleteConfirmDialog } from "./BoardDeleteConfirmDialog";
import { BoardLabelChips } from "./BoardLabelChips";
import { BoardLabelField } from "./BoardLabelField";
import {
  BoardDependencySection,
  BoardSectionHeading as SectionHeading,
  type BoardDependencyEntry,
} from "./BoardCardFields";
import { BoardSearchAddPicker, type BoardPickerOption } from "./BoardSearchAddPicker";
import type { BoardThreadStageRestart } from "./BoardCardThreadAddMenu";
import { BoardCardActivityRail, type BoardActivityAgentLookup } from "./BoardCardActivityRail";
import { deriveBoardReviewLoop, hasBoardReviewSteps } from "./boardReviewLoop";
import { boardStageLabel } from "./boardStages";
import { boardStagePrimaryAction, isBoardStageManuallySelectable } from "./boardStageActions";

/** A `BoardState` view over a bare stage list, so the read-model stage helpers
    apply inside this pure view. */
function stageStateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

/** One id, so the dialog can label itself from the title the panel renders
    (the panel is mounted outside the dialog context by its tests). */
const CARD_TITLE_ID = "board-card-detail-title";

/**
 * The thread pane mounts the whole chat, so it loads only when a card that
 * has one is opened — the board's own chunk stays small, and the board never
 * pays for the chat it is not showing.
 */
const BoardCardThreadPane = lazy(() =>
  import("./BoardCardThreadPane").then((module) => ({ default: module.BoardCardThreadPane })),
);

/**
 * The plan pane pulls in the markdown renderer, so like the thread pane it
 * loads only when a card is actually shown on it — the board chunk stays lean.
 */
const BoardCardPlanPane = lazy(() =>
  import("./BoardCardPlanPane").then((module) => ({ default: module.BoardCardPlanPane })),
);

/**
 * The review pane renders the adversarial review loop (t3o-16, D9) — rounds,
 * phase progress and findings from the card's step completions. Lazy like its
 * siblings: a card that never reaches review pays nothing for it.
 */
const BoardCardReviewPane = lazy(() =>
  import("./BoardCardReviewPane").then((module) => ({ default: module.BoardCardReviewPane })),
);

/**
 * From Planning onward the card has work running against it, so the modal
 * opens onto the thread instead of the brief — the prototype's
 * `stageIndex(status) >= 2`.
 */
export function boardCardHasThreadPane(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
): boolean {
  // From the third stage onward the card has work running against it, so the
  // modal opens onto the thread instead of the brief — the prototype's
  // `stageIndex(status) >= 2`, now over the user-defined stage order (D13).
  return boardStageIndex(stageStateOf(stages), stage) >= 2;
}

/**
 * A finished card reads as finished from across the room: the whole sheet
 * wears a lime wash while the card sits on the done-role stage, and loses it
 * the moment the card moves back off. Keyed on the ROLE, never the label (D3),
 * so a renamed or re-ordered done column keeps the wash.
 */
export function boardCardIsDone(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
): boolean {
  return boardStageWithRole(stageStateOf(stages), "done")?.stageId === stage;
}

/** Named for the modal that first rendered it; the shape is shared with the
    create dialog, so it lives in `BoardCardFields`. */
export type BoardDetailDependency = BoardDependencyEntry;

/** The rail in the working-surface layout's right rail. Absent when the card
    has no activity — not an empty skeleton (no-speculative-inventory). */
function ActivitySection({
  detail,
  stages,
  agents,
}: {
  readonly detail: BoardCardDetail;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly agents: BoardActivityAgentLookup | undefined;
}) {
  if (detail.activity.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border p-3.5">
      <SectionHeading>Activity</SectionHeading>
      <BoardCardActivityRail agents={agents} entries={detail.activity} stages={stages} />
    </div>
  );
}

export interface BoardDetailThreadLink {
  readonly threadId: ThreadId;
  readonly role: string;
  readonly tombstoned: boolean;
  readonly title: string | null;
  readonly threadState: BoardCardThreadState;
  readonly awaitingInput: boolean;
}

export interface BoardCardDetailViewProps {
  readonly environmentId: EnvironmentId;
  readonly detail: BoardCardDetail;
  readonly catalogue: ReadonlyArray<BoardLabel>;
  /** The read-model stage list (D13): column labels, the stage ladder, and the
      per-card human-in-the-loop toggle's Build-role detection all read it. */
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  /** The computed human-in-the-loop stance for this card on the Build stage
      (D6) — `null` when the card is not on the build role (no toggle shown).
      `value` is the effective boolean; `explicit` is whether the card has an
      explicit override (vs the computed default). */
  readonly humanInLoop: { readonly value: boolean; readonly explicit: boolean } | null;
  readonly onSetHumanInLoop: (value: boolean) => void;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  /** Project title, or null when the project is not on disk (archived card). */
  readonly projectName: string | null;
  /** Branch of the card's active thread; null when nothing is running for it
      yet — the card itself owns no branch. */
  readonly branch: string | null;
  readonly dependencies: ReadonlyArray<BoardDetailDependency>;
  readonly dependencyOptions: ReadonlyArray<BoardPickerOption>;
  readonly threadLinks: ReadonlyArray<BoardDetailThreadLink>;
  /** Provider display names and accents for the Activity rail's agent actors
      (t3o-18, D11), resolved at render time so a renamed instance relabels its
      own history. */
  readonly agents?: BoardActivityAgentLookup | undefined;
  /** Each live-linked thread's cached todo list (t3o-18, D3), keyed by thread —
      the modal's per-tab counts and its sticky todos strip. */
  readonly threadTodos?: ReadonlyMap<ThreadId, BoardCardThreadShell> | undefined;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  /** The review loop's configured round cap, for the Review pane's R1..Rn bar
      (t3o-16). Absent falls back to the compiled default. */
  readonly reviewMaxRounds?: number | undefined;
  /** The card's own review-loop settings (t3o-22, D2). */
  readonly reviewOverrides?: BoardCardReviewOverrides | null | undefined;
  /** The highest round the card's loop has STARTED — the budget floor, matching
      the decider's (t3o-22, D3). */
  readonly reviewRoundsStarted?: number | undefined;
  /** Whether the executor is driving the card (running or queued for a slot). */
  readonly reviewStepActive?: boolean | undefined;
  readonly onResumeReview?: ((rounds: number) => void) | undefined;
  readonly onSetReviewRounds?: ((rounds: number) => void) | undefined;
  readonly onSetReviewRoundModel?:
    | ((round: number, model: BoardReviewRoundOverride | null) => void)
    | undefined;
  /** The review phase's effective access level (t3o-21), what a round override
      without its own inherits. */
  readonly reviewPhaseRuntimeMode?: RuntimeMode | undefined;
  readonly onStopAfterRound?: ((round: number | null) => void) | undefined;
  /** The thread pane `+` menu's restart affordance (t3o-14): present only when
      the card's current stage auto-executes, `null` otherwise. */
  readonly stageRestart: BoardThreadStageRestart | null;
  /** Dispatch `board.card.start-stage-thread` for the card's current stage. */
  readonly onRestartStage: () => void;
  /** Create a blank server thread, link it, and resolve to its id (or `null` on
      failure) so the pane can open it. */
  readonly onCreateBlankThread: () => Promise<ThreadId | null>;
  /** Inline feedback for the last rejected command (e.g. a dependency cycle). */
  readonly feedback: string | null;
  readonly onClose: () => void;
  readonly onSetLabels: (labelIds: ReadonlyArray<BoardLabelId>) => void;
  readonly onCreateLabel: (name: string) => void;
  readonly onRecolourLabel: (labelId: BoardLabelId, colour: string) => void;
  readonly onDeleteLabel: (labelId: BoardLabelId) => void;
  readonly onUndeleteLabel: (labelId: BoardLabelId) => void;
  readonly onSaveTitle: (title: string) => void;
  readonly onSaveBrief: (brief: string | null) => void;
  readonly onAddDependency: (cardId: BoardCardId) => void;
  readonly onRemoveDependency: (cardId: BoardCardId) => void;
  readonly onMoveStage: (toStage: BoardStageId) => void;
  /** Merge the card's pull request and advance it. */
  readonly onMergePullRequest: () => void;
  /** Open the pull request externally, and refresh its state while we are at
      it — clicking through is a moment the user is about to learn whether the
      card's link is stale, so it may as well not be. */
  readonly onOpenPullRequest: (url: string) => void;
  /** Whether a conflict-resolution step is running on this card. Nothing else
      runs in the merge stage, so a live step there can only be that. */
  readonly conflictStepRunning: boolean;
  /** Whether a merge kicked off from this card is still in flight — drives the
      Merge button's "Merging…" spinner and disables it so the several-second
      round trip can't be re-entered by a second click. */
  readonly merging: boolean;
  readonly onArchiveToggle: () => void;
  /** Purge the card outright. Always behind `BoardDeleteConfirmDialog` — the
      server does not ask, so this must never be reachable without one. */
  readonly onDelete: () => void;
  /** The plan pane's approve gate (t3o-23, D1): whether it renders, the
      floor stage's label for the confirm copy, and the dispatch. */
  readonly canApproveSplit: boolean;
  readonly approveSplitTargetLabel: string | null;
  readonly onApproveSplit: () => void;
  readonly onLinkThread: (threadId: ThreadId, role: string) => void;
  readonly onUnlinkThread: (threadId: ThreadId) => void;
  /** The parent this card is a child of (t3o-25), for the identity row's
      "part of" chip; null on top-level cards and when the parent is off the
      live board. */
  readonly parentCard?: { readonly cardId: string; readonly key: string } | null | undefined;
  /** Navigate into the parent's sub-board with this card's sheet open. */
  readonly onOpenParentSubBoard?: (() => void) | undefined;
  /** Navigate into THIS card's sub-board with one child's sheet open — the
      plan pane's child chips (t3o-25, AC4). */
  readonly onOpenChildInSubBoard?: ((childCardId: string) => void) | undefined;
}

export interface BoardCardDetailPanelProps extends BoardCardDetailViewProps {
  /** Fullscreen is the dialog's business, so the frame owns the flag and the
      pane's control just toggles it. */
  readonly maximised: boolean;
  readonly onToggleMaximised: () => void;
}

const THREAD_STATE_LABEL: Record<BoardCardThreadState, string> = {
  working: "Working",
  waiting: "Waiting",
  stopped: "Stopped",
  none: "Idle",
};

/**
 * The card's title, click-to-edit in place — the prototype's affordance, the
 * same one `BriefBody` has. The heading keeps `CARD_TITLE_ID` in both states so
 * the dialog stays labelled while the title is being typed.
 *
 * A blank title is a cancel, not a clear: `board.card.update` takes a non-empty
 * title, and a card with no title is nothing anyone can find again.
 */
function TitleBody({
  title,
  onSave,
}: {
  readonly title: string;
  readonly onSave: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const commit = () => {
    const trimmed = draft.replace(/\s+/g, " ").trim();
    if (trimmed.length > 0 && trimmed !== title) onSave(trimmed);
    setEditing(false);
  };
  const frame =
    "mx-2.5 mt-2 shrink-0 rounded-[7px] px-1.5 text-[21px]/[1.25] font-semibold tracking-[-0.015em] text-pretty text-foreground";
  if (editing) {
    return (
      <h2
        className={cn(frame, "flex bg-muted shadow-[0_0_0_1px_var(--primary)]")}
        id={CARD_TITLE_ID}
      >
        {/* A textarea, not an input: long titles wrap here exactly as they do
            at rest, so committing never reflows the sheet. */}
        <textarea
          autoFocus
          className="field-sizing-content w-full resize-none bg-transparent text-inherit outline-none"
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commit();
            }
          }}
          rows={1}
          value={draft}
        />
      </h2>
    );
  }
  return (
    <h2 className={cn(frame, "cursor-text hover:bg-accent")} id={CARD_TITLE_ID}>
      <button
        className="block w-full cursor-text text-left"
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        title="Click to edit"
        type="button"
      >
        {title}
      </button>
    </h2>
  );
}

function BriefBody({
  brief,
  onSave,
}: {
  readonly brief: string | null;
  readonly onSave: (brief: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(brief ?? "");
  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next !== (brief ?? null)) onSave(next);
    setEditing(false);
  };
  if (editing) {
    return (
      <Textarea
        autoFocus
        className="min-h-24 text-[13.5px]/[1.6]"
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(brief ?? "");
            setEditing(false);
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) commit();
        }}
        placeholder="Describe the work… (⌘⏎ to save, Esc to cancel)"
        value={draft}
      />
    );
  }
  // Click-to-edit in place, the prototype's affordance: the brief reads as
  // prose until you touch it, with the hover tint as the only hint.
  return (
    <button
      className="-mx-[7px] -my-1 rounded-lg px-[7px] py-1 text-left text-[13.5px]/[1.6] hover:bg-accent"
      onClick={() => {
        setDraft(brief ?? "");
        setEditing(true);
      }}
      title="Click to edit"
      type="button"
    >
      {brief === null ? (
        <span className="text-muted-foreground">Add a brief…</span>
      ) : (
        <span className="whitespace-pre-wrap text-pretty text-foreground">{brief}</span>
      )}
    </button>
  );
}

function DependenciesSection(props: BoardCardDetailViewProps) {
  return (
    <BoardDependencySection
      dependencies={props.dependencies}
      onAdd={props.onAddDependency}
      onRemove={props.onRemoveDependency}
      options={props.dependencyOptions}
      stages={props.stages}
    />
  );
}

/** The linked-thread list — the narrow form's stand-in for the thread pane,
    which is where adoption happens before the work starts. */
function ThreadsSection(props: BoardCardDetailViewProps) {
  const activeThreadId = activeBoardCardThreadId(props.detail.card.threadLinks);
  return (
    <>
      <div className="mb-[7px] flex items-center gap-1.5">
        <SectionHeading>Threads</SectionHeading>
        <BoardSearchAddPicker
          label="Adopt"
          onPick={(id) => props.onLinkThread(id as ThreadId, "linked")}
          options={props.adoptableThreads}
          placeholder="Search threads…"
        />
      </div>
      {props.threadLinks.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No linked threads.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {props.threadLinks.map((link) => (
            <li
              className="flex items-center gap-[9px] rounded-lg border border-border bg-muted px-2.5 py-[7px]"
              key={link.threadId}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "min-w-0 truncate text-[13px] text-foreground",
                      link.tombstoned && "text-muted-foreground line-through",
                    )}
                  >
                    {link.title ?? "Deleted thread"}
                  </span>
                  {link.awaitingInput ? (
                    <CircleAlertIcon className="size-3 shrink-0 text-info-foreground" />
                  ) : null}
                </div>
                <span className="text-[10.5px] text-muted-foreground">
                  {link.role}
                  {link.tombstoned ? " · deleted" : ` · ${THREAD_STATE_LABEL[link.threadState]}`}
                  {link.threadId === activeThreadId && !link.tombstoned ? " · active" : ""}
                </span>
              </div>
              {link.tombstoned ? null : (
                <Link
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  params={{ environmentId: props.environmentId, threadId: link.threadId }}
                  title="Open thread"
                  to="/$environmentId/$threadId"
                >
                  <ExternalLinkIcon className="size-3.5" />
                </Link>
              )}
              {link.tombstoned ? null : (
                <Button
                  onClick={() => props.onUnlinkThread(link.threadId)}
                  size="icon-xs"
                  title="Unlink thread"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Every stage, as a ladder — the current one ticked. Replaces a dropdown:
    the pipeline is the board's spine, so it reads better as a visible list
    than as a collapsed select. */
function StageLadder({
  stage,
  stages,
  onMoveStage,
}: {
  readonly stage: BoardStageId;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly onMoveStage: (toStage: BoardStageId) => void;
}) {
  return (
    <div className="flex flex-col gap-px">
      {boardStagesInOrder(stageStateOf(stages)).map((candidate) => {
        const current = candidate.stageId === stage;
        const rung = (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/45" />
            <span className="flex-1 text-left">{candidate.label}</span>
            {current ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          </>
        );
        const className = cn(
          "flex h-[26px] items-center gap-2 rounded-[7px] px-2 text-[12.5px]",
          current ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
        );
        // The build role onward is granted by the pipeline, not chosen — those
        // rungs render as plain rows so the ladder still reads whole.
        if (current || !isBoardStageManuallySelectable(stages, candidate.stageId)) {
          return (
            <div
              aria-current={current ? "true" : undefined}
              className={className}
              key={candidate.stageId}
            >
              {rung}
            </div>
          );
        }
        return (
          <button
            className={cn(className, "hover:bg-accent/50")}
            key={candidate.stageId}
            onClick={() => onMoveStage(candidate.stageId)}
            type="button"
          >
            {rung}
          </button>
        );
      })}
    </div>
  );
}

/** The card's labels as pills over one autocomplete — `BoardLabelField`. */
function LabelSection({
  selected,
  catalogue,
  onSetLabels,
  onCreateLabel,
  onRecolourLabel,
  onDeleteLabel,
  onUndeleteLabel,
}: {
  readonly selected: ReadonlyArray<BoardLabelId>;
  readonly catalogue: ReadonlyArray<BoardLabel>;
  readonly onSetLabels: (labelIds: ReadonlyArray<BoardLabelId>) => void;
  readonly onCreateLabel: (name: string) => void;
  readonly onRecolourLabel: (labelId: BoardLabelId, colour: string) => void;
  readonly onDeleteLabel: (labelId: BoardLabelId) => void;
  readonly onUndeleteLabel: (labelId: BoardLabelId) => void;
}) {
  return (
    <>
      <SectionHeading>Label</SectionHeading>
      <BoardLabelField
        catalogue={catalogue}
        onCreate={onCreateLabel}
        onDelete={onDeleteLabel}
        onRecolour={onRecolourLabel}
        onToggle={(labelId) =>
          onSetLabels(
            selected.includes(labelId)
              ? selected.filter((id) => id !== labelId)
              : [...selected, labelId],
          )
        }
        onUndelete={onUndeleteLabel}
        selectedLabelIds={selected}
      />
    </>
  );
}

/** Stage action, blocked reason and archive — the things you *do* to a card,
    kept together at the top of the rail. */
function ActionsSection({
  props,
  unmet,
}: {
  readonly props: BoardCardDetailViewProps;
  readonly unmet: ReadonlyArray<BoardDetailDependency>;
}) {
  const { card } = props.detail;
  const archived = card.archivedAt !== null;
  // Two different pull requests, deliberately.
  //
  // `pullRequest` is the CURRENT round's — the only one the Merge button may
  // ever act on, because acting on a round the card has already finished is
  // precisely what `pullRequestFloor` exists to prevent.
  //
  // `displayed` falls back to the newest retired round, so a card that has been
  // dragged back out of Done and is being worked on again still LINKS the pull
  // request that merged last time, right up until its new round opens one.
  const pullRequest = card.pullRequest;
  const displayed = boardCardDisplayPullRequest(card);
  const primaryAction = boardStagePrimaryAction(props.stages, card.stage, {
    pullRequestState: pullRequest?.state ?? null,
    pullRequestNumber: pullRequest?.number ?? null,
    conflictStepRunning: props.conflictStepRunning,
  });
  const forward = primaryAction !== null && !archived ? primaryAction : null;
  // "Stop after this round" (t3o-22, D8): offered only while a review loop is
  // actually mid-flight — there is nothing to stop after otherwise, and a card
  // that has never reached review must not show it at all. Toggling it off
  // re-sends null, which the decider reads as "run on".
  const reviewLoop =
    archived || props.onStopAfterRound === undefined
      ? null
      : hasBoardReviewSteps(props.detail.stepCompletions)
        ? deriveBoardReviewLoop(
            props.detail.stepCompletions,
            props.reviewMaxRounds ?? DEFAULT_BOARD_REVIEW_ROUNDS,
            props.reviewOverrides?.stopAfterRound ?? null,
          )
        : null;
  const onStopAfterRound = props.onStopAfterRound;
  const stopRound =
    reviewLoop === null || reviewLoop.status !== "running" || onStopAfterRound === undefined
      ? null
      : {
          round: reviewLoop.currentRound,
          pending: props.reviewOverrides?.stopAfterRound === reviewLoop.currentRound,
          onToggle: onStopAfterRound,
        };
  // A merge from this card is mid-flight: the button holds its spot but shows a
  // spinner and refuses further clicks until the round trip settles.
  const merging = forward?.kind === "merge" && props.merging;
  // The per-card human-in-the-loop toggle shows only on the Build role (D6);
  // `props.humanInLoop` is non-null exactly then.
  const humanInLoop = archived ? null : props.humanInLoop;
  // The View PR link renders at every stage (including Done, past any forward
  // action), so keep the section alive whenever a PR is linked — otherwise the
  // link vanishes exactly when a merged card lands in Done.
  if (
    forward === null &&
    !card.blocked &&
    humanInLoop === null &&
    displayed === null &&
    stopRound === null
  ) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2 p-3.5">
      {stopRound !== null ? (
        <button
          className={cn(
            "inline-flex h-8 items-center justify-center gap-[7px] rounded-lg border px-2.75 text-[13px] font-medium shadow-xs",
            stopRound.pending
              ? "border-amber-500/55 bg-amber-500/12 text-amber-700 dark:text-amber-300"
              : "border-input bg-popover text-foreground hover:bg-accent",
          )}
          onClick={() => stopRound.onToggle(stopRound.pending ? null : stopRound.round)}
          title={
            stopRound.pending
              ? `Round ${stopRound.round} finishes, then the loop holds for you`
              : "Let the current round finish, then hold instead of starting another"
          }
          type="button"
        >
          <SquareIcon className="size-3" />
          {stopRound.pending ? `Stopping after round ${stopRound.round}` : "Stop after this round"}
        </button>
      ) : null}
      {forward !== null ? (
        <button
          className={cn(
            "inline-flex h-[34px] items-center justify-center gap-[7px] rounded-lg border px-3 text-[13px] font-medium shadow-xs",
            forward.emphasised
              ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
              : "border-input bg-popover text-foreground hover:bg-accent",
            // The dependency gate is not overridable (D18) — the button says
            // so rather than bouncing off the decider.
            (card.blocked || (forward.kind === "merge" && forward.disabled)) &&
              "cursor-not-allowed opacity-50",
            merging && "cursor-wait",
          )}
          disabled={
            card.blocked || (forward.kind === "merge" && (forward.disabled || props.merging))
          }
          onClick={() => {
            if (forward.kind === "merge") {
              props.onMergePullRequest();
              return;
            }
            props.onMoveStage(forward.toStage);
          }}
          title={
            card.blocked
              ? "Blocked by unmet dependencies"
              : forward.kind === "merge"
                ? (forward.disabledReason ?? undefined)
                : undefined
          }
          type="button"
        >
          {merging ? (
            <>
              <span className="size-3.5 shrink-0 animate-spin rounded-full border-[1.7px] border-primary-foreground/40 border-t-primary-foreground" />
              Merging…
            </>
          ) : (
            <>
              <ArrowRightIcon className="size-3.5" />
              {forward.label}
            </>
          )}
        </button>
      ) : null}
      {/* The card's pull request, at EVERY stage rather than only where the
          Merge button lives: a card in Done is exactly when you want to find
          the change that closed it. Only the number rides the card shell, so
          this link — which needs the URL — lives here on the detail, which
          already subscribes to the whole card. */}
      {displayed !== null ? (
        <button
          className="inline-flex h-[34px] items-center justify-center gap-[7px] rounded-lg border border-input bg-popover px-3 text-[13px] font-medium text-foreground shadow-xs hover:bg-accent"
          onClick={() => props.onOpenPullRequest(displayed.url)}
          title={`Open pull request #${displayed.number}`}
          type="button"
        >
          <GitPullRequestIcon className="size-3.5" />
          <span>View PR</span>
          <span className="text-muted-foreground">{`#${displayed.number}`}</span>
        </button>
      ) : null}
      {card.blocked ? (
        <div className="flex gap-[7px] rounded-lg border border-warning/35 bg-warning/8 px-2.5 py-2.5 text-[11.5px]/[1.45] text-warning-foreground">
          <LockIcon className="mt-px size-3.5 shrink-0" />
          <span>
            {unmet.length === 0
              ? "Blocked by unmet dependencies"
              : `Blocked by ${unmet.map((dependency) => dependency.key).join(", ")}`}
          </span>
        </div>
      ) : null}
      {humanInLoop !== null ? (
        <label className="flex items-center justify-between gap-2 rounded-lg border border-input bg-popover px-2.5 py-2 text-[12.5px]">
          <span className="flex flex-col">
            <span className="font-medium text-foreground">Human in the loop</span>
            <span className="text-[11px] text-muted-foreground">
              {humanInLoop.explicit
                ? humanInLoop.value
                  ? "You drive the build in conversation."
                  : "The build runs unattended."
                : humanInLoop.value
                  ? "Default: conversation (no plan yet)."
                  : "Default: unattended (a plan exists)."}
            </span>
          </span>
          <input
            aria-label="Human in the loop"
            checked={humanInLoop.value}
            className="size-4 shrink-0"
            onChange={(event) => props.onSetHumanInLoop(event.target.checked)}
            type="checkbox"
          />
        </label>
      ) : null}
    </div>
  );
}

function InfoSection({ props }: { readonly props: BoardCardDetailViewProps }) {
  return (
    <div className="border-t border-border p-3.5 text-[11.5px]/[1.7] text-muted-foreground">
      <div>
        Project ·{" "}
        <span className="text-foreground">{props.projectName ?? "Project not on disk"}</span>
      </div>
      {props.branch === null ? null : (
        <div>
          Branch · <span className="text-foreground">{props.branch}</span>
        </div>
      )}
      <div>Created · {formatRelativeTimeLabel(props.detail.card.createdAt)}</div>
    </div>
  );
}

type BoardCardPane = "thread" | "review" | "plan" | "brief";

/** Whether the card has reached the review-role stage — from there on the loop
    is what the card is about, so the modal opens on the Review pane. */
function isStageAtOrAfterReview(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
): boolean {
  const state = stageStateOf(stages);
  const review = boardStageWithRole(state, "review");
  if (review === null) return false;
  const reviewIndex = boardStageIndex(state, review.stageId);
  const stageIndex = boardStageIndex(state, stage);
  return reviewIndex >= 0 && stageIndex >= reviewIndex;
}

/**
 * The pane a card opens on: the latest surface its stage has produced.
 * Planning and Ready open on the conversation, Build on its build thread, and
 * Code review / Ready for merge / Done on the review pane. A card that reached
 * those stages without ever running the loop has no review to show, so the
 * caller's `hasReview` fallback lands it back on the thread.
 */
export function initialBoardCardPane(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
): BoardCardPane {
  return isStageAtOrAfterReview(stages, stage) ? "review" : "thread";
}

/**
 * The thread a card opens on before it reaches the review stages: the newest
 * live one the card's stage has any business showing — so Planning and Ready
 * land on the planning conversation and Build on the build one, and a card
 * dragged back from Build to Planning shows planning again rather than the
 * build run it left behind.
 *
 * A stage step links its thread under the step id, and a stage step's id IS
 * the stage id, so a link's role names the stage that spawned it: a role from
 * a LATER stage is stale here and drops out, as does a review-loop role
 * (`review@1`, …), which belongs to a pass the card has moved on from. A role
 * that is neither — an adopted or blank thread's `linked` — belongs to no
 * stage, so it stays and, being newest, opens.
 *
 * From the review stage onward the loop owns the card and the Review pane is
 * what opens, so the thread pane keeps its old answer there: the card's active
 * thread, the most recently linked live one.
 */
export function initialBoardCardThreadId(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
  links: ReadonlyArray<BoardCardThreadLink>,
): ThreadId | null {
  const active = activeBoardCardThreadId(links);
  const state = stageStateOf(stages);
  const stageIndex = boardStageIndex(state, stage);
  if (stageIndex < 0 || isStageAtOrAfterReview(stages, stage)) return active;
  const current = sortBoardCardThreadLinks(
    links.filter((link) => link.tombstonedAt === null),
  ).filter((link) => {
    if (parseReviewStepId(link.role) !== null) return false;
    const linkStageIndex = boardStageIndex(state, link.role as BoardStageId);
    return linkStageIndex <= stageIndex;
  });
  return current.at(-1)?.threadId ?? active;
}

/** The header's Thread/Review/Plan/Brief switch — only the wide form has one,
    because only it has somewhere else for the brief to live. The Review pill
    appears once the card is on the review stage or carries review-loop
    completions; the Plan pill once the card has a plan. Before either there is
    nothing to show, so the switch is a plain Thread/Brief pair. */
function PaneTabs({
  pane,
  hasReview,
  hasPlan,
  onSelect,
}: {
  readonly pane: BoardCardPane;
  readonly hasReview: boolean;
  readonly hasPlan: boolean;
  readonly onSelect: (pane: BoardCardPane) => void;
}) {
  const tab = (value: BoardCardPane) =>
    cn(
      "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 text-[11.5px]",
      pane === value
        ? "bg-card font-medium text-foreground shadow-[0_0_0_1px_var(--border)]"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-[9px] bg-accent p-0.5">
      <button className={tab("thread")} onClick={() => onSelect("thread")} type="button">
        <MessageSquareIcon className="size-3" />
        Thread
      </button>
      {hasReview ? (
        <button
          className={tab("review")}
          onClick={() => onSelect("review")}
          title="Adversarial review loop"
          type="button"
        >
          <RefreshCcwIcon className="size-3" />
          Review
        </button>
      ) : null}
      {hasPlan ? (
        <button className={tab("plan")} onClick={() => onSelect("plan")} type="button">
          <FileIcon className="size-3" />
          Plan
        </button>
      ) : null}
      <button className={tab("brief")} onClick={() => onSelect("brief")} type="button">
        <FileTextIcon className="size-3" />
        Brief
      </button>
    </div>
  );
}

export function BoardCardDetailPanel(props: BoardCardDetailPanelProps) {
  const { card } = props.detail;
  const archived = card.archivedAt !== null;
  const wide = boardCardHasThreadPane(props.stages, card.stage);
  // The contracts' definition of unmet, mirrored: an unknown id counts as
  // unmet (nothing can prove it finished), an archived dependency does not
  // count at all (t3o-13, D1), and everything else must be done.
  const unmet = props.dependencies.filter(
    (dependency) => !dependency.known || (!dependency.archived && dependency.stage !== "done"),
  );

  // Archiving a not-done card that live cards depend on asks first (D3); every
  // other archive, and every restore, is a single click.
  const liveDependents = liveBoardCardDependents(props.detail.dependents);
  const archiveNeedsConfirmation = boardCardArchiveNeedsConfirmation({
    stage: card.stage,
    dependents: props.detail.dependents,
  });
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Null means "whatever the card's stage says is latest" (Planning/Ready and
  // Build open on the thread, the review stages on the Review pane): the modal
  // opens there and keeps tracking the card until the user picks a pane, which
  // pins it.
  const [paneChoice, setPane] = useState<BoardCardPane | null>(null);
  const pane = paneChoice ?? initialBoardCardPane(props.stages, card.stage);
  // The plan is a first-class entity, so its pill only exists once one is
  // written; if the card loses its plans while the pane is open, fall back to
  // the thread rather than render an empty surface. The review pane follows
  // the same rule: it exists once the card is on the review-role stage or
  // carries review-loop completions (past reviews stay readable after the
  // card moves on).
  const hasPlan = props.detail.plans.length > 0;
  const reviewStageId = boardStageWithRole(stageStateOf(props.stages), "review")?.stageId ?? null;
  const hasReview =
    (reviewStageId !== null && card.stage === reviewStageId) ||
    hasBoardReviewSteps(props.detail.stepCompletions);
  const activePane: BoardCardPane =
    (pane === "plan" && !hasPlan) || (pane === "review" && !hasReview) ? "thread" : pane;
  // Which tab the thread pane is on. Absent means "whichever thread the card's
  // stage makes current", so the pane follows the card until the user picks a
  // thread, and a since-unlinked selection falls back to that same default.
  const [selectedThreadId, setSelectedThreadId] = useState<ThreadId | null>(null);
  const activeThreadId = activeBoardCardThreadId(card.threadLinks);
  const selectedThread =
    props.threadLinks.find((link) => link.threadId === selectedThreadId)?.threadId ??
    initialBoardCardThreadId(props.stages, card.stage, card.threadLinks);

  return (
    <>
      {/* Identity row: key, the card's labels, its stage. */}
      <div className="flex shrink-0 items-center gap-[9px] px-4 pt-4">
        <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground">{card.key}</span>
        {props.parentCard != null ? (
          // "Part of <parent>" (t3o-25, AC4): the chip is the child's door
          // back into the sub-board it lives on, with this sheet still open.
          <button
            className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-muted-foreground/14 px-[7px] text-[11px] font-medium text-foreground hover:bg-muted-foreground/25 disabled:pointer-events-none"
            disabled={props.onOpenParentSubBoard === undefined}
            onClick={props.onOpenParentSubBoard}
            title={`Part of ${props.parentCard.key}'s sub-board — open it`}
            type="button"
          >
            <LayersIcon className="size-2.5" />
            {props.parentCard.key}
          </button>
        ) : null}
        <BoardLabelChips labelIds={card.labels} labelsById={props.labelsById} />
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-muted-foreground/14 px-[7px] text-[11px] font-medium text-foreground">
          {boardStageLabel(props.stages, card.stage)}
        </span>
        {archived ? (
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-muted px-[7px] text-[11px] font-medium text-muted-foreground">
            Archived
          </span>
        ) : null}
        <span className="flex-1" />
        {wide ? (
          <PaneTabs hasPlan={hasPlan} hasReview={hasReview} onSelect={setPane} pane={activePane} />
        ) : null}
        <Menu>
          <MenuTrigger
            aria-label="More actions"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
            title="More actions"
          >
            <EllipsisVerticalIcon className="size-[15px]" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-42">
            <MenuItem
              onClick={() => {
                if (!archived && archiveNeedsConfirmation) {
                  setArchiveConfirmOpen(true);
                  return;
                }
                props.onArchiveToggle();
              }}
            >
              {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {archived ? "Restore card" : "Archive card"}
            </MenuItem>
            {/* Unconditionally confirmed, unlike archive: there is no version
                of this the user can undo if they meant something else. */}
            <MenuItem onClick={() => setDeleteConfirmOpen(true)} variant="destructive">
              <Trash2Icon />
              Delete card…
            </MenuItem>
          </MenuPopup>
        </Menu>
        <BoardArchiveConfirmDialog
          cardKey={card.key}
          dependents={liveDependents}
          onConfirm={props.onArchiveToggle}
          onOpenChange={setArchiveConfirmOpen}
          open={archiveConfirmOpen}
        />
        <BoardDeleteConfirmDialog
          branch={card.worktree?.branch ?? null}
          cardKey={card.key}
          dependents={liveDependents}
          onConfirm={props.onDelete}
          onOpenChange={setDeleteConfirmOpen}
          open={deleteConfirmOpen}
          threadCount={card.threadLinks.length}
        />
        <button
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={props.onClose}
          title="Close"
          type="button"
        >
          <XIcon className="size-[15px]" />
        </button>
      </div>

      <TitleBody onSave={props.onSaveTitle} title={card.title} />

      {wide ? (
        <div className="mt-3 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_336px] border-t border-border">
          {activePane === "brief" ? (
            <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3.5 pr-3">
                <SectionHeading>Brief</SectionHeading>
                <span className="flex-1" />
                <button
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover pl-1.5 pr-2.5 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
                  onClick={() => setPane("thread")}
                  type="button"
                >
                  <ChevronLeftIcon className="size-3" />
                  Back to thread
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4 pb-6">
                <BriefBody brief={props.detail.brief} onSave={props.onSaveBrief} />
              </div>
            </section>
          ) : activePane === "review" ? (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardReviewPane
                completions={props.detail.stepCompletions}
                // "Running now" means the loop's own step is live: the ACTIVE
                // linked thread is the one a running phase owns, so only its
                // state drives the spinner — a side conversation on another
                // linked thread must not.
                live={props.threadLinks.some(
                  (link) => link.threadId === activeThreadId && link.threadState === "working",
                )}
                maxRounds={props.reviewMaxRounds ?? DEFAULT_BOARD_REVIEW_ROUNDS}
                onAdvance={(() => {
                  // "Advance anyway" is an ordinary stage move, gated exactly
                  // like every other transition (t3o-22, D8) — the button
                  // exists because a held loop will never make the move on its
                  // own, not because the move is special.
                  const next = boardNextStageId(stageStateOf(props.stages), card.stage);
                  return next === null || card.blocked ? undefined : () => props.onMoveStage(next);
                })()}
                onBackToThread={() => setPane("thread")}
                onSetRoundModel={props.onSetReviewRoundModel}
                phaseRuntimeMode={props.reviewPhaseRuntimeMode}
                onResume={props.onResumeReview}
                onSetRounds={props.onSetReviewRounds}
                overrides={props.reviewOverrides}
                roundsStarted={props.reviewRoundsStarted}
                stepActive={props.reviewStepActive}
                onOpenThread={(threadId) => {
                  setSelectedThreadId(threadId);
                  setPane("thread");
                }}
              />
            </Suspense>
          ) : activePane === "plan" ? (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardPlanPane
                cardKey={card.key}
                onBackToThread={() => setPane("thread")}
                plans={props.detail.plans}
                childCards={props.detail.children}
                stages={props.stages}
                canApproveSplit={props.canApproveSplit}
                approveTargetLabel={props.approveSplitTargetLabel}
                onApproveSplit={props.onApproveSplit}
                onOpenChild={props.onOpenChildInSubBoard}
              />
            </Suspense>
          ) : (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardThreadPane
                adoptableThreads={props.adoptableThreads}
                cardKey={card.key}
                environmentId={props.environmentId}
                maximised={props.maximised}
                onCreateBlankThread={props.onCreateBlankThread}
                onLinkThread={props.onLinkThread}
                onRestartStage={props.onRestartStage}
                onSelectThread={setSelectedThreadId}
                onToggleMaximised={props.onToggleMaximised}
                onUnlinkThread={props.onUnlinkThread}
                selectedThreadId={selectedThread}
                stageRestart={props.stageRestart}
                threadLinks={props.threadLinks}
                threadTodos={props.threadTodos}
              />
            </Suspense>
          )}

          {/* The rail: everything about the card that is not the conversation. */}
          <div className="flex min-h-0 flex-col overflow-y-auto [&>*:first-child]:border-t-0">
            <ActionsSection props={props} unmet={unmet} />
            {props.feedback !== null ? (
              <p className="mx-3.5 mb-3.5 rounded-md bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive-foreground">
                {props.feedback}
              </p>
            ) : null}
            <div className="border-t border-border p-3.5">
              <DependenciesSection {...props} />
            </div>
            <ActivitySection agents={props.agents} detail={props.detail} stages={props.stages} />
            <div className="flex flex-col gap-2 border-t border-border p-3.5">
              <LabelSection
                catalogue={props.catalogue}
                onCreateLabel={props.onCreateLabel}
                onDeleteLabel={props.onDeleteLabel}
                onRecolourLabel={props.onRecolourLabel}
                onSetLabels={props.onSetLabels}
                onUndeleteLabel={props.onUndeleteLabel}
                selected={card.labels}
              />
            </div>
            <div className="flex flex-col gap-2 border-t border-border p-3.5">
              <SectionHeading>Stage</SectionHeading>
              <StageLadder
                onMoveStage={props.onMoveStage}
                stage={card.stage}
                stages={props.stages}
              />
            </div>
            <InfoSection props={props} />
          </div>
        </div>
      ) : (
        <div className="mt-3 flex min-h-0 flex-[0_1_auto] flex-col overflow-y-auto border-t border-border">
          <div className="flex items-stretch">
            {/* ── Left: what the card is ─────────────────────────────── */}
            <div className="flex min-w-0 flex-1 flex-col gap-[18px] px-5 pt-4 pb-5">
              {props.feedback !== null ? (
                <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive-foreground">
                  {props.feedback}
                </p>
              ) : null}

              <div className="min-w-0">
                <SectionHeading className="mb-[7px]">Brief</SectionHeading>
                <BriefBody brief={props.detail.brief} onSave={props.onSaveBrief} />
              </div>

              <div className="min-w-0">
                <DependenciesSection {...props} />
              </div>

              {/* The mockup's pre-Planning card has no Threads section —
                  adoption belongs to the thread pane. A card that already
                  carries links still shows them, so state is never hidden. */}
              {props.threadLinks.length === 0 ? null : (
                <div className="min-w-0">
                  <ThreadsSection {...props} />
                </div>
              )}

              {props.detail.activity.length === 0 ? null : (
                <div className="min-w-0">
                  <SectionHeading className="mb-[7px]">Activity</SectionHeading>
                  <BoardCardActivityRail
                    agents={props.agents}
                    entries={props.detail.activity}
                    stages={props.stages}
                  />
                </div>
              )}
            </div>

            {/* ── Right: what you can do with it ──────────────────────── */}
            <div className="flex w-[244px] shrink-0 flex-col border-l border-border [&>*:first-child]:border-t-0">
              <ActionsSection props={props} unmet={unmet} />
              <div className="flex flex-col gap-2 border-t border-border p-3.5">
                <LabelSection
                  catalogue={props.catalogue}
                  onCreateLabel={props.onCreateLabel}
                  onDeleteLabel={props.onDeleteLabel}
                  onRecolourLabel={props.onRecolourLabel}
                  onSetLabels={props.onSetLabels}
                  onUndeleteLabel={props.onUndeleteLabel}
                  selected={card.labels}
                />
              </div>
              <div className="flex flex-col gap-2 border-t border-border p-3.5">
                <SectionHeading>Stage</SectionHeading>
                <StageLadder
                  onMoveStage={props.onMoveStage}
                  stage={card.stage}
                  stages={props.stages}
                />
              </div>
              <InfoSection props={props} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function BoardCardDetailView(props: BoardCardDetailViewProps) {
  const [maximised, setMaximised] = useState(false);
  const wide = boardCardHasThreadPane(props.stages, props.detail.card.stage);
  const done = boardCardIsDone(props.stages, props.detail.card.stage);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <BoardCardDetailPopup
        cardId={props.detail.card.id}
        done={done}
        maximised={wide && maximised}
        wide={wide}
      >
        <BoardCardDetailPanel
          {...props}
          maximised={maximised}
          onToggleMaximised={() => setMaximised((current) => !current)}
        />
      </BoardCardDetailPopup>
    </Dialog>
  );
}

/** The sheet itself: the prototype's card modal — 760px while the card is
    still a plan, 1220px once a thread runs in it, edge-to-edge in fullscreen.
    Shared with the loading state so the frame never jumps once the detail
    arrives. */
export function BoardCardDetailPopup({
  cardId,
  wide = false,
  maximised = false,
  done = false,
  children,
}: {
  readonly cardId: BoardCardId | null;
  readonly wide?: boolean;
  readonly maximised?: boolean;
  readonly done?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <DialogPopup
      aria-labelledby={CARD_TITLE_ID}
      className={cn(
        "overflow-hidden p-0",
        done && "board-card-done",
        maximised
          ? "fixed inset-0 h-screen max-h-none w-screen max-w-none rounded-none border-0"
          : wide
            ? "h-[86vh] max-h-[86vh] w-[min(1220px,100%)] max-w-[1220px]"
            : "max-h-[86vh] w-[min(760px,100%)] max-w-[760px]",
      )}
      showCloseButton={false}
      {...(cardId === null ? {} : { "data-board-card-detail": cardId })}
    >
      {children}
    </DialogPopup>
  );
}
