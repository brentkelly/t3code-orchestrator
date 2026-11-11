/**
 * Pure view: everything the modal renders is a prop. It renders from
 * `board.subscribeCard` detail (the column view never does) and never reads
 * the repo, so an archived card with no worktree (`projectName === null`) works.
 */
import {
  DEFAULT_BOARD_REVIEW_ROUNDS,
  activeBoardCardThreadId,
  BOARD_SEED_STAGE_IDS,
  isBoardCardAwaitingPermission,
  BOARD_AUTO_MERGE_MAX_ATTEMPTS,
  boardCardArchiveNeedsConfirmation,
  boardCardDisplayPullRequest,
  boardCardPullRequestIsOpenDraft,
  boardCardHasLiveBranch,
  boardStageIndex,
  boardStagesInOrder,
  boardStageById,
  boardStageWithRole,
  effectiveBoardStageRole,
  isBoardDeferredStage,
  isBoardStageAtOrAfterBuild,
  liveBoardCardDependents,
  parseReviewStepId,
  sortBoardCardThreadLinks,
  BOARD_CARD_ATTACHMENTS_MAX,
  type BoardCardAttachment,
  type BoardCardDetail,
  type BoardCardId,
  type BoardCardProjectLock,
  type BoardCardShell,
  type BoardReviewCarryRuling,
  type BoardCardThreadLink,
  type BoardCardThreadShell,
  type BoardCardThreadState,
  type BoardLabel,
  type BoardCardPlanReview,
  BOARD_PLAN_REVIEW_ROUNDS_MAX,
  BOARD_PLAN_REVIEW_ROUNDS_MIN,
  type BoardLabelId,
  type BoardStageDefinition,
  type BoardCardModelOverrides,
  type BoardMergeStrategy,
  type BoardCardStageModelOverride,
  type BoardSettings,
  type BoardStageId,
  type BoardState,
  type EnvironmentId,
  type ProjectIconColor,
  type ProjectId,
  type ThreadId,
  type BoardCardReviewOverrides,
  type BoardReviewRoundOverride,
  type RuntimeMode,
  type BoardCardStepStalledReason,
  type BoardSplitRecommendation,
  isLiveBoardCardThreadLink,
  type BoardProjectExecutionConfig,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Debouncer } from "@tanstack/react-pacer";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  ClockIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  FileIcon,
  FileTextIcon,
  ArrowUpIcon,
  LayersIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  LockIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  SquareIcon,
  PlayIcon,
  RefreshCcwIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  MergeIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { useNowSecond } from "../hooks/useNowSecond";
import { useStableCallback } from "../hooks/useStableCallback";
import { Fragment, Suspense, lazy, useEffect, useState, type ReactNode } from "react";

import { BoardCardNavRails, useBoardCardNavKeys, type BoardCardNav } from "./BoardCardNavRails";
import { useBoardUiStore } from "./boardUiStore";
import { Button } from "../components/ui/button";
import { Dialog, DialogPopup } from "../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import {
  boardCardModelOverrideSummary,
  boardCardModelRows,
  hasBoardCardModelOverride,
  type BoardCardModelRowSpec,
} from "./boardCardModelRows";
import { boardCardMergeStrategyView } from "./boardCardMergeStrategy";
import { Switch } from "../components/ui/switch";
import { NumberStepper } from "../components/settings/BoardPipelineSection";
import { nextBoardCardPlanReview, type BoardCardPlanReviewView } from "./boardCardPlanReview";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { BoardArchiveConfirmDialog } from "./BoardArchiveConfirmDialog";
import { BoardBaseBranchConfirmDialog } from "./BoardBaseBranchConfirmDialog";
import { BoardBaseBranchSelect } from "./BoardBaseBranchSelect";
import { BoardCardWorkerRow } from "./workers/BoardCardWorkerRow";
import { boardBriefDisplayText } from "./boardBriefDisplay";
import { BoardCardProjectConfirmDialog } from "./BoardCardProjectConfirmDialog";
import { BoardCardProjectRowValue, type BoardProjectOption } from "./BoardCardProjectSelect";
import {
  BoardBriefAttachRow,
  BoardBriefThumbnailStrip,
  boardBriefDropClass,
  useBoardBriefAttachments,
} from "./BoardBriefAttachments";
import type { BoardAttachmentLimits, BoardPendingUpload } from "./boardAttachmentUpload";
import { BoardDeleteConfirmDialog } from "./BoardDeleteConfirmDialog";
import { BoardLabelChips } from "./BoardLabelChips";
import { BoardLabelField } from "./BoardLabelField";
import { BoardLinkPullRequest } from "./BoardLinkPullRequest";
import {
  BoardCollapsibleSection,
  BoardDependencySection,
  BoardSectionHeading as SectionHeading,
  type BoardDependencyEntry,
} from "./BoardCardFields";
import { BoardSearchAddPicker, type BoardPickerOption } from "./BoardSearchAddPicker";
import { BoardCardStepFailure } from "./BoardCardStepFailure";
import { BoardCardWorktreeKept } from "./BoardCardWorktreeKept";
import { BoardCardStepPaused } from "./BoardCardStepPaused";
import { type BoardConflictFixInfo } from "./boardConflictFix";
import {
  boardAutoMergeBanner,
  boardAutoMergeCountdown,
  boardAutoMergeHeaderChip,
  type BoardAutoMergeBanner,
} from "./boardAutoMergeHold";
import type { BoardAdoptSearch, BoardThreadStageRestart } from "./BoardCardThreadAddMenu";
import { BoardCardActivityRail, type BoardActivityAgentLookup } from "./BoardCardActivityRail";
import { deriveBoardReviewLoop, hasBoardReviewSteps } from "./boardReviewLoop";
import { boardCiSentBackBanner, isBoardCiLive } from "./boardCi";
import { deriveBoardPlanRows } from "./boardPlanRows";
import { boardCardHasSummaryPane, deriveBoardCardWorkSummary } from "./boardCardWorkSummary";
import { boardStageLabel } from "./boardStages";
import type { BoardQueueInfo } from "./boardQueueInfo";
import {
  boardCiAwareNextStageId,
  boardStagePrimaryAction,
  boardStageSecondaryActions,
  isBoardStageManuallySelectable,
  type BoardStageSecondaryAction,
} from "./boardStageActions";
import { BoardCardSchedulePopover } from "./BoardCardSchedulePopover";
import type { BoardScheduleKind } from "./boardSchedule";
import { boardCardMoveBlocked } from "./boardCardMoveGate";
import { BoardHint } from "./BoardHint";
import { BoardDecisionLog } from "./BoardDecisionLog";
import { boardDecisionFollowUp, boardDecisionLogView } from "./boardDecisionLog";
import { BOARD_DEFERRED_STAGE } from "./boardScope";
import { BoardSplitGate } from "./BoardSplitGate";
import { boardGroupUsesCardActions } from "./boardGroups";
import { BOARD_SPLIT_CHANGE_REQUEST_PREFILL, type BoardSplitGateSettings } from "./boardSplitGate";
import { useComposerDraftStore } from "../composerDraftStore";
import { threadWorkerOpensOn, type BoardThreadWorker } from "./workers/threadWorker";
import {
  boardForwardShownBesideRecovery,
  boardReviewPaneStopped,
  resolveBoardStepRecovery,
  type BoardStepRecovery,
} from "./boardStepRecovery";

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
 * The Plans panel: the plan pane a split parent gets once its
 * children exist. Lazy for the same reason as its siblings — it pulls in the
 * dependency chart, which no card without a split will ever draw.
 */
const BoardPlansPanel = lazy(() =>
  import("./BoardPlansPanel").then((module) => ({ default: module.BoardPlansPanel })),
);

/**
 * The review pane renders the adversarial review loop — rounds,
 * phase progress and findings from the card's step completions. Lazy like its
 * siblings: a card that never reaches review pays nothing for it.
 */
const BoardCardCiPane = lazy(() =>
  import("./BoardCardCiPane").then((module) => ({ default: module.BoardCardCiPane })),
);
const BoardCardReviewPane = lazy(() =>
  import("./BoardCardReviewPane").then((module) => ({ default: module.BoardCardReviewPane })),
);

/**
 * The Summary pane: a derived recap of how the work went. Lazy like
 * Review — a card that never reaches review (and has no PR) never pays for it.
 */
const BoardCardSummaryPane = lazy(() =>
  import("./BoardCardSummaryPane").then((module) => ({ default: module.BoardCardSummaryPane })),
);

/**
 * Lazy: it pulls the model list, traits menu and access picker, and most cards
 * never open it. The kebab's summary comes from the eager, picker-free
 * `boardCardModelRows`.
 */
const BoardCardModelsPopover = lazy(() =>
  import("./BoardCardModelsPopover").then((module) => ({
    default: module.BoardCardModelsPopover,
  })),
);

/** The per-card merge strategy override, mounted only while open. */
const BoardCardMergeStrategyPopover = lazy(() =>
  import("./BoardCardMergeStrategyPopover").then((module) => ({
    default: module.BoardCardMergeStrategyPopover,
  })),
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
  // `stageIndex(status) >= 2`, now over the user-defined stage order.
  return boardStageIndex(stageStateOf(stages), stage) >= 2;
}

/**
 * Whether the sheet takes its wide form: a pane other than the brief is on
 * show. From Planning onward that is every default; before it the sheet stays
 * narrow until the user opens another pane. The single source for the dialog
 * frame (which sizes the popup by it) and the panel (which lays out by it).
 */
function boardCardDetailIsWide(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
  paneChoice: BoardCardPane | null,
): boolean {
  return boardCardHasThreadPane(stages, stage) || (paneChoice !== null && paneChoice !== "brief");
}

/**
 * Whether the card sits on the done-role stage — what the sheet's completion
 * marks (the header's success chip, the check after the title) key off. Keyed
 * on the ROLE, never the label, so a renamed or re-ordered done column
 * still reads as done.
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

/** The rail's shared tail, in both layouts: labels, dependencies and
    activity, then Automation and the Stage ladder, collapsed by default with
    their summaries on the header, then provenance. Dependencies and Activity
    sit here even on a Backlog card, so the brief has the main column. */
function RailSections({
  props,
  group,
  onOpenThread,
  onOpenCi,
}: {
  readonly props: BoardCardDetailViewProps;
  readonly group: BoardCardDetailGroup | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Open the CI tab, which every CI activity row links to. */
  readonly onOpenCi?: (() => void) | undefined;
}) {
  const { card } = props.detail;
  const activity = props.detail.activity;
  return (
    <>
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
      <div className="border-t border-border p-3.5">
        <DependenciesSection {...props} />
      </div>
      {activity.length === 0 ? null : (
        <BoardCollapsibleSection
          className="border-t border-border p-3.5"
          summary={String(activity.length)}
          title="Activity"
        >
          <BoardCardActivityRail
            agents={props.agents}
            entries={activity}
            onOpenCi={onOpenCi}
            projectNames={props.project.names}
            stages={props.stages}
          />
        </BoardCollapsibleSection>
      )}
      {props.automation == null ? null : (
        <div className="border-t border-border p-3.5">{props.automation}</div>
      )}
      {group === null ? (
        <BoardCollapsibleSection
          className="border-t border-border p-3.5"
          summary={boardStageLabel(props.stages, card.stage)}
          title="Stage"
        >
          <StageLadder
            deferred={props.stageLadderDeferred}
            onMoveStage={props.onMoveStage}
            stage={card.stage}
            stages={props.stages}
          />
        </BoardCollapsibleSection>
      ) : null}
      <InfoSection onOpenThread={onOpenThread} props={props} />
    </>
  );
}

export interface BoardDetailThreadLink {
  readonly threadId: ThreadId;
  readonly role: string;
  readonly tombstoned: boolean;
  readonly title: string | null;
  readonly threadState: BoardCardThreadState;
  readonly awaitingInput: boolean;
  /** The worker the thread lives on, which is where it opens. */
  readonly worker: BoardThreadWorker;
  /** "ran on {worker}", only on a board with more than one worker. */
  readonly ranOn: string | null;
  /** "Moved from {worker} · {time}" when this is the first thread after a
      move, drawn as a divider above it. */
  readonly movedFrom?: string | null | undefined;
}

/** What the split gate needs beyond the plans. */
export interface BoardSplitGateContext {
  readonly recommendation: BoardSplitRecommendation;
  readonly ownBranch: string;
  readonly landsOn: string;
  readonly readyLabel: string;
  readonly backlogLabel: string;
}

export interface BoardCardDetailGroup {
  /** "Group · N cards". */
  readonly chip: string;
  /** Why the group is in its stage, under Open board. */
  readonly note: string;
  readonly onOpenBoard: (() => void) | undefined;
  /** Opens the group archive confirmation. */
  readonly onArchive: () => void;
  /** Whether the group has its own integration branch, and so its own
      integration review and summary. */
  readonly ownBranch: boolean;
}

export interface BoardCardDetailViewProps {
  readonly environmentId: EnvironmentId;
  /** Why the live step stalled, from the card's shell (drives the
      provider-not-on-worker panel). */
  readonly stalledReason?: BoardCardStepStalledReason | undefined;
  /** What the card's shell says of its work and its worker, for the
      Worker offline / Worker removed panel. */
  readonly workerShell?:
    | Pick<
        BoardCardShell,
        "workerId" | "placementOrphaned" | "stepRunning" | "queued" | "stepAwaiting"
      >
    | undefined;
  readonly detail: BoardCardDetail;
  readonly catalogue: ReadonlyArray<BoardLabel>;
  /** The read-model stage list: column labels, the stage ladder, and the
      per-card human-in-the-loop toggle's Build-role detection all read it. */
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  /** `null` off the build role (no toggle shown). `explicit` is whether the
      card overrides the computed default; `basis` names why the default applies. */
  readonly humanInLoop: {
    readonly value: boolean;
    readonly explicit: boolean;
    readonly basis: "plan" | "no-plan";
  } | null;
  readonly onSetHumanInLoop: (value: boolean) => void;
  /** The Plan review section (plan review); null where it is hidden. */
  readonly planReview?: BoardCardPlanReviewView | null | undefined;
  readonly onSetPlanReview?: ((next: BoardCardPlanReview) => void) | undefined;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
  /** Project title, or null when the project is not on disk (archived card). */
  readonly projectName: string | null;
  /** Branch of the card's active thread; null when nothing is running for it
      yet — the card itself owns no branch. */
  readonly branch: string | null;
  readonly dependencies: ReadonlyArray<BoardDetailDependency>;
  readonly dependencyOptions: ReadonlyArray<BoardPickerOption>;
  readonly threadLinks: ReadonlyArray<BoardDetailThreadLink>;
  /** Provider display names and accents for the Activity rail's agent actors,
      resolved at render time so a renamed instance relabels its
      own history. */
  readonly agents?: BoardActivityAgentLookup | undefined;
  /** Each live-linked thread's cached todo list, keyed by thread —
      the modal's per-tab counts and its sticky todos strip. */
  readonly threadTodos?: ReadonlyMap<ThreadId, BoardCardThreadShell> | undefined;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  /** Server search behind the adopt list. */
  readonly adoptSearch?: BoardAdoptSearch | undefined;
  /** The review loop's configured round cap, for the Review pane's R1..Rn bar.
      Absent falls back to the compiled default. */
  readonly reviewMaxRounds?: number | undefined;
  /** The card's own review-loop settings. */
  readonly reviewOverrides?: BoardCardReviewOverrides | null | undefined;
  /** The highest round the card's loop has STARTED — the budget floor, matching
      the decider's. */
  readonly reviewRoundsStarted?: number | undefined;
  /** Whether the executor is driving the card (running or queued for a slot). */
  readonly reviewStepActive?: boolean | undefined;
  /** Run one more review round from the pane's "Run round N+1".
      The same RPC the rail button calls, so the two cannot disagree. */
  readonly onResumeReview?: (() => void) | undefined;
  /** Rule on a stuck review loop and run another round. */
  readonly onReviewRuling?:
    | ((ruling: BoardReviewCarryRuling, note: string | null) => void)
    | undefined;
  /** Reopen a review round whose recorded payload cannot be read. */
  readonly onReopenReviewStep?: ((stepId: string) => void) | undefined;
  readonly onSetReviewRounds?: ((rounds: number) => void) | undefined;
  readonly onSetReviewRoundModel?:
    | ((round: number, model: BoardReviewRoundOverride | null) => void)
    | undefined;
  /** The review phase's effective access level, what a round override
      without its own inherits. */
  readonly reviewPhaseRuntimeMode?: RuntimeMode | undefined;
  readonly onStopAfterRound?: ((round: number | null) => void) | undefined;
  /** The card's place in the board-wide build queue, or null when it
      is not holding for a slot. Resolved by the container, which is the only
      layer that can see every project's shells at once — the queue is global. */
  readonly queueInfo?: BoardQueueInfo | null | undefined;
  /** True between asking for a force start and the card actually leaving the
      queue. There is still a worktree to provision, so the button holds. */
  readonly queueForceStartPending?: boolean | undefined;
  /** Start the queued step now, over the agent cap. */
  readonly onQueueForceStart?: (() => void) | undefined;
  /** Move the card to the front of the queue. ABSENT — not disabled — when the
      reorder could not improve its position, which drag order alone often
      cannot. */
  readonly onQueueMoveToFront?: (() => void) | undefined;
  /** The thread pane `+` menu's restart affordance: present only when
      the card's current stage auto-executes, `null` otherwise. */
  readonly stageRestart: BoardThreadStageRestart | null;
  /** The card's stalled step, or null while nothing has given up —
      the failure banner's whole input. Resolved by the container, which is the
      only layer that can see both the card shell's `stalled` flag and the
      detail's `stepError` text. */
  readonly stepFailure: {
    readonly stageLabel: string;
    readonly error: string | null;
    /** Whether the board will start this step again by itself — the
        banner reads amber and "waiting to resume" rather than red and
        "stopped". */
    readonly waiting: boolean;
  } | null;
  /** The paused-step banner, or null when the card's step is not
      paused. Separate from `stepFailure` because the two are opposite claims —
      one says recovery gave up, the other says the human chose to stop — and a
      card can only ever be in one of them. */
  readonly stepPaused: { readonly stageLabel: string } | null;
  /** Resume a parked step — paused, or stalled (Continue) — sending it
      back to the build queue. Absent when the card cannot be resumed from here. */
  readonly onResumeStep?: (() => void) | undefined;
  readonly resumeStepPending?: boolean | undefined;
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
  /** What the environment allows for brief attachments. */
  readonly attachmentLimits: BoardAttachmentLimits;
  /** Claim an uploaded file onto the card. Resolves null on success, or the
      message the staged row shows. Changes persist immediately (K9). */
  readonly onAttachFile: (upload: BoardPendingUpload) => Promise<string | null>;
  readonly onDetachFile: (attachmentId: BoardCardAttachment["id"]) => void;
  readonly onAddDependency: (cardId: BoardCardId) => void;
  readonly onRemoveDependency: (cardId: BoardCardId) => void;
  readonly onMoveStage: (toStage: BoardStageId) => void;
  /** Merge the card's pull request and advance it. */
  readonly onMergePullRequest: () => void;
  /** Open the card's pull request from Building and route it past Code review.
      Absent hides the caret entirely. */
  readonly onSubmitForMerge?: (() => void) | undefined;
  /** Run one more review round on a settled loop — "Another review
      round" at Code review and Ready for merge, "Request review" on a card
      that has never had one. Absent hides the button entirely. */
  readonly onRequestReviewRound?: (() => void) | undefined;
  /** "Skip CI and move to Ready for merge". */
  readonly onSkipCi?: (() => void) | undefined;
  /** Retry CI and "Send back to review anyway" on a stopped pass. */
  readonly onRetryCi?: (() => void) | undefined;
  /** Stop CI on a queued, running or fixing pass. */
  readonly onStopCi?: (() => void) | undefined;
  readonly onCiSendBack?: (() => void) | undefined;
  /** A Skip CI request is in flight. */
  readonly skipCiPending?: boolean | undefined;
  /** Create a follow-up card from the decision log. */
  readonly onCreateFollowUp?:
    | ((draft: { readonly title: string; readonly brief: string }) => void)
    | undefined;
  /** Any step running, queued or parked. One step at a time is a decider
      invariant, so "Another review round" is disabled (not hidden) meanwhile. */
  readonly stepLive?: boolean | undefined;
  /** Open the pull request externally, and refresh its state while we are at
      it — clicking through is a moment the user is about to learn whether the
      card's link is stale, so it may as well not be. */
  readonly onOpenPullRequest: (url: string) => void;
  /** The card's merge-conflict story, or null when its merge is not
      held: the banner's words, and the one thing that disables Merge. Resolved
      by the container, which holds both the shell flag and the pull request's
      base branch. */
  readonly conflictFix: BoardConflictFixInfo | null;
  /** The shell's `held`, ranked by `boardCardAttention` — the build stage's
      forward button appears only on it. */
  readonly stepHeld?: boolean;
  /** Whether a merge kicked off from this card is still in flight — drives the
      Merge button's "Merging…" spinner and disables it so the several-second
      round trip can't be re-entered by a second click. */
  readonly merging: boolean;
  /** T3o: "Check again" — re-resolve the card's pull request from the
      forge NOW, bypassing the two-minute lookup cache and its failure backoff.
      Absent hides the control; the container reports the outcome through
      `feedback`. */
  readonly onCheckForPullRequest?: (() => void) | undefined;
  /** Whether that re-check is in flight, so the button can spin and refuse a
      second click across the round trip. */
  readonly checkingForPullRequest?: boolean | undefined;
  /** T3o: "Link one" on a card with no pull request. Resolves to the
      refusal to show inline, or null once linked. Absent hides the control. */
  readonly onLinkPullRequest?: ((target: string) => Promise<string | null>) | undefined;
  /** The card is finished and still holds its worktree, or null.
      Resolved by the container, which holds the settings. */
  readonly worktreeKept?: {
    readonly reason: string;
    readonly path: string | null;
    readonly branch: string;
    readonly cancelledWork: boolean;
  } | null;
  /** "Check again": refresh and re-run the cleanup. */
  readonly onCheckWorktree?: (() => void) | undefined;
  readonly checkingWorktree?: boolean | undefined;
  /** "Remove worktree": force it, after the banner's own confirm dialog. */
  readonly onRemoveWorktree?: (() => void) | undefined;
  readonly removingWorktree?: boolean | undefined;
  readonly onArchiveToggle: () => void;
  /** Purge the card outright. Always behind `BoardDeleteConfirmDialog` — the
      server does not ask, so this must never be reachable without one. */
  readonly onDelete: () => void;
  /** The split gate: whether a proposal is pending, what the gate
      shows, and the dispatch with the human's final settings. */
  readonly canApproveSplit: boolean;
  readonly splitGate: BoardSplitGateContext | null;
  readonly onApproveSplit: (settings: BoardSplitGateSettings) => void;
  readonly onLinkThread: (threadId: ThreadId, role: string) => void;
  readonly onUnlinkThread: (threadId: ThreadId) => void;
  /** The parent this card is a child of, for the identity row's
      "part of" chip; null on top-level cards and when the parent is off the
      live board. */
  readonly parentCard?: { readonly cardId: string; readonly key: string } | null | undefined;
  /** Navigate into the parent's sub-board with this card's sheet open. */
  readonly onOpenParentSubBoard?: (() => void) | undefined;
  /** Navigate into THIS card's sub-board with one child's sheet open — the
      plan pane's child chips and the Plans panel's rows. */
  readonly onOpenChildInSubBoard?: ((childCardId: string) => void) | undefined;
  /** The workspace pipeline config, for resolving what each override
      row falls back to when this card sets nothing. */
  readonly boardSettings: BoardSettings;
  /** The card's project's overrides. */
  readonly projectExecutionConfig?: BoardProjectExecutionConfig | null | undefined;
  /** Write this card's per-stage model overrides; null clears them. */
  readonly onSetModelOverrides: (next: BoardCardModelOverrides | null) => void;
  /** The merge stage's configured strategy, what "Use board default"
      names. Absent reads as squash, the stage's own default. */
  readonly boardMergeStrategy?: BoardMergeStrategy | undefined;
  /** Write this card's own merge strategy; null returns it to the default.
      Absent hides the control. */
  readonly onSetMergeStrategy?: ((next: BoardMergeStrategy | null) => void) | undefined;
  /** What the card's schedule control is offering, derived by the
      container from the card's live step — the copy has to be honest about
      whether setting a time will STOP an agent that is working right now. */
  readonly scheduleKind: BoardScheduleKind;
  /** Set or clear the card's scheduled start; null clears the hold, which
      starts or resumes the card immediately. */
  readonly onSetScheduledStartAt: (next: string | null) => void;
  /** The Automation section, built by the container, which holds
      the shells and the board settings it resolves against. Null hides it —
      a done or archived card has nothing left to automate. */
  readonly automation?: ReactNode;
  /** The card's resolved Auto-merge, for the header chip. */
  readonly autoMergeArmed?: boolean | undefined;
  /** Whether that Auto-merge comes from the board-wide setting, which makes
      the chip read `Auto-merge · board` so a user learns where it was set. */
  readonly autoMergeFromBoardSetting?: boolean | undefined;
  /** Resolve an override's model slug to its display name for the header pill
      and tooltip. Passed from the container, which holds the
      provider list; absent, the pill falls back to the raw slug. */
  readonly resolveModelDisplayName?:
    | ((override: BoardCardStageModelOverride) => string)
    | undefined;
  /** Whether a step is in flight, so the popover can say that an edit applies
      to the next run rather than the live one. */
  readonly stepRunning?: boolean | undefined;
  /** Navigate into THIS card's sub-board with no sheet — the Plans panel's
      Board button. */
  readonly onOpenOwnSubBoard?: (() => void) | undefined;
  /** The children's shells, for the Plans panel's live per-child state.
      Empty on every card without a split. */
  readonly childShells?: ReadonlyArray<BoardCardShell> | undefined;
  /** The group popup, or null for a leaf: Open board instead of the
      stage's actions, Automation instead of the Stage ladder, and the
      archive confirmation instead of a one-click archive. */
  readonly group?: BoardCardDetailGroup | null | undefined;
  /** A group's child also lists Deferred on its Stage ladder. */
  readonly stageLadderDeferred?: boolean | undefined;
  /** The card's base branch: what it branches off and merges back
      into, resolved through `resolveBoardCardEffectiveBase` by the container —
      the one layer that can see the project's default branch. */
  readonly baseBranch: {
    /** The effective base, or null while the project's default is unresolved. */
    readonly effective: string | null;
    /** Whether the card's branch was cut from a DIFFERENT base than the one it
        now names — the amber divergence line's whole input, derived so it
        clears itself the moment the two agree again. */
    readonly retargeted: boolean;
    /** The parent whose integration branch a sub-board child inherits, which
        makes the row read-only and names where the value came from. Null on a
        top-level card. */
    readonly inheritedFrom: string | null;
    /** The project's checkout, for the picker's ref query; null when the
        project is not on this server. */
    readonly workspaceRoot: string | null;
  };
  /** Write the card's base branch; null clears the pin back to the project
      default. Absent on a sub-board child, which has no base of its own. */
  readonly onSetBaseBranch?: ((baseBranch: string | null) => void) | undefined;
  /** The `Project ·` row, resolved by the container — the one layer
      that can see the project list, the board settings and every card's key. */
  readonly project: {
    /** Why the row is pinned, or null while the card has never been built. The
        same predicate the decider refuses on, so the control and the rejection
        cannot disagree. */
    readonly lock: BoardCardProjectLock | null;
    /** The projects the card may move to, each with the key the move would
        reissue. Empty while the row is pinned. */
    readonly options: ReadonlyArray<BoardProjectOption>;
    /** The project's icon colour, for the row's dot. */
    readonly accent: ProjectIconColor | null;
    /** Whether an agent is working the card right now — the confirm dialog's
        "the running agent is stopped" line. */
    readonly stopsAgent: boolean;
    /** Whether the card's stage auto-executes, so the move restarts it. */
    readonly restartsStage: boolean;
    /** Every project's title by id, so the Activity rail's move row can name
        where the card went — including a project the menu does not offer. */
    readonly names: ReadonlyMap<string, string>;
  };
  /** Move the card to another project. Absent renders the row as plain text —
      an ARCHIVED card, which is off the board entirely. A pinned live card
      still passes this: the row reads its `lock` and renders the padlock, so a
      user is told WHY rather than shown a control that has quietly vanished. */
  readonly onSetProject?: ((projectId: ProjectId) => void) | undefined;
  /** Step to the previous/next card on the board. Null when
      the sheet has no board behind it to step through — the archived-card
      sheet, or a card the board's live filters are currently hiding. */
  readonly nav?: BoardCardNav | null | undefined;
}

export interface BoardCardDetailPanelProps extends BoardCardDetailViewProps {
  /** Fullscreen is the dialog's business, so the frame owns the flag and the
      pane's control just toggles it. */
  readonly maximised: boolean;
  readonly onToggleMaximised: () => void;
  /** The pinned pane, owned by the dialog for the same reason as `maximised`:
      the frame's width follows it — a pre-Planning card grows wide when a
      pane other than the brief opens — so the choice cannot live below the
      frame. Null means "whichever pane the card's stage makes current". */
  readonly paneChoice: BoardCardPane | null;
  readonly onSelectPane: (pane: BoardCardPane) => void;
}

const THREAD_STATE_LABEL: Record<BoardCardThreadState, string> = {
  working: "Working",
  waiting: "Waiting",
  // The provider session died — the same word the thread list uses for
  // it, so the two surfaces read alike.
  failed: "Failed",
  stopped: "Stopped",
  none: "Idle",
};

/**
 * The heading keeps `CARD_TITLE_ID` in both states so the dialog stays labelled
 * while editing. A blank title is a cancel, not a clear: `board.card.update`
 * requires a non-empty title.
 */
function TitleBody({
  title,
  done,
  onSave,
}: {
  readonly title: string;
  readonly done: boolean;
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
    "mx-2.5 mt-2 shrink-0 rounded-board-7 px-1.5 text-board-21/tight font-semibold tracking-board-n1-5 text-pretty text-foreground";
  if (editing) {
    return (
      <h2 className={cn(frame, "flex bg-muted shadow-board-ring-primary")} id={CARD_TITLE_ID}>
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
      <BoardHint label="Click to edit">
        <button
          className="block w-full cursor-text text-left"
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
          type="button"
        >
          {title}
          {done ? (
            <CheckIcon
              aria-hidden
              className="ml-[9px] inline-block size-[21px] align-[-3px]"
              strokeWidth={3.2}
            />
          ) : null}
        </button>
      </BoardHint>
    </h2>
  );
}

function BriefBody({
  brief,
  onSave,
  environmentId,
  cardId,
  attachments,
  attachmentLimits,
  onAttachFile,
  onDetachFile,
}: {
  readonly brief: string | null;
  readonly onSave: (brief: string | null) => void;
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly attachments: ReadonlyArray<BoardCardAttachment>;
  readonly attachmentLimits: BoardAttachmentLimits;
  readonly onAttachFile: (upload: BoardPendingUpload) => Promise<string | null>;
  readonly onDetachFile: (attachmentId: BoardCardAttachment["id"]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(brief ?? "");
  // Brief attachments (K9): thumbnails above the text in both modes,
  // the attach row below. Each change persists at once, so the row stays
  // live whether or not the text is being edited.
  const staged = useBoardBriefAttachments({
    environmentId,
    limits: attachmentLimits,
    persistedCount: attachments.length,
    maxAttachments: BOARD_CARD_ATTACHMENTS_MAX,
    onUploaded: async (upload) => (await onAttachFile(upload)) ?? "consumed",
  });
  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next !== (brief ?? null)) onSave(next);
    setEditing(false);
  };
  const attachRow = (
    <BoardBriefAttachRow
      attachments={attachments}
      cardId={cardId}
      editable
      environmentId={environmentId}
      onDetach={onDetachFile}
      state={staged}
    />
  );
  if (editing) {
    return (
      <>
        <div
          className={cn(
            "-mx-[7px] -my-1 flex flex-col gap-2 rounded-lg border bg-muted px-1.75 py-1 shadow-board-ring-primary",
            boardBriefDropClass(staged.dropZone === "brief"),
          )}
          onDragLeave={staged.handlers.onDragLeave}
          onDragOver={staged.handlers.onBriefDragOver}
          onDrop={staged.handlers.onDrop}
        >
          <BoardBriefThumbnailStrip
            attachments={attachments}
            cardId={cardId}
            className="pt-1"
            editable
            environmentId={environmentId}
            onDetach={onDetachFile}
            state={staged}
          />
          <Textarea
            autoFocus
            className="min-h-24 text-board-13-5 leading-board-1-6"
            onBlur={commit}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(brief ?? "");
                setEditing(false);
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) commit();
            }}
            onPaste={staged.handlers.onPaste}
            placeholder="Describe the task. Paste screenshots (⌘V) or drop files in here."
            unstyled
            value={draft}
          />
        </div>
        {attachRow}
      </>
    );
  }
  // Click-to-edit in place, the prototype's affordance: the brief reads as
  // prose until you touch it, with the hover tint as the only hint. The
  // strip renders without its badges here (view mode, K9); a drop still
  // attaches, since that is never a text edit.
  return (
    <>
      <BoardBriefThumbnailStrip
        attachments={attachments}
        cardId={cardId}
        className="mb-2.5"
        editable={false}
        environmentId={environmentId}
        onDetach={null}
        state={staged}
      />
      <BoardHint label="Click to edit">
        <button
          className={cn(
            "-mx-[7px] -my-1 w-[calc(100%+14px)] rounded-lg border px-1.75 py-1 text-left text-board-13-5 leading-board-1-6 hover:bg-accent",
            boardBriefDropClass(staged.dropZone === "brief"),
          )}
          onClick={() => {
            setDraft(brief ?? "");
            setEditing(true);
          }}
          onDragLeave={staged.handlers.onDragLeave}
          onDragOver={staged.handlers.onBriefDragOver}
          onDrop={staged.handlers.onDrop}
          type="button"
        >
          {brief === null ? (
            <span className="text-muted-foreground">Add a brief…</span>
          ) : (
            <span className="whitespace-pre-wrap text-pretty text-foreground">
              {boardBriefDisplayText(brief)}
            </span>
          )}
        </button>
      </BoardHint>
      {attachRow}
    </>
  );
}

/**
 * Sits above the layout split so both the wide and narrow forms carry it. It
 * keeps a spinner the board face drops: one animating element in an open modal
 * is fine, thirty on a board are not.
 */
function ConflictBanner({
  info,
  onViewThread,
}: {
  readonly info: BoardConflictFixInfo;
  /** Put the conflict thread on screen. Absent in the narrow layout, which has
      no thread pane at all — its Threads section lists the thread a few lines
      below this instead. */
  readonly onViewThread?: (() => void) | undefined;
}) {
  return (
    <div className="mx-3.5 mt-2.5 flex items-center gap-2.5 rounded-board-10 border border-warning/40 bg-board-warning-tint py-2.5 pl-3 pr-2.5 dark:bg-board-warning-tint-dark">
      <LoaderCircleIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 animate-spin text-board-amber-icon"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-board-12-5 font-medium text-foreground">{info.headline}</span>
        <span className="text-board-11-5 leading-board-1-45 text-pretty text-muted-foreground">
          {info.detail}
        </span>
      </div>
      {onViewThread === undefined ? null : (
        <button
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-input bg-popover px-2.5 text-board-11-5 font-medium text-foreground shadow-xs hover:bg-accent"
          onClick={onViewThread}
          type="button"
        >
          <MessageSquareIcon className="size-3" />
          View thread
        </button>
      )}
    </div>
  );
}

/**
 * Its own component so the one-second interval repaints a span, not the whole
 * modal. The only per-second element in the product; the board pill has none.
 */
function AutoMergeCountdown({ retryAt }: { readonly retryAt: string }) {
  const label = boardAutoMergeCountdown(retryAt, useNowSecond());
  if (label === null) return null;
  return (
    <>
      <ClockIcon className="size-3.5" />
      <span className="tabular-nums">{label}</span>
    </>
  );
}

/**
 * Amber while the board will end the wait by itself, red only once it needs a
 * human, as `BoardCardStepFailure` does. No spinner: nothing runs during a hold.
 */
function AutoMergeBanner({ info }: { readonly info: BoardAutoMergeBanner }) {
  const tone =
    info.tone === "warning"
      ? {
          frame: "border-warning/40 bg-board-warning-tint dark:bg-board-warning-tint-dark",
          icon: "text-board-amber-icon",
        }
      : {
          frame: "border-destructive/30 bg-destructive/10",
          icon: "text-destructive",
        };
  return (
    <div
      className={cn(
        "mx-3.5 mt-2.5 flex items-start gap-2.5 rounded-board-10 border py-2.5 pl-3 pr-2.5",
        tone.frame,
      )}
    >
      <TriangleAlertIcon aria-hidden="true" className={cn("mt-px size-3.5 shrink-0", tone.icon)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-board-12-5 font-medium text-foreground">{info.headline}</span>
        {/* The forge's own words, verbatim: the user reads the forge's reason
            rather than a paraphrase of it. */}
        <span className="text-board-11-5 leading-board-1-45 text-pretty text-muted-foreground">
          {info.reason}
        </span>
        <span className="text-board-11 leading-board-1-45 text-muted-foreground/80">
          {info.meta}
        </span>
      </div>
    </div>
  );
}

/** A card sent back to review from CI by a human:
    why, the fixes it used, and the door to the run. Amber, like every hold the board did not resolve. */
function BoardCiSentBackBanner({
  banner,
  onViewRun,
}: {
  readonly banner: { readonly title: string; readonly reason: string; readonly meta: string };
  readonly onViewRun: () => void;
}) {
  return (
    <div className="mx-3.5 mt-2.5 flex items-start gap-2.5 rounded-board-10 border border-warning/40 bg-board-warning-tint py-2.5 pr-2.5 pl-3 dark:bg-board-warning-tint-dark">
      <Undo2Icon aria-hidden="true" className="mt-px size-3.5 shrink-0 text-board-amber-icon" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-board-12-5 font-medium text-foreground">{banner.title}</span>
        {banner.reason === "" ? null : (
          <span className="text-board-11-5 leading-board-1-45 text-pretty text-muted-foreground">
            {banner.reason}
          </span>
        )}
        <span className="text-board-11 leading-board-1-45 text-muted-foreground/80">
          {banner.meta}
        </span>
      </div>
      <button
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-input bg-popover px-2.5 text-board-11-5 font-medium text-foreground shadow-xs hover:bg-accent"
        onClick={onViewRun}
        type="button"
      >
        View CI run
      </button>
    </div>
  );
}

/**
 * Neutral, not `--attention`: the card waits on a machine, not a human, and the
 * buttons are an override. A queued and dependency-blocked card shows both.
 */
function QueueSection({ props }: { readonly props: BoardCardDetailViewProps }) {
  const info = props.queueInfo;
  if (info == null) return null;
  const pending = props.queueForceStartPending === true;
  return (
    <div className="mx-3.5 mb-3.5 rounded-lg border border-border bg-muted/50 p-2.5">
      <p className="flex items-center gap-1.5 text-board-12-5 font-semibold text-foreground">
        <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
        {info.headline}
      </p>
      <p className="mt-1 text-board-11-5 leading-board-1-45 text-muted-foreground">{info.detail}</p>
      {props.onQueueForceStart === undefined && props.onQueueMoveToFront === undefined ? null : (
        <div className="mt-2.5 flex items-center gap-1.5">
          {/* A card waiting for its worker's checkout has no limit to start
              past: nothing can run until the clone lands. */}
          {props.onQueueForceStart === undefined || info.waitingForCheckout === true ? null : (
            <BoardHint label="Run this task now, past every agent limit: the board's, its worker's and its provider's.">
              <button
                className={cn(
                  "inline-flex h-[28px] items-center justify-center gap-1.5 rounded-lg border border-primary bg-primary px-2.5 text-board-12 font-medium text-primary-foreground shadow-xs hover:bg-primary/90",
                  pending && "cursor-wait opacity-60",
                )}
                disabled={pending}
                onClick={props.onQueueForceStart}
                type="button"
              >
                <PlayIcon className="size-3" />
                {pending ? "Starting…" : "Start now"}
              </button>
            </BoardHint>
          )}
          {props.onQueueMoveToFront === undefined ? null : (
            <BoardHint label="Put this task at the front of the queue.">
              <button
                className="inline-flex h-[28px] items-center justify-center gap-1.5 rounded-lg border border-input bg-popover px-2.5 text-board-12 font-medium text-foreground shadow-xs hover:bg-accent"
                onClick={props.onQueueMoveToFront}
                type="button"
              >
                <ArrowUpIcon className="size-3" />
                Move to front
              </button>
            </BoardHint>
          )}
        </div>
      )}
    </div>
  );
}

/** How long a mid-review rounds change waits for another click before it is sent. */
const PLAN_REVIEW_ROUNDS_SETTLE_MS = 800;

/**
 * Plan review: an adversarial review of the plan once it is posted,
 * run by the planning agent with subagents. While one runs, a rounds change
 * tells the agent the new total, and turning the switch off stops the review.
 */
function PlanReviewSection({ props }: { readonly props: BoardCardDetailViewProps }) {
  const view = props.planReview;
  const onSet = props.onSetPlanReview;
  // Mid-review every commit sends the planning agent a turn, so a run of
  // stepper clicks lands as one change once it settles.
  const [pendingRounds, setPendingRounds] = useState<number | null>(null);
  // The settled commit is built from the view as it is when the timer fires:
  // a review stopped elsewhere in the meantime must not be turned back on.
  const commitRounds = useStableCallback((next: number) => {
    setPendingRounds(null);
    if (view == null || onSet === undefined || !view.enabled || !view.inProgress) return;
    onSet(nextBoardCardPlanReview(view, { rounds: next }));
  });
  const [roundsCommit] = useState(
    () => new Debouncer(commitRounds, { wait: PLAN_REVIEW_ROUNDS_SETTLE_MS }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lands a rounds change still settling in the debouncer when the panel unmounts
  useEffect(() => () => roundsCommit.flush(), [roundsCommit]);
  if (view == null || onSet === undefined) return null;
  const rounds = pendingRounds ?? view.rounds;
  return (
    <div className="flex flex-col gap-2 border-t border-border p-3.5">
      <div className="flex items-center gap-1.5">
        <SectionHeading>Plan review</SectionHeading>
        <span className="flex-1" />
        <span className="text-board-11 font-medium text-foreground">{view.summary}</span>
      </div>
      {/* A div, not a label: the switch is a button, as in the auto-start row. */}
      <div className="flex items-start gap-2.5 text-board-12-5">
        <Switch
          aria-label="Adversarial plan review"
          checked={view.enabled}
          className="mt-0.5 shrink-0"
          onCheckedChange={(next) => {
            roundsCommit.cancel();
            setPendingRounds(null);
            onSet(nextBoardCardPlanReview({ ...view, rounds }, { enabled: next }));
          }}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-foreground">Adversarial plan review</span>
          <span className="text-board-11-5 leading-board-1-45 text-muted-foreground">
            {view.note}
          </span>
        </span>
      </div>
      {view.enabled ? (
        <div className="flex items-center gap-2.5 pl-9.5">
          <span className="flex-1 text-board-12 font-medium text-foreground">Rounds</span>
          <NumberStepper
            ariaLabel="plan review rounds"
            max={BOARD_PLAN_REVIEW_ROUNDS_MAX}
            min={BOARD_PLAN_REVIEW_ROUNDS_MIN}
            onChange={(next) => {
              const change = nextBoardCardPlanReview(view, { rounds: next });
              if (!view.inProgress) {
                roundsCommit.cancel();
                setPendingRounds(null);
                onSet(change);
                return;
              }
              setPendingRounds(change.rounds);
              roundsCommit.maybeExecute(change.rounds);
            }}
            value={rounds}
          />
        </div>
      ) : null}
    </div>
  );
}

function DependenciesSection(props: BoardCardDetailViewProps) {
  return (
    <BoardDependencySection
      collapsible
      key={props.detail.card.id}
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
          onQueryChange={props.adoptSearch?.onQueryChange}
          options={props.adoptableThreads}
          pending={props.adoptSearch?.pending}
          placeholder="Search threads…"
        />
      </div>
      {props.threadLinks.length === 0 ? (
        <p className="text-board-13 text-muted-foreground">No linked threads.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {props.threadLinks.map((link) => (
            <Fragment key={link.threadId}>
              {link.movedFrom == null ? null : (
                <li className="flex items-center gap-2 text-board-10-5 text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  {link.movedFrom}
                  <span className="h-px flex-1 bg-border" />
                </li>
              )}
              <li className="flex items-center gap-2.25 rounded-lg border border-border bg-muted px-2.5 py-1.75">
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "min-w-0 truncate text-board-13 text-foreground",
                        link.tombstoned && "text-muted-foreground line-through",
                      )}
                    >
                      {link.title ?? "Deleted thread"}
                    </span>
                    {/* A permission prompt needs the human as much as a
                      question does. */}
                    {link.awaitingInput || isBoardCardAwaitingPermission(link) ? (
                      <CircleAlertIcon className="size-3 shrink-0 text-attention-foreground" />
                    ) : null}
                  </div>
                  <span className="text-board-10-5 text-muted-foreground">
                    {link.role}
                    {link.tombstoned
                      ? " · deleted"
                      : isBoardCardAwaitingPermission(link)
                        ? " · Waiting for permission"
                        : ` · ${THREAD_STATE_LABEL[link.threadState]}`}
                    {link.threadId === activeThreadId && !link.tombstoned ? " · active" : ""}
                    {link.ranOn === null ? "" : ` · ${link.ranOn}`}
                  </span>
                </div>
                {link.tombstoned ? null : (
                  <Link
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    params={{ environmentId: link.worker.environmentId, threadId: link.threadId }}
                    title={threadWorkerOpensOn(link.worker)}
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
            </Fragment>
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
  deferred = false,
}: {
  readonly stage: BoardStageId;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly onMoveStage: (toStage: BoardStageId) => void;
  /** Lists Deferred first: only a group's child may sit there. */
  readonly deferred?: boolean | undefined;
}) {
  const ladder = deferred
    ? [BOARD_DEFERRED_STAGE, ...boardStagesInOrder(stageStateOf(stages))]
    : boardStagesInOrder(stageStateOf(stages));
  return (
    <div className="flex flex-col gap-px">
      {ladder.map((candidate) => {
        const current = candidate.stageId === stage;
        const rung = (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/45" />
            <span className="flex-1 text-left">{candidate.label}</span>
            {current ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          </>
        );
        const className = cn(
          "flex h-[26px] items-center gap-2 rounded-board-7 px-2 text-board-12-5",
          current ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
        );
        // The build role onward is granted by the pipeline, not chosen — those
        // rungs render as plain rows so the ladder still reads whole.
        if (
          current ||
          (!isBoardDeferredStage(candidate.stageId) &&
            !isBoardStageManuallySelectable(stages, candidate.stageId))
        ) {
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

/** The card's labels as chips on a trigger, the catalogue behind it —
    `BoardLabelField`, the same control the create dialog uses. */
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

/**
 * No confirmation: opening a pull request and moving the card is reversible.
 * The irreversible act is the Merge button, which has its own confirmation.
 */
function BoardStageSecondaryMenu({
  actions,
  onSubmitForMerge,
}: {
  readonly actions: ReadonlyArray<BoardStageSecondaryAction>;
  readonly onSubmitForMerge: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label="Other ways to advance"
        className="-ml-px inline-flex h-[34px] w-7 shrink-0 items-center justify-center rounded-lg rounded-l-none border border-input bg-popover text-muted-foreground shadow-xs hover:bg-accent"
      >
        <ChevronDownIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[262px] p-1.5">
        <div className="flex flex-col gap-0.5">
          {actions.map((action) => (
            <button
              className="flex w-full items-start gap-2 rounded px-1.5 py-1.5 text-left hover:bg-accent"
              key={action.kind}
              onClick={() => {
                setOpen(false);
                onSubmitForMerge();
              }}
              type="button"
            >
              <PullRequestGlyph.pullRequest className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="text-board-12-5 font-medium text-foreground">{action.label}</span>
                <span className="mt-px text-board-11-5 leading-board-1-4 text-muted-foreground">
                  {action.detail}
                </span>
              </span>
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Continue / Restart / Move on for a stalled step: one split button,
 * Continue on its face because picking up where the step stopped is what a
 * stall almost always wants, the other two behind the caret.
 */
function BoardStepRecoveryButton({
  recovery,
  pending,
  onContinue,
  onRestart,
  restartDisabledReason,
  onMoveStage,
}: {
  readonly recovery: BoardStepRecovery;
  readonly pending: boolean;
  /** Absent when the card cannot be resumed from here; Restart still can. */
  readonly onContinue: (() => void) | undefined;
  readonly onRestart: () => void;
  /** Why Restart is refused (a blocked card), or null when it may run. */
  readonly restartDisabledReason: string | null;
  readonly onMoveStage: (toStage: BoardStageId) => void;
}) {
  const [open, setOpen] = useState(false);
  const next = recovery.next;
  const item =
    "flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-board-12-5 font-medium text-foreground";
  return (
    <div className="flex items-stretch">
      <BoardHint label="Pick up the stopped step where it left off">
        <button
          className={cn(
            "inline-flex h-[34px] min-w-0 flex-1 items-center justify-center gap-1.75 rounded-lg rounded-r-none border border-primary bg-primary px-3 text-board-13 font-medium text-primary-foreground shadow-xs",
            onContinue === undefined || pending
              ? "cursor-not-allowed opacity-50"
              : "hover:bg-primary/90",
          )}
          disabled={onContinue === undefined || pending}
          onClick={() => onContinue?.()}
          type="button"
        >
          <PlayIcon className="size-3.5" />
          {recovery.continueLabel}
        </button>
      </BoardHint>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          aria-label="Other ways to recover"
          className="-ml-px inline-flex h-[34px] w-7 shrink-0 items-center justify-center rounded-lg rounded-l-none border border-primary bg-primary text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          <ChevronDownIcon className="size-3.5" />
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-[262px] p-1.5">
          <div className="flex flex-col gap-0.5">
            <BoardHint label={restartDisabledReason ?? undefined}>
              <button
                className={cn(
                  item,
                  restartDisabledReason === null
                    ? "hover:bg-accent"
                    : "cursor-not-allowed opacity-50",
                )}
                disabled={restartDisabledReason !== null}
                onClick={() => {
                  setOpen(false);
                  onRestart();
                }}
                type="button"
              >
                <RotateCcwIcon className="size-3.5 shrink-0 text-muted-foreground" />
                {recovery.restartLabel}
              </button>
            </BoardHint>
            {next === null ? null : (
              <BoardHint label={next.disabledReason ?? undefined}>
                <button
                  className={cn(
                    item,
                    next.disabledReason === null
                      ? "hover:bg-accent"
                      : "cursor-not-allowed opacity-50",
                  )}
                  disabled={next.disabledReason !== null}
                  onClick={() => {
                    setOpen(false);
                    onMoveStage(next.toStage);
                  }}
                  type="button"
                >
                  <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  {next.label}
                </button>
              </BoardHint>
            )}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

/** Stage action, blocked reason and archive — the things you *do* to a card,
    kept together at the top of the rail. */
/** A group's action area: Open board, a secondary forward move while
    the group is still placed by hand (before Building — the decider derives its
    stage from there on), and why the group sits where it does. Its planning
    thread is the header's Planning pill. */
function GroupActionsSection({
  group,
  props,
  unmet,
}: {
  readonly group: BoardCardDetailGroup;
  readonly props: BoardCardDetailViewProps;
  readonly unmet: ReadonlyArray<BoardDetailDependency>;
}) {
  const { card } = props.detail;
  const displayed = boardCardDisplayPullRequest(card);
  const primaryAction =
    card.archivedAt !== null || isBoardStageAtOrAfterBuild(stageStateOf(props.stages), card.stage)
      ? null
      : boardStagePrimaryAction(props.stages, card.stage);
  const forward = primaryAction?.kind === "move" ? primaryAction : null;
  const blocked =
    forward !== null &&
    boardCardMoveBlocked({
      stages: props.stages,
      stage: card.stage,
      toStage: forward.toStage,
      unmetCount: unmet.length,
    });
  return (
    <div className="flex flex-col gap-3 border-t border-border p-3.5">
      <div className="flex flex-col gap-1.5">
        <Button disabled={group.onOpenBoard === undefined} onClick={group.onOpenBoard}>
          <LayersIcon />
          Open board
        </Button>
        {forward === null ? null : (
          <BoardHint label={blocked ? "Blocked by unmet dependencies" : undefined}>
            <Button
              disabled={blocked}
              onClick={() => props.onMoveStage(forward.toStage)}
              variant="outline"
            >
              <ArrowRightIcon />
              {forward.label}
            </Button>
          </BoardHint>
        )}
        {displayed === null ? null : (
          <ViewPullRequestButton onOpen={props.onOpenPullRequest} pullRequest={displayed} />
        )}
        <p className="text-board-11-5/normal text-pretty text-muted-foreground">{group.note}</p>
      </div>
    </div>
  );
}

/** The outline secondary look shared by the action-area buttons; hover is added
    per button because :hover still matches a disabled one. */
const OUTLINE_ACTION_CLASS =
  "inline-flex h-[34px] items-center justify-center gap-1.75 rounded-lg border border-input bg-popover px-3 text-board-13 font-medium text-foreground shadow-xs";

/** The outline View PR button, shared by the leaf and group action areas. */
function ViewPullRequestButton({
  pullRequest,
  onOpen,
}: {
  readonly pullRequest: NonNullable<ReturnType<typeof boardCardDisplayPullRequest>>;
  readonly onOpen: (url: string) => void;
}) {
  return (
    <BoardHint label={`Open pull request #${pullRequest.number}`}>
      <button
        className={cn(OUTLINE_ACTION_CLASS, "hover:bg-accent")}
        onClick={() => onOpen(pullRequest.url)}
        type="button"
      >
        <PullRequestGlyph.pullRequest className="size-3.5" />
        <span>View PR</span>
        <span className="text-muted-foreground">{`#${pullRequest.number}`}</span>
        {/* Neutral: a draft is waiting for the review loop, not on
            anyone. The board marks it ready at Ready for merge. */}
        {boardCardPullRequestIsOpenDraft(pullRequest) ? (
          <span className="rounded border border-input px-1 text-board-10-5 text-muted-foreground">
            Draft
          </span>
        ) : null}
      </button>
    </BoardHint>
  );
}

function ActionsSection({
  props,
  unmet,
  onReviewSplit,
  group = null,
}: {
  readonly props: BoardCardDetailViewProps;
  /** An own-branch group from Code review on: its own PR's Merge and
      review controls, plus Open board. Its stage is derived, so no hand move. */
  readonly group?: BoardCardDetailGroup | null;
  readonly unmet: ReadonlyArray<BoardDetailDependency>;
  /** Opens the split gate's pane. */
  readonly onReviewSplit: () => void;
}) {
  const { card } = props.detail;
  const archived = card.archivedAt !== null;
  // Merge may act only on the current round's `pullRequest` (see
  // `pullRequestFloor`). `displayed` falls back to the newest retired round, so
  // a card reopened from Done still links last round's PR until a new one opens.
  const pullRequest = card.pullRequest;
  const displayed = boardCardDisplayPullRequest(card);
  const actionContext = {
    pullRequestState: pullRequest?.state ?? null,
    pullRequestNumber: pullRequest?.number ?? null,
    conflictFixLive: props.conflictFix !== null,
    conflictFixReason: props.conflictFix?.mergeDisabledReason ?? null,
    stepHeld: props.stepHeld === true,
    hasBranch: card.worktree !== null,
    blocked: card.blocked,
    ciEntryLive: card.ci !== null,
  };
  const primaryAction = boardStagePrimaryAction(props.stages, card.stage, actionContext);
  const forward =
    primaryAction !== null && !archived && (group === null || primaryAction.kind === "merge")
      ? primaryAction
      : null;
  // `card.blocked` only covers the build role onward, so a card at Ready would
  // show a live forward button the decider refuses. One `blocked` feeds the
  // button, hint and callout so they cannot disagree.
  const moveBlocked = boardCardMoveBlocked({
    stages: props.stages,
    stage: card.stage,
    toStage: forward !== null && forward.kind === "move" ? forward.toStage : null,
    unmetCount: unmet.length,
  });
  const blocked = card.blocked || moveBlocked;
  // The countdown rides the Merge button only while a rung is actually
  // pending: an exhausted hold has nothing to count down to, and the button
  // goes back to saying Merge.
  const autoMergeRetryAt = card.autoMergeHold?.retryAt ?? null;
  // The caret beside the forward button — today at most one item.
  // An archived card gets none for the same reason it gets no forward button.
  const secondary =
    archived || props.onSubmitForMerge === undefined
      ? []
      : boardStageSecondaryActions(props.stages, card.stage, actionContext);
  // "Stop after this round": offered only while a review loop is
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
            props.reviewOverrides?.runThroughRound ?? null,
            {
              carriedFindings: props.reviewOverrides?.carriedFindings ?? {},
              stuckWaivedThrough: props.reviewOverrides?.stuckWaivedThrough ?? null,
            },
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
  // Only at review or merge on a board with a review-role stage. Not Done:
  // leaving it retires the PR and raises the floor. Deliberately ignores PR,
  // conflict and Merge state: on a drifted base another round is the remedy.
  const stageRole = (() => {
    const state = stageStateOf(props.stages);
    const stage = boardStageById(state, card.stage);
    return stage === null ? null : effectiveBoardStageRole(stage);
  })();
  const reviewRound =
    archived ||
    props.onRequestReviewRound === undefined ||
    boardStageWithRole(stageStateOf(props.stages), "review") === null ||
    (stageRole !== "review" && stageRole !== "merge")
      ? null
      : {
          // No workflow entity here, so the card's own history decides; a card
          // that skipped review gets round 1.
          label: hasBoardReviewSteps(props.detail.stepCompletions)
            ? "Another review round"
            : "Request review",
          // Disabled, never hidden: the reason is the point, and a button that
          // vanishes while a conflict fix runs looks like the feature is gone.
          disabled: props.stepLive === true,
          hint:
            props.stepLive === true
              ? "A step is already running on this card"
              : stageRole === "merge"
                ? "Pull this card back to Code review and run one more round"
                : hasBoardReviewSteps(props.detail.stepCompletions)
                  ? "Run one more review round on this branch"
                  : "Move this card to Code review and run the first review round",
          onRequest: props.onRequestReviewRound,
        };
  // The ways out of a stalled step. While one stands it REPLACES
  // "Another review round", which a stalled card can never use: the button is
  // disabled whenever a step is live, and a stalled step is live.
  const recovery = resolveBoardStepRecovery({
    stages: props.stages,
    stage: card.stage,
    stalled: props.stepFailure !== null,
    archived,
    blocked,
    handMoves: group === null,
    ciEntryLive: card.ci != null,
  });
  // A merge from this card is mid-flight: the button holds its spot but shows a
  // spinner and refuses further clicks until the round trip settles.
  const merging = forward?.kind === "merge" && props.merging;
  // The current round's PR, not `displayed`: a retired round's PR is not
  // mergeable. Fires without a worktree too, because the card face's `No PR`
  // chip keys on stage and `hasPr` alone and must always point at this notice.
  const missingPullRequest =
    !archived && stageRole === "merge" && pullRequest === null
      ? {
          branch: card.worktree?.branch ?? null,
          // Nothing to ask the forge about: `refreshCardPullRequest` answers
          // `no-branch` for this card, so the button would only ever report
          // what the sentence beside it already says.
          onCheck: card.worktree === null ? undefined : props.onCheckForPullRequest,
        }
      : null;
  // Keyed on stage role so renamed columns behave the same, and on the live
  // slot, not `displayed`: a card showing last round's PR can still be given one.
  const linkPullRequest =
    !archived &&
    pullRequest === null &&
    props.onLinkPullRequest !== undefined &&
    (stageRole === "review" || stageRole === "merge" || stageRole === "done")
      ? props.onLinkPullRequest
      : null;
  // The per-card human-in-the-loop toggle shows only on the Build role;
  // `props.humanInLoop` is non-null exactly then.
  const humanInLoop = archived ? null : props.humanInLoop;
  // The View PR link renders at every stage (including Done, past any forward
  // action), so keep the section alive whenever a PR is linked — otherwise the
  // link vanishes exactly when a merged card lands in Done.
  if (
    group === null &&
    forward === null &&
    !props.canApproveSplit &&
    !blocked &&
    humanInLoop === null &&
    displayed === null &&
    reviewRound === null &&
    recovery === null &&
    stopRound === null &&
    // T3o: a card with nothing but the missing-PR notice still needs
    // the section, or the one thing it has to say has nowhere to render.
    missingPullRequest === null &&
    linkPullRequest === null
  ) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2 p-3.5">
      {/* Not a status colour: the card face's chip already raises the amber
          alarm; here the notice only says what is true and what to press. */}
      {missingPullRequest === null ? null : (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2.5">
          <div className="flex gap-1.75 text-board-11-5 leading-board-1-45 text-muted-foreground">
            <PullRequestGlyph.pullRequest className="mt-px size-3.5 shrink-0" />
            <span>
              {missingPullRequest.branch === null ? (
                "No pull request, and no branch to look one up on."
              ) : (
                <>
                  No pull request found for{" "}
                  <span className="font-medium text-foreground">{missingPullRequest.branch}</span>.
                </>
              )}
            </span>
          </div>
          {missingPullRequest.onCheck === undefined ? null : (
            <BoardHint label="Ask the forge again, ignoring the cached answer">
              <button
                className={cn(
                  "inline-flex h-[30px] items-center justify-center gap-1.75 self-start rounded-lg border border-input bg-popover px-2.5 text-board-12-5 font-medium text-foreground shadow-xs",
                  props.checkingForPullRequest === true
                    ? "cursor-wait opacity-60"
                    : "hover:bg-accent",
                )}
                disabled={props.checkingForPullRequest === true}
                onClick={() => missingPullRequest.onCheck?.()}
                type="button"
              >
                {props.checkingForPullRequest === true ? (
                  <>
                    <span className="size-3 shrink-0 animate-spin rounded-full border-board-spinner border-muted-foreground/40 border-t-foreground" />
                    Checking…
                  </>
                ) : (
                  <>
                    <RotateCcwIcon className="size-3" />
                    Check again
                  </>
                )}
              </button>
            </BoardHint>
          )}
        </div>
      )}
      {stopRound !== null ? (
        <BoardHint
          label={
            stopRound.pending
              ? `Round ${stopRound.round} finishes, then the loop holds for you`
              : "Let the current round finish, then hold instead of starting another"
          }
        >
          <button
            className={cn(
              "inline-flex h-8 items-center justify-center gap-1.75 rounded-lg border px-2.75 text-board-13 font-medium shadow-xs",
              stopRound.pending
                ? "border-warning/55 bg-warning/12 text-board-amber-text"
                : "border-input bg-popover text-foreground hover:bg-accent",
            )}
            onClick={() => stopRound.onToggle(stopRound.pending ? null : stopRound.round)}
            type="button"
          >
            <SquareIcon className="size-3" />
            {stopRound.pending
              ? `Stopping after round ${stopRound.round}`
              : "Stop after this round"}
          </button>
        </BoardHint>
      ) : null}
      {props.canApproveSplit ? (
        // Replaces the forward button: the decider refuses every forward move
        // while a split is pending. Violet: a plan is waiting on the human.
        <BoardHint
          label={
            card.splitRationale ??
            "This card's planning proposed a multi-part split; review it in the planning thread"
          }
        >
          <button
            className="inline-flex h-[34px] items-center justify-center gap-1.75 rounded-lg border border-attention/55 bg-attention/12 px-3 text-board-13 font-medium text-attention-foreground shadow-xs hover:bg-attention/20"
            onClick={onReviewSplit}
            type="button"
          >
            <LayersIcon className="size-3.5" />
            Review split
          </button>
        </BoardHint>
      ) : forward !== null &&
        boardForwardShownBesideRecovery(forward, recovery, secondary.length > 0) ? (
        // With a secondary action the forward button becomes the left half of a
        // split button: square inner corners, the caret overlapping its border
        // by a pixel so the pair reads as one control.
        <div className="flex items-stretch">
          <BoardHint
            label={
              blocked
                ? "Blocked by unmet dependencies"
                : forward.kind === "merge"
                  ? (forward.disabledReason ?? undefined)
                  : undefined
            }
          >
            <button
              className={cn(
                "inline-flex h-[34px] min-w-0 flex-1 items-center justify-center gap-1.75 rounded-lg border px-3 text-board-13 font-medium shadow-xs",
                forward.emphasised
                  ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border-input bg-popover text-foreground hover:bg-accent",
                // The dependency gate is not overridable — the button says
                // so rather than bouncing off the decider.
                (blocked || (forward.kind === "merge" && forward.disabled)) &&
                  "cursor-not-allowed opacity-50",
                merging && "cursor-wait",
                secondary.length > 0 && "rounded-r-none",
              )}
              disabled={
                blocked || (forward.kind === "merge" && (forward.disabled || props.merging))
              }
              onClick={() => {
                if (forward.kind === "merge") {
                  props.onMergePullRequest();
                  return;
                }
                props.onMoveStage(forward.toStage);
              }}
              type="button"
            >
              {merging ? (
                <>
                  <span className="size-3.5 shrink-0 animate-spin rounded-full border-board-spinner-md border-primary-foreground/40 border-t-primary-foreground" />
                  Merging…
                </>
              ) : (
                <>
                  <ArrowRightIcon className="size-3.5" />
                  {forward.label}
                  {/* The hold's countdown, and only on Merge:
                      the button stays LIVE throughout a hold — nothing is
                      running and clicking is the escape hatch — so this says
                      when the board will try next, not that you cannot. */}
                  {forward.kind === "merge" && autoMergeRetryAt !== null ? (
                    <AutoMergeCountdown retryAt={autoMergeRetryAt} />
                  ) : null}
                </>
              )}
            </button>
          </BoardHint>
          {secondary.length > 0 && props.onSubmitForMerge !== undefined ? (
            <BoardStageSecondaryMenu
              actions={secondary}
              onSubmitForMerge={props.onSubmitForMerge}
            />
          ) : null}
        </div>
      ) : null}
      {/* Between the forward button and View PR, giving the approved mockup's
          order: Merge → Another review round → View PR, all three full width.
          Styled off its shipped sibling below rather than the prototype's
          inline CSS, which differs only by a rounding. */}
      {recovery !== null ? (
        <BoardStepRecoveryButton
          onContinue={props.onResumeStep}
          onMoveStage={props.onMoveStage}
          onRestart={props.onRestartStage}
          restartDisabledReason={props.stageRestart?.disabledReason ?? null}
          pending={props.resumeStepPending === true}
          recovery={recovery}
        />
      ) : reviewRound === null ? null : (
        <BoardHint label={reviewRound.hint}>
          <button
            className={cn(
              OUTLINE_ACTION_CLASS,
              // :hover still matches a disabled button, so the accent has to be
              // gated rather than relying on `disabled` to suppress it.
              reviewRound.disabled ? "cursor-not-allowed opacity-50" : "hover:bg-accent",
            )}
            disabled={reviewRound.disabled}
            onClick={() => reviewRound.onRequest()}
            type="button"
          >
            <RotateCcwIcon className="size-3.5" />
            {reviewRound.label}
          </button>
        </BoardHint>
      )}
      {/* At every stage, Done included. Only the number rides the card
          shell, so the URL-bearing link lives here on the detail. */}
      {displayed !== null ? (
        <ViewPullRequestButton onOpen={props.onOpenPullRequest} pullRequest={displayed} />
      ) : null}
      {linkPullRequest === null ? null : <BoardLinkPullRequest onLink={linkPullRequest} />}
      {group === null ? null : (
        <>
          <button
            className={cn(
              OUTLINE_ACTION_CLASS,
              group.onOpenBoard === undefined ? "cursor-not-allowed opacity-50" : "hover:bg-accent",
            )}
            disabled={group.onOpenBoard === undefined}
            onClick={group.onOpenBoard}
            type="button"
          >
            <LayersIcon className="size-3.5" />
            Open board
          </button>
          <p className="text-board-11-5/normal text-pretty text-muted-foreground">{group.note}</p>
        </>
      )}
      {blocked ? (
        <div className="flex gap-1.75 rounded-lg border border-warning/35 bg-warning/8 px-2.5 py-2.5 text-board-11-5 leading-board-1-45 text-warning-foreground">
          <LockIcon className="mt-px size-3.5 shrink-0" />
          <span>
            {unmet.length === 0
              ? "Blocked by unmet dependencies"
              : `Blocked by ${unmet.map((dependency) => dependency.key).join(", ")}`}
          </span>
        </div>
      ) : null}
      {humanInLoop !== null ? (
        <label className="flex items-center justify-between gap-2 rounded-lg border border-input bg-popover px-2.5 py-2 text-board-12-5">
          <span className="flex flex-col">
            <span className="font-medium text-foreground">Human in the loop</span>
            <span className="text-board-11 text-muted-foreground">
              {humanInLoop.explicit
                ? humanInLoop.value
                  ? "You drive the build in conversation."
                  : "The build runs unattended."
                : humanInLoopDefaultHint(humanInLoop)}
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

/** The toggle's hint for a card running on the DEFAULT stance: names the
    default and the reason it applies. */
function humanInLoopDefaultHint(humanInLoop: {
  readonly value: boolean;
  readonly basis: "plan" | "no-plan";
}): string {
  const stance = humanInLoop.value ? "conversation" : "unattended";
  switch (humanInLoop.basis) {
    case "plan":
      return `Default: ${stance} (a plan exists).`;
    case "no-plan":
      return `Default: ${stance} (no plan yet).`;
  }
}

function InfoSection({
  props,
  onOpenThread,
}: {
  readonly props: BoardCardDetailViewProps;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const base = props.baseBranch;
  return (
    <div className="border-t border-border p-3.5 text-board-11-5 leading-board-1-7 text-muted-foreground">
      {/* Project. Editable until the card has been built, because a
          card created in the wrong project was otherwise stuck there — and
          pinned after, because a worktree, a branch and a key on a pull request
          are all already spelled with the old project's name. */}
      <BoardCardProjectRow props={props} />
      {props.branch === null ? null : (
        <div>
          Branch · <span className="text-foreground">{props.branch}</span>
        </div>
      )}
      {/* Beside `Branch ·` (the active thread's branch). A sub-board child
          shows it read-only, naming its parent, rather than hiding it. */}
      <BoardBaseBranchRow props={props} />
      {/* Worker: where the card runs, and Move. Absent with one worker. */}
      <BoardCardWorkerRow
        card={props.detail.card}
        environmentId={props.environmentId}
        onOpenThread={onOpenThread}
        shell={props.workerShell}
        stalledReason={props.stalledReason}
      />
      <div>Created · {formatRelativeTimeLabel(props.detail.card.createdAt)}</div>
      {base.retargeted && base.effective !== null ? (
        // Derived, never stored: the stated base and actual cut point disagree
        // until the rebase lands, and reverting the base clears it. Amber: a
        // stale base is blocked work, not a wait on a human.
        <div className="mt-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-warning-foreground">
          Cut from{" "}
          <span className="font-mono">{props.detail.card.worktree?.baseRefName ?? "?"}</span>, now
          based on <span className="font-mono">{base.effective}</span>. It is rebased onto{" "}
          <span className="font-mono">{base.effective}</span> at the next code review round.
        </div>
      ) : null}
    </div>
  );
}

function BoardCardProjectRow({ props }: { readonly props: BoardCardDetailViewProps }) {
  const card = props.detail.card;
  const onSet = props.onSetProject;
  const [confirming, setConfirming] = useState<BoardProjectOption | null>(null);
  // Live links the move leaves alone: a thread a human ADOPTED (role `linked`)
  // and any left by an earlier run of another stage. The reactor clears only the
  // current stage's, and a thread is pinned to the project it was created in, so
  // these keep pointing at the old repository.
  const retainedThreads = card.threadLinks.filter(
    (link) => isLiveBoardCardThreadLink(link) && link.role !== card.stage,
  ).length;

  if (onSet === undefined) {
    return (
      <div>
        Project ·{" "}
        <span className="text-foreground">{props.projectName ?? "Project not on disk"}</span>
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-1.5">
      <span>Project ·</span>
      <BoardCardProjectRowValue
        accent={props.project.accent}
        lock={props.project.lock}
        onSelect={(projectId) => {
          const option = props.project.options.find((entry) => entry.id === projectId);
          if (option !== undefined) setConfirming(option);
        }}
        options={props.project.options}
        projectId={card.projectId}
        projectName={props.projectName}
      />
      <BoardCardProjectConfirmDialog
        cardKey={card.key}
        currentProjectName={props.projectName ?? "its current project"}
        nextKey={confirming?.nextKey ?? ""}
        onConfirm={() => {
          if (confirming !== null) onSet(confirming.id);
          setConfirming(null);
        }}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={confirming !== null}
        projectName={confirming?.title ?? ""}
        restartsStage={props.project.restartsStage}
        retainedThreads={retainedThreads}
        stageLabel={boardStageLabel(props.stages, card.stage)}
        stopsAgent={props.project.stopsAgent}
      />
    </div>
  );
}

function BoardBaseBranchRow({ props }: { readonly props: BoardCardDetailViewProps }) {
  const base = props.baseBranch;
  const onSet = props.onSetBaseBranch;
  const card = props.detail.card;
  const [confirming, setConfirming] = useState<{
    readonly next: string | null;
    readonly localName: string;
  } | null>(null);
  // Confirm only on a live branch, where a retarget costs a rebase and a
  // force-push; a `failed` or `reclaimed` slice has no ref to rewrite.
  const cutFrom = boardCardHasLiveBranch(card) ? (card.worktree?.baseRefName ?? null) : null;

  if (base.inheritedFrom !== null || onSet === undefined) {
    return base.effective === null ? null : (
      <div>
        Base · <span className="text-foreground">{base.effective}</span>
        {base.inheritedFrom === null ? null : (
          <span className="text-muted-foreground/70"> · from {base.inheritedFrom}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <span>Base ·</span>
      <BoardBaseBranchSelect
        align="end"
        baseBranch={card.baseBranch}
        className="h-5 px-1 text-board-11-5 text-foreground"
        environmentId={props.environmentId}
        onSelect={(next, localName) => {
          // Compared against the branch the card was CUT from, not the pin it
          // currently carries: putting a retargeted card back on its cut point
          // needs no rebase, so it must not ask for one.
          if (cutFrom !== null && localName !== cutFrom) {
            setConfirming({ next, localName });
            return;
          }
          onSet(next);
        }}
        size="xs"
        workspaceRoot={base.workspaceRoot}
      />
      <BoardBaseBranchConfirmDialog
        branch={card.worktree?.branch ?? ""}
        cardKey={card.key}
        currentBase={cutFrom ?? ""}
        nextBase={confirming?.localName ?? ""}
        onConfirm={() => {
          if (confirming !== null) onSet(confirming.next);
          setConfirming(null);
        }}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={confirming !== null}
      />
    </div>
  );
}

/** `planning` is the Thread pane pinned to a group's planning thread:
    a pane of its own, so its pill lights by the user's choice rather than by
    which thread happens to be the default. */
export type BoardCardPane = "thread" | "planning" | "review" | "ci" | "summary" | "plan" | "brief";

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
 * The latest surface the card's stage has produced. A split parent short of
 * review opens on its plans, since its build is the sub-board. A role-less
 * column at or after Code review still opens on Review.
 */
export function initialBoardCardPane(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
  liveChildCount = 0,
): BoardCardPane {
  // A card in CI opens on its run.
  if (stage === BOARD_SEED_STAGE_IDS.ci) return "ci";
  const def = boardStageById(stageStateOf(stages), stage);
  const role = def === null ? null : effectiveBoardStageRole(def);
  if (role === "merge" || role === "done") return "summary";
  if (role === "review" || isStageAtOrAfterReview(stages, stage)) return "review";
  if (!boardCardHasThreadPane(stages, stage)) return "brief";
  return liveChildCount > 0 ? "plan" : "thread";
}

/**
 * A link's role is the stage id that spawned it, so roles from later stages and
 * review-loop roles (`review@1`) are stale and drop out; stageless roles stay.
 * From review onward it is simply the most recently linked live thread.
 */
export function initialBoardCardThreadId(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
  links: ReadonlyArray<BoardCardThreadLink>,
): ThreadId | null {
  // A card whose threads are all retired still opens its newest one.
  const active =
    activeBoardCardThreadId(links) ??
    sortBoardCardThreadLinks(links.filter((link) => link.tombstonedAt === null)).at(-1)?.threadId ??
    null;
  const state = stageStateOf(stages);
  const stageIndex = boardStageIndex(state, stage);
  if (stageIndex < 0 || isStageAtOrAfterReview(stages, stage)) return active;
  const current = sortBoardCardThreadLinks(links.filter(isLiveBoardCardThreadLink)).filter(
    (link) => {
      if (parseReviewStepId(link.role) !== null) return false;
      const linkStageIndex = boardStageIndex(state, link.role as BoardStageId);
      return linkStageIndex <= stageIndex;
    },
  );
  return current.at(-1)?.threadId ?? active;
}

/** Present at every stage, so a thread can be attached or a review round's
    model set before the pipeline gets there. */
function PaneTabs({
  pane,
  hasReview,
  hasCi = false,
  ciLive = false,
  hasSummary,
  hasPlan,
  planCount,
  onSelect,
  hasPlanning = false,
  plansLabel = null,
}: {
  readonly pane: BoardCardPane;
  readonly hasReview: boolean;
  /** The CI pill: the card is in CI or has run it. */
  readonly hasCi?: boolean | undefined;
  /** CI is running or fixing, which lights the pill's blue dot. */
  readonly ciLive?: boolean | undefined;
  readonly hasSummary: boolean;
  readonly hasPlan: boolean;
  /** Whether the Planning pill shows: a group with a live planning thread. */
  readonly hasPlanning?: boolean | undefined;
  /** The plans pill's label when it lists a group's cards. */
  readonly plansLabel?: string | null | undefined;
  /** Non-null once the card has materialised children: the plan pill
      then labels the Plans panel by how many rows it holds — "4 plans", not
      "Plan" — because the pill names its pane's contents. */
  readonly planCount: number | null;
  readonly onSelect: (pane: BoardCardPane) => void;
}) {
  const pill = (active: boolean) =>
    cn(
      "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-board-7 px-2.5 text-board-11-5",
      active
        ? "bg-card font-medium text-foreground shadow-board-ring-border"
        : "text-muted-foreground hover:text-foreground",
    );
  const tab = (value: BoardCardPane) => pill(pane === value);
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-board-9 bg-accent p-0.5">
      <button className={tab("thread")} onClick={() => onSelect("thread")} type="button">
        <MessageSquareIcon className="size-3" />
        Thread
      </button>
      {hasPlanning ? (
        <BoardHint label="The thread that planned this group">
          <button className={tab("planning")} onClick={() => onSelect("planning")} type="button">
            <MessageSquareTextIcon className="size-3" />
            Planning
          </button>
        </BoardHint>
      ) : null}
      {hasReview ? (
        <BoardHint label="Adversarial review loop">
          <button className={tab("review")} onClick={() => onSelect("review")} type="button">
            <RefreshCcwIcon className="size-3" />
            Review
          </button>
        </BoardHint>
      ) : null}
      {hasCi ? (
        <BoardHint label={ciLive ? "Continuous integration · running" : "Continuous integration"}>
          <button className={tab("ci")} onClick={() => onSelect("ci")} type="button">
            <ListChecksIcon className="size-3" />
            CI
            {ciLive ? (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
            ) : null}
          </button>
        </BoardHint>
      ) : null}
      {hasSummary ? (
        <BoardHint label="How this card's work went">
          <button className={tab("summary")} onClick={() => onSelect("summary")} type="button">
            <ListChecksIcon className="size-3" />
            Summary
          </button>
        </BoardHint>
      ) : null}
      {hasPlan ? (
        <button className={tab("plan")} onClick={() => onSelect("plan")} type="button">
          {planCount === null ? <FileIcon className="size-3" /> : <LayersIcon className="size-3" />}
          {plansLabel ??
            (planCount === null ? "Plan" : `${planCount} ${planCount === 1 ? "plan" : "plans"}`)}
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
  const done = boardCardIsDone(props.stages, card.stage);
  // The auto-merge header chip and hold banner. Both read the
  // card aggregate, which only the modal subscribes to — the board card's
  // pill reads the three shell facts instead, and `boardAutoMergeHold` is the
  // one place either set of words is written, so they cannot disagree.
  const autoMergeChip = boardAutoMergeHeaderChip({
    armed: props.autoMergeArmed === true,
    fromBoardSetting: props.autoMergeFromBoardSetting === true,
  });
  const hold = card.autoMergeHold;
  // Minute-grained, off the render's clock, exactly as the board pill is: the
  // one per-second element is the Merge button's countdown, which is its own
  // isolated component.
  const autoMergeBanner =
    hold === null
      ? null
      : boardAutoMergeBanner({
          reason: hold.reason,
          detail: hold.detail,
          attempt: hold.attempt,
          maxAttempts: BOARD_AUTO_MERGE_MAX_ATTEMPTS,
          heldSince: hold.heldSince,
          retryAt: hold.retryAt,
          // oxlint-disable-next-line react/purity -- the banner is minute-grained and samples the clock when the card re-renders; the countdown owns the per-second tick.
          nowMs: Date.now(),
        });
  const wide = boardCardDetailIsWide(props.stages, card.stage, props.paneChoice);
  // Mirrors the contracts' unmet: unknown ids are unmet, archived ones do not
  // count, and a waiting group holds back every card inside it.
  const groupDependencies: ReadonlyArray<BoardDetailDependency> =
    props.detail.groupDependencies.map((dependency) => ({
      cardId: dependency.cardId,
      key: dependency.key,
      title: dependency.title,
      stage: dependency.stage,
      known: true,
      archived: dependency.archivedAt !== null,
    }));
  const unmet = [...props.dependencies, ...groupDependencies].filter(
    (dependency) => !dependency.known || (!dependency.archived && dependency.stage !== "done"),
  );

  // Archiving a not-done card that live cards depend on asks first; every
  // other archive, and every restore, is a single click.
  const liveDependents = liveBoardCardDependents(props.detail.dependents);
  const archiveNeedsConfirmation = boardCardArchiveNeedsConfirmation({
    stage: card.stage,
    dependents: props.detail.dependents,
  });
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [mergeStrategyOpen, setMergeStrategyOpen] = useState(false);
  const onSetMergeStrategy = props.onSetMergeStrategy;
  const mergeStrategy = boardCardMergeStrategyView({
    card,
    parent:
      props.parentCard == null
        ? null
        : { key: props.parentCard.key, mergeStrategy: props.detail.parentMergeStrategy },
    boardStrategy: props.boardMergeStrategy ?? "squash",
  });

  // The rows the card can override, and what each falls back to.
  // Derived eagerly — it is picker-free, and the kebab needs the summary to
  // render its item whether or not anyone opens the popover.
  const modelRows = boardCardModelRows({
    stages: props.stages,
    boardSettings: props.boardSettings,
    projectConfig: props.projectExecutionConfig,
    // The parent's key comes from the board's shells (the "part of" chip's
    // source), its overrides from the detail payload — only together do they
    // let a child's row say "(from <parent key>)".
    parentCard:
      props.parentCard == null || props.detail.parentModelOverrides === null
        ? null
        : { key: props.parentCard.key, modelOverrides: props.detail.parentModelOverrides },
  });
  const modelSummary = boardCardModelOverrideSummary(modelRows, card.modelOverrides);
  const modelOverridden = hasBoardCardModelOverride(modelRows, card.modelOverrides);
  // The eager view does not hold the provider list, so the container passes a
  // display-name resolver and the raw slug is the fallback.
  const resolveOverrideName = (row: BoardCardModelRowSpec): string => {
    const override = card.modelOverrides?.[row.stageId];
    if (override === undefined) return "";
    return props.resolveModelDisplayName?.(override) ?? override.model;
  };
  const overriddenRows = modelRows.filter(
    (row) => card.modelOverrides?.[row.stageId] !== undefined,
  );
  const soleOverriddenRow = overriddenRows.length === 1 ? overriddenRows[0] : undefined;
  const modelPillLabel =
    soleOverriddenRow === undefined
      ? "Custom models"
      : `${soleOverriddenRow.label} ${resolveOverrideName(soleOverriddenRow)}`;
  const modelPillTitle = overriddenRows
    .map((row) => `${row.label}: ${resolveOverrideName(row)}`)
    .join("\n");

  // Null tracks the stage's default pane until the user picks one. It lives on
  // the dialog, which sizes the frame by it.
  const paneChoice = props.paneChoice;
  const setPane = props.onSelectPane;
  // A split parent opens on its plans while its children build.
  // Live children only — an archived child is gone, and a
  // fully-wrapped split leaves the parent an ordinary card again.
  const liveChildCount = props.detail.children.filter((child) => child.archivedAt === null).length;
  // Plans replaces the markdown only once children exist: before approval the
  // markdown carries the Approve split gate.
  const isSplitParent = liveChildCount > 0;
  const planRows = isSplitParent
    ? deriveBoardPlanRows({
        plans: props.detail.plans,
        children: props.detail.children,
        cards: props.childShells ?? [],
        stages: props.stages,
      })
    : null;
  const group = props.group ?? null;
  const groupUsesCardActions =
    group !== null &&
    boardGroupUsesCardActions({
      ownBranch: group.ownBranch,
      stages: stageStateOf(props.stages),
      stage: card.stage,
    });
  // Which tab the thread pane is on. Absent means "whichever thread the card's
  // stage makes current", so the pane follows the card until the user picks a
  // thread, and a since-unlinked selection falls back to that same default.
  const [selectedThreadId, setSelectedThreadId] = useState<ThreadId | null>(null);
  const selectedThread =
    props.threadLinks.find((link) => link.threadId === selectedThreadId)?.threadId ??
    initialBoardCardThreadId(props.stages, card.stage, card.threadLinks);
  // A group's Planning pane is the Thread pane pinned to its planning
  // thread; the Thread pill still lists every thread, planning included.
  const planStageId = boardStageWithRole(stageStateOf(props.stages), "plan")?.stageId ?? null;
  const planningLink =
    group === null || planStageId === null
      ? undefined
      : props.threadLinks.findLast(
          (candidate) => candidate.role === planStageId && !candidate.tombstoned,
        );
  const groupDefaultPane: BoardCardPane = (planRows?.rows.length ?? 0) > 0 ? "plan" : "brief";
  const pane =
    paneChoice ??
    (group !== null && !groupUsesCardActions
      ? groupDefaultPane
      : initialBoardCardPane(props.stages, card.stage, liveChildCount));
  // A card that loses its plans falls back to the thread. Review opens at any
  // stage: a round's model is only writable before the executor freezes it.
  const hasPlan = props.detail.plans.length > 0 || isSplitParent;
  const reviewStageId = boardStageWithRole(stageStateOf(props.stages), "review")?.stageId ?? null;
  const reviewStarted = hasBoardReviewSteps(props.detail.stepCompletions);
  // An inherit group never reviews; an own-branch group's integration does.
  const integrates = group === null || group.ownBranch;
  const hasReview = integrates && (reviewStageId !== null || reviewStarted);
  // An inherit group's Summary is its decision log, which its children's
  // planning inherits as context.
  const hasSummary = !integrates
    ? props.detail.decisions.length > 0
    : boardCardHasSummaryPane({
        stages: props.stages,
        stage: card.stage,
        stepCompletions: props.detail.stepCompletions,
        card,
        decisionCount: props.detail.decisions.length,
      });
  // The card-level running/queued signals describe the review loop only while
  // the card sits ON the review stage — anywhere else the live step is some
  // other stage's, and feeding it in would spin the review pill during a
  // build and freeze round models that are still free.
  const onReviewStage = reviewStageId !== null && card.stage === reviewStageId;
  const activeThreadId = activeBoardCardThreadId(card.threadLinks);
  const reviewLive =
    onReviewStage &&
    props.threadLinks.some(
      (link) => link.threadId === activeThreadId && link.threadState === "working",
    );
  const reviewStalled = onReviewStage && boardReviewPaneStopped(props.stepFailure);
  // CI: the tab exists while the card is in CI or once it has run.
  const inCi = card.stage === BOARD_SEED_STAGE_IDS.ci;
  const hasCi = inCi || card.ci !== null || props.detail.ciPasses.length > 0;
  const ciBanner = boardCiSentBackBanner({ inCi, outcome: card.ciLastOutcome });
  const activePane: BoardCardPane =
    (pane === "plan" && !hasPlan) ||
    (pane === "review" && !hasReview) ||
    (pane === "ci" && !hasCi) ||
    (pane === "summary" && !hasSummary) ||
    (pane === "planning" && planningLink === undefined)
      ? "thread"
      : pane;
  const shownThread =
    activePane === "planning" && planningLink !== undefined
      ? planningLink.threadId
      : selectedThread;
  // Picking a thread from the Planning pane leaves the pin for the Thread pane.
  const selectThread = (threadId: ThreadId | null) => {
    setSelectedThreadId(threadId);
    if (activePane === "planning") setPane("thread");
  };
  // Derived only while the Summary pane is showing: the panel re-renders on
  // every thread-link or detail push, and the walk over step completions is
  // wasted on any other pane.
  const summaryShown = activePane === "summary";
  const reviewMaxRounds = props.reviewMaxRounds;
  const workSummary = summaryShown
    ? deriveBoardCardWorkSummary({
        detail: props.detail,
        stages: props.stages,
        planRows,
        reviewLive,
        reviewStalled,
        ...(reviewMaxRounds === undefined ? {} : { maxRounds: reviewMaxRounds }),
      })
    : null;

  // The decision log. Null open state means "the default rule".
  const [logOpen, setLogOpen] = useState<boolean | null>(null);
  const stagesState = stageStateOf(props.stages);
  const buildStage = boardStageWithRole(stagesState, "build");
  const pastBuild =
    buildStage !== null &&
    boardStageIndex(stagesState, card.stage) > boardStageIndex(stagesState, buildStage.stageId);
  const decisionLog = summaryShown
    ? boardDecisionLogView({
        decisions: props.detail.decisions,
        autoPlanned: card.autoPlan !== undefined,
        pastBuild,
      })
    : null;
  const buildPending =
    !isStageAtOrAfterReview(props.stages, card.stage) &&
    !props.detail.stepCompletions.some(
      (completion) =>
        buildStage !== null &&
        completion.stepId === buildStage.stageId &&
        completion.outcome === "succeeded",
    );

  return (
    <>
      {/* Identity row: key, the card's labels, its stage. `relative z-10` lifts
          it (and the × / ⋯ / fullscreen buttons it carries) above the nav
          rails' band, which would otherwise sit over them. */}
      <div className="relative z-10 flex shrink-0 items-start gap-2.25 px-4 pt-4">
        {/* The key and its chips wrap onto a second line rather than pushing
            the tabs and the kebab off a narrow modal. */}
        <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2.25 gap-y-1.5">
          <span className="shrink-0 text-board-11-5 font-medium text-muted-foreground">
            {card.key}
          </span>
          {props.parentCard != null ? (
            // "Part of <parent>": the chip is the child's door
            // back into the sub-board it lives on, with this sheet still open.
            <BoardHint label={`Part of ${props.parentCard.key}'s sub-board: open it`}>
              <button
                className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-muted-foreground/14 px-1.75 text-board-11 font-medium text-foreground hover:bg-muted-foreground/25 disabled:pointer-events-none"
                disabled={props.onOpenParentSubBoard === undefined}
                onClick={props.onOpenParentSubBoard}
                type="button"
              >
                <LayersIcon className="size-2.5" />
                {props.parentCard.key}
              </button>
            </BoardHint>
          ) : null}
          {group === null ? null : (
            <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-muted-foreground/14 px-1.75 text-board-11 font-medium text-foreground">
              <LayersIcon className="size-2.5" />
              {group.chip}
            </span>
          )}
          <BoardLabelChips labelIds={card.labels} labelsById={props.labelsById} />
          {/* On a done card the stage chip IS the completion badge, cut to the
              same block as the label chips beside it: the sheet no
              longer wears a wash, so this and the title's check carry "done".
              Green means done and only done — docs/t3o/status-colours.md. */}
          <span
            className={cn(
              "inline-flex shrink-0 items-center font-medium",
              done
                ? "h-4 rounded-board-5 bg-success/16 px-1.5 text-board-10 tracking-board-3 text-success-foreground uppercase"
                : "h-[18px] rounded-md bg-muted-foreground/14 px-1.75 text-board-11 text-foreground",
            )}
          >
            {/* "Continuous integration" is too long for this row. */}
            {card.stage === BOARD_SEED_STAGE_IDS.ci
              ? "CI"
              : boardStageLabel(props.stages, card.stage)}
          </span>
          {archived ? (
            <span className="inline-flex h-[18px] shrink-0 items-center rounded-md bg-muted px-1.75 text-board-11 font-medium text-muted-foreground">
              Archived
            </span>
          ) : null}
          {/* The card's scheduled start: a bare clock until a time
              is set, then the clock plus its label. Hidden on a done-role card
              and on an archived one — neither is going to move again on a timer.
              Beside the stage chip, because what it holds is the stage. */}
          {archived || done ? null : (
            <BoardCardSchedulePopover
              // Sized to the chip row it sits in, not to a button row.
              className="h-[18px]"
              kind={props.scheduleKind}
              onChange={props.onSetScheduledStartAt}
              scheduledStartAt={card.scheduledStartAt}
              stageLabel={boardStageLabel(props.stages, card.stage)}
            />
          )}
          {/* The resolved Auto-merge, read-only. NAMES THE SOURCE
              when it is the board-wide setting, which no card switch can turn
              off. Neutral, like the queue chip below — an armed card is not
              running, not done, and asking nothing of anyone. */}
          {archived || done || autoMergeChip === null ? null : (
            <BoardHint label={autoMergeChip.tooltip}>
              <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-muted px-1.75 text-board-11 font-medium text-muted-foreground">
                <PullRequestGlyph.merged className="size-2.5" />
                {autoMergeChip.label}
              </span>
            </BoardHint>
          )}
          {/* Queued for a build slot. Beside the stage badge, because
              "Building" alone is what made a queued card look mid-build. Neutral,
              not `--attention`: nothing is waiting on the user here — see
              docs/t3o/status-colours.md. */}
          {props.queueInfo != null ? (
            <BoardHint label={props.queueInfo.detail}>
              <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-muted px-1.75 text-board-11 font-medium text-muted-foreground">
                <ClockIcon className="size-2.5" />
                {props.queueInfo.label}
              </span>
            </BoardHint>
          ) : null}
          {/* Shown only once this card actually overrides something.
              An override changes what the card spends and what authority it runs
              under; that should not be invisible from the card. It costs nothing
              on a card that has not set one. */}
          {modelOverridden ? (
            <BoardHint label={modelPillTitle}>
              <button
                className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.75 text-board-10-5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setModelsOpen(true)}
                type="button"
              >
                <SlidersHorizontalIcon className="size-2.5" />
                {modelPillLabel}
              </button>
            </BoardHint>
          ) : null}
          {/* The card's own merge strategy. Shown whenever the card has
              one, even one equal to the default, because it pins the card if the
              default moves. Neutral, like the models pill. */}
          {archived ||
          done ||
          mergeStrategy.pill === null ||
          onSetMergeStrategy === undefined ? null : (
            <BoardHint label={mergeStrategy.pill.tooltip}>
              <button
                className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.75 text-board-10-5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setMergeStrategyOpen(true)}
                type="button"
              >
                <MergeIcon className="size-2.5" />
                {mergeStrategy.pill.label}
              </button>
            </BoardHint>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2.25">
          <PaneTabs
            ciLive={inCi && isBoardCiLive(card.ci)}
            hasCi={hasCi}
            hasPlan={hasPlan}
            hasReview={hasReview}
            hasSummary={hasSummary}
            onSelect={setPane}
            hasPlanning={planningLink !== undefined}
            pane={activePane}
            planCount={planRows === null ? null : planRows.rows.length}
            plansLabel={group === null || planRows === null ? null : "Cards"}
          />
          <Menu>
            <MenuTrigger
              aria-label="More actions"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
              title="More actions"
            >
              <EllipsisVerticalIcon className="size-[15px]" />
            </MenuTrigger>
            {/* `min-w-*`, never a fixed width: the Models row below sizes itself
                to a mono override summary that can run long, and a hard box
                would crowd it. */}
            <MenuPopup align="end" className="min-w-42">
              {/* Opening the overrides CLOSES this menu: the popover
                  contains a model picker that is itself a popover, and selecting
                  from it is an outside-pointerdown on any menu still holding it
                  open. Base UI closes the menu; the row's selection is lost. */}
              {modelRows.length > 0 ? (
                <>
                  <MenuItem onClick={() => setModelsOpen(true)}>
                    <SlidersHorizontalIcon />
                    <span className="flex-1">Models</span>
                    <span className="font-mono text-board-11 font-medium text-muted-foreground">
                      {modelSummary}
                    </span>
                  </MenuItem>
                </>
              ) : null}
              {onSetMergeStrategy === undefined ? null : (
                <MenuItem onClick={() => setMergeStrategyOpen(true)}>
                  <MergeIcon />
                  <span className="flex-1">Merge strategy</span>
                  <span className="font-mono text-board-11 font-medium text-muted-foreground">
                    {mergeStrategy.menuValue}
                  </span>
                </MenuItem>
              )}
              {modelRows.length > 0 || onSetMergeStrategy !== undefined ? <MenuSeparator /> : null}
              <MenuItem
                onClick={() => {
                  if (!archived && group !== null) {
                    group.onArchive();
                    return;
                  }
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
          {/* Mounted only while open, so the lazy chunk is never fetched for a
              card nobody overrides. The anchor is a zero-size span sitting where
              the kebab is, which is what puts the popover under the kebab for
              both doors into it — the menu item and the header pill. */}
          {modelsOpen ? (
            <Suspense fallback={null}>
              <BoardCardModelsPopover
                anchor={<PopoverTrigger render={<span aria-hidden className="block size-0" />} />}
                onChange={props.onSetModelOverrides}
                onOpenChange={setModelsOpen}
                open={modelsOpen}
                overrides={card.modelOverrides}
                rows={modelRows}
                stepRunning={props.stepRunning === true}
              />
            </Suspense>
          ) : null}
          {mergeStrategyOpen && onSetMergeStrategy !== undefined ? (
            <Suspense fallback={null}>
              <BoardCardMergeStrategyPopover
                anchor={<PopoverTrigger render={<span aria-hidden className="block size-0" />} />}
                onChange={onSetMergeStrategy}
                onOpenChange={setMergeStrategyOpen}
                open={mergeStrategyOpen}
                options={mergeStrategy.options}
                value={card.mergeStrategy}
              />
            </Suspense>
          ) : null}
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
          <BoardHint label="Close">
            <button
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={props.onClose}
              type="button"
            >
              <XIcon className="size-[15px]" />
            </button>
          </BoardHint>
        </div>
      </div>

      <TitleBody done={done} onSave={props.onSaveTitle} title={card.title} />

      {/* One insertion above the layout split covers both forms. Only
          the wide one offers `View thread`: the narrow layout has no thread
          pane to send anyone to. */}
      {/* The hold banner. Mutually exclusive with the conflict
          banner above by construction — the server clears the hold when a
          conflict fix starts — and rendered after it so a card that somehow
          carries both leads with the thing that is actually running. */}
      {autoMergeBanner === null ? null : <AutoMergeBanner info={autoMergeBanner} />}
      {ciBanner === null ? null : (
        <BoardCiSentBackBanner banner={ciBanner} onViewRun={() => setPane("ci")} />
      )}
      {props.conflictFix === null ? null : (
        <ConflictBanner
          info={props.conflictFix}
          onViewThread={
            wide
              ? () => {
                  // Clearing the pinned tab restores the card's default, which
                  // at the merge stage IS the conflict fix's thread — the same
                  // one `initialBoardCardThreadId` resolves for a card sitting
                  // there. No navigation: the modal stays open on the card.
                  setSelectedThreadId(null);
                  setPane("thread");
                }
              : undefined
          }
        />
      )}

      {wide ? (
        <div className="mt-3 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_336px] border-t border-border">
          {activePane === "brief" ? (
            <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3.5 pr-3">
                <SectionHeading>Brief</SectionHeading>
                <span className="flex-1" />
                <button
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-board-7 border border-input bg-popover pl-1.5 pr-2.5 text-board-11-5 font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
                  onClick={() => setPane("thread")}
                  type="button"
                >
                  <ChevronLeftIcon className="size-3" />
                  Back to thread
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4 pb-6">
                <BriefBody
                  attachmentLimits={props.attachmentLimits}
                  attachments={props.detail.card.attachments}
                  brief={props.detail.brief}
                  cardId={props.detail.card.id}
                  environmentId={props.environmentId}
                  onAttachFile={props.onAttachFile}
                  onDetachFile={props.onDetachFile}
                  onSave={props.onSaveBrief}
                />
              </div>
            </section>
          ) : activePane === "summary" && workSummary !== null ? (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardSummaryPane
                onBackToThread={() => setPane("thread")}
                onOpenChild={props.onOpenChildInSubBoard}
                onOpenPullRequest={props.onOpenPullRequest}
                onSelectReview={() => setPane("review")}
                summary={workSummary}
                buildPending={buildPending}
                decisionLog={
                  decisionLog === null ? null : (
                    <BoardDecisionLog
                      view={decisionLog}
                      open={logOpen}
                      onOpenChange={setLogOpen}
                      onSendBack={
                        buildStage === null
                          ? undefined
                          : () => {
                              props.onMoveStage(buildStage.stageId);
                              setPane("thread");
                            }
                      }
                      onFollowUp={(() => {
                        const create = props.onCreateFollowUp;
                        const draft = boardDecisionFollowUp({
                          cardKey: card.key,
                          rows: decisionLog.rows,
                        });
                        return create === undefined || draft === null
                          ? undefined
                          : () => create(draft);
                      })()}
                    />
                  )
                }
              />
            </Suspense>
          ) : activePane === "ci" ? (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardCiPane
                activeThreadId={activeThreadId}
                cardId={card.id}
                cardKey={card.key}
                environmentId={props.environmentId}
                projectId={card.projectId}
                ci={card.ci}
                inCi={inCi}
                lastOutcome={card.ciLastOutcome}
                onBackToThread={() => setPane("thread")}
                onOpenThread={(threadId) => {
                  setSelectedThreadId(threadId);
                  setPane("thread");
                }}
                onSkipCi={props.onSkipCi}
                onRetryCi={props.onRetryCi}
                onStopCi={props.onStopCi}
                onSendBack={props.onCiSendBack}
                passes={props.detail.ciPasses}
                completions={props.detail.stepCompletions}
                skipPending={props.skipCiPending}
                skipToLabel={(() => {
                  const next = boardCiAwareNextStageId(
                    props.stages,
                    BOARD_SEED_STAGE_IDS.ci,
                    false,
                  );
                  return next === null ? undefined : boardStageLabel(props.stages, next);
                })()}
              />
            </Suspense>
          ) : activePane === "review" ? (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardReviewPane
                completions={props.detail.stepCompletions}
                // Only the active thread on the review stage drives the
                // spinner; side conversations and other stages' threads do not.
                live={reviewLive}
                offStage={!onReviewStage}
                stalled={reviewStalled}
                maxRounds={props.reviewMaxRounds ?? DEFAULT_BOARD_REVIEW_ROUNDS}
                onAdvance={(() => {
                  // An ordinary, gated stage move; a CI stage in the pipeline
                  // is the next stop, never one to step over.
                  const next = boardCiAwareNextStageId(props.stages, card.stage, false);
                  return next === null || card.blocked ? undefined : () => props.onMoveStage(next);
                })()}
                onBackToThread={() => setPane("thread")}
                onSetRoundModel={props.onSetReviewRoundModel}
                phaseRuntimeMode={props.reviewPhaseRuntimeMode}
                onResume={props.onResumeReview}
                onRuling={onReviewStage ? props.onReviewRuling : undefined}
                onReopenStep={props.onReopenReviewStep}
                onSetRounds={props.onSetReviewRounds}
                overrides={props.reviewOverrides}
                roundsStarted={props.reviewRoundsStarted}
                stepActive={onReviewStage && props.reviewStepActive === true}
                onOpenThread={(threadId) => {
                  setSelectedThreadId(threadId);
                  setPane("thread");
                }}
              />
            </Suspense>
          ) : activePane === "plan" && planRows !== null ? (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardPlansPanel
                integrationBranch={card.worktree?.branch ?? null}
                onOpenChild={props.onOpenChildInSubBoard}
                ownBranch={group === null || group.ownBranch}
                onOpenSubBoard={props.onOpenOwnSubBoard}
                planRows={planRows}
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
                onReviewSplit={props.canApproveSplit ? () => setPane("thread") : undefined}
                onOpenChild={props.onOpenChildInSubBoard}
              />
            </Suspense>
          ) : (
            <Suspense fallback={<div className="min-h-0 border-r border-border bg-muted/55" />}>
              <BoardCardThreadPane
                adoptSearch={props.adoptSearch}
                adoptableThreads={props.adoptableThreads}
                cardKey={card.key}
                maximised={props.maximised}
                onCreateBlankThread={props.onCreateBlankThread}
                onLinkThread={props.onLinkThread}
                onRestartStage={props.onRestartStage}
                onSelectThread={selectThread}
                onToggleMaximised={props.onToggleMaximised}
                onUnlinkThread={props.onUnlinkThread}
                selectedThreadId={shownThread}
                stageRestart={props.stageRestart}
                threadLinks={props.threadLinks}
                threadTodos={props.threadTodos}
                queueInfo={props.queueInfo}
                queueForceStartPending={props.queueForceStartPending}
                onQueueForceStart={props.onQueueForceStart}
                footer={
                  props.canApproveSplit && props.splitGate !== null ? (
                    <BoardSplitGate
                      // A re-proposal is a new gate: start from its own
                      // recommendation rather than the last one's edits.
                      key={props.detail.plans.map((plan) => plan.planId + plan.updatedAt).join()}
                      {...props.splitGate}
                      onApprove={props.onApproveSplit}
                      onAskForChanges={() => {
                        // The planning thread, not whichever tab is open: that
                        // conversation proposed the split and must revise it.
                        const planningThread = initialBoardCardThreadId(
                          props.stages,
                          card.stage,
                          card.threadLinks,
                        );
                        const link = props.threadLinks.find(
                          (candidate) => candidate.threadId === planningThread,
                        );
                        if (link === undefined || link.tombstoned) return;
                        selectThread(link.threadId);
                        useComposerDraftStore
                          .getState()
                          .setPrompt(
                            scopeThreadRef(link.worker.environmentId, link.threadId),
                            BOARD_SPLIT_CHANGE_REQUEST_PREFILL,
                          );
                      }}
                      plans={props.detail.plans}
                      splitRationale={card.splitRationale}
                    />
                  ) : null
                }
              />
            </Suspense>
          )}

          {/* The rail: everything about the card that is not the conversation. */}
          <div className="flex min-h-0 flex-col overflow-y-auto [&>*:first-child]:border-t-0">
            {group === null || groupUsesCardActions ? (
              <ActionsSection
                group={group}
                onReviewSplit={() => setPane("thread")}
                props={props}
                unmet={unmet}
              />
            ) : (
              <GroupActionsSection group={group} props={props} unmet={unmet} />
            )}
            <PlanReviewSection key={props.detail.card.id} props={props} />
            <QueueSection props={props} />
            {props.stepFailure !== null ? (
              <BoardCardStepFailure
                className="mx-3.5 mb-3.5"
                stageLabel={props.stepFailure.stageLabel}
                error={props.stepFailure.error}
                waiting={props.stepFailure.waiting}
              />
            ) : null}
            {props.worktreeKept == null ? null : (
              <BoardCardWorktreeKept
                className="mx-3.5 mb-3.5"
                {...worktreeKeptProps(props, props.worktreeKept)}
              />
            )}
            {props.stepPaused !== null ? (
              <BoardCardStepPaused
                className="mx-3.5 mb-3.5"
                stageLabel={props.stepPaused.stageLabel}
                onResume={props.onResumeStep ?? null}
                resuming={props.resumeStepPending === true}
              />
            ) : null}
            {props.feedback !== null ? (
              <p className="mx-3.5 mb-3.5 rounded-md bg-destructive/10 px-2 py-1.5 text-board-12 text-destructive-foreground">
                {props.feedback}
              </p>
            ) : null}
            <RailSections
              group={group}
              onOpenCi={hasCi ? () => setPane("ci") : undefined}
              onOpenThread={selectThread}
              props={props}
            />
          </div>
        </div>
      ) : (
        <div className="mt-3 flex min-h-0 flex-[0_1_auto] flex-col overflow-y-auto border-t border-border">
          <div className="flex items-stretch">
            {/* ── Left: what the card is ─────────────────────────────── */}
            <div className="flex min-w-0 flex-1 flex-col gap-4.5 px-5 pt-4 pb-5">
              {props.stepFailure !== null ? (
                <BoardCardStepFailure
                  stageLabel={props.stepFailure.stageLabel}
                  error={props.stepFailure.error}
                  waiting={props.stepFailure.waiting}
                />
              ) : null}
              {props.worktreeKept == null ? null : (
                <BoardCardWorktreeKept {...worktreeKeptProps(props, props.worktreeKept)} />
              )}
              {props.stepPaused !== null ? (
                <BoardCardStepPaused
                  stageLabel={props.stepPaused.stageLabel}
                  onResume={props.onResumeStep ?? null}
                  resuming={props.resumeStepPending === true}
                />
              ) : null}
              {props.feedback !== null ? (
                <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-board-12 text-destructive-foreground">
                  {props.feedback}
                </p>
              ) : null}

              <div className="min-w-0">
                <SectionHeading className="mb-[7px]">Brief</SectionHeading>
                <BriefBody
                  attachmentLimits={props.attachmentLimits}
                  attachments={props.detail.card.attachments}
                  brief={props.detail.brief}
                  cardId={props.detail.card.id}
                  environmentId={props.environmentId}
                  onAttachFile={props.onAttachFile}
                  onDetachFile={props.onDetachFile}
                  onSave={props.onSaveBrief}
                />
              </div>

              {/* The mockup's pre-Planning card has no Threads section —
                  adoption belongs to the thread pane. A card that already
                  carries links still shows them, so state is never hidden. */}
              {props.threadLinks.length === 0 ? null : (
                <div className="min-w-0">
                  <ThreadsSection {...props} />
                </div>
              )}
            </div>

            {/* ── Right: what you can do with it ──────────────────────── */}
            <div className="flex w-[244px] shrink-0 flex-col border-l border-border [&>*:first-child]:border-t-0">
              {group === null || groupUsesCardActions ? (
                <ActionsSection
                  group={group}
                  onReviewSplit={() => setPane("thread")}
                  props={props}
                  unmet={unmet}
                />
              ) : (
                <GroupActionsSection group={group} props={props} unmet={unmet} />
              )}
              <PlanReviewSection key={props.detail.card.id} props={props} />
              <RailSections
                group={group}
                onOpenCi={hasCi ? () => setPane("ci") : undefined}
                onOpenThread={selectThread}
                props={props}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The kept-worktree banner's props, shared by the two layouts. */
function worktreeKeptProps(
  props: BoardCardDetailViewProps,
  kept: NonNullable<BoardCardDetailViewProps["worktreeKept"]>,
) {
  return {
    reason: kept.reason,
    path: kept.path,
    branch: kept.branch,
    cancelledWork: kept.cancelledWork,
    onCheckAgain: props.onCheckWorktree ?? null,
    checking: props.checkingWorktree === true,
    onRemove: props.onRemoveWorktree ?? null,
    removing: props.removingWorktree === true,
  };
}

export function BoardCardDetailView(props: BoardCardDetailViewProps) {
  // Fullscreen must outlive the per-card remount when stepping to the next
  // card, so it lives in a store keyed by card id; a card opened any other way
  // does not match and opens windowed.
  const cardId = props.detail.card.id;
  const maximised = useBoardUiStore((state) => state.detailMaximisedCardId === cardId);
  const setMaximisedCardId = useBoardUiStore((state) => state.setDetailMaximisedCardId);
  const [paneChoice, setPaneChoice] = useState<BoardCardPane | null>(null);
  const wide = boardCardDetailIsWide(props.stages, props.detail.card.stage, paneChoice);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <BoardCardDetailPopup
        cardId={cardId}
        maximised={wide && maximised}
        nav={props.nav}
        wide={wide}
      >
        <BoardCardDetailPanel
          {...props}
          maximised={maximised}
          onSelectPane={setPaneChoice}
          onToggleMaximised={() => setMaximisedCardId(maximised ? null : cardId)}
          paneChoice={paneChoice}
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
  nav = null,
  children,
}: {
  readonly cardId: BoardCardId | null;
  readonly wide?: boolean;
  readonly maximised?: boolean;
  /** Step to the card before/after this one on the board. The
      loading frame takes it too, so stepping never blinks the chevrons out
      while the next card's detail subscription opens. */
  readonly nav?: BoardCardNav | null | undefined;
  readonly children: React.ReactNode;
}) {
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  useBoardCardNavKeys(sheet, nav);
  return (
    <DialogPopup
      aria-labelledby={CARD_TITLE_ID}
      className={cn(
        // `group/sheet` is what the nav rails watch: they reveal on hover of
        // the whole sheet, not of their own invisible band.
        "group/sheet overflow-hidden p-0",
        maximised
          ? "fixed inset-0 h-screen max-h-none w-screen max-w-none rounded-none border-0"
          : wide
            ? // Under 1000px tall, take all but a 0.5rem sliver: the negative
              // margin reaches into the viewport's 1rem padding. `sm:` spares
              // the phone bottom sheet.
              "h-[86vh] max-h-[86vh] w-[min(1220px,100%)] max-w-[1220px] sm:[@media(max-height:999.98px)]:-my-2 sm:[@media(max-height:999.98px)]:h-[calc(100dvh-1rem)] sm:[@media(max-height:999.98px)]:max-h-[calc(100dvh-1rem)]"
            : "max-h-[86vh] w-[min(760px,100%)] max-w-[760px]",
      )}
      ref={setSheet}
      showCloseButton={false}
      {...(cardId === null ? {} : { "data-board-card-detail": cardId })}
    >
      {children}
      {/* Last in the DOM so Tab reaches Close and the composer first; the
          stacking that keeps the header's buttons hit-testable over a rail is
          the explicit z-index on each, not source order. */}
      <BoardCardNavRails nav={nav} />
    </DialogPopup>
  );
}
