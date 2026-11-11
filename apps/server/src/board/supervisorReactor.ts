/**
 * The board's effectful shell: consumes board and thread-lifecycle events and drives each
 * card's step through Select, Admit, Spawn, Run, Settle, Release. Decisions are pure functions
 * in `supervisor.ts`. Thread death is routine control flow, recovery escalates and never loops,
 * and boot reconciliation re-reads every non-terminal step because the server restarts mid-step.
 */
import {
  BOARD_CI_STOPPED_BY_YOU_REASON,
  BOARD_LOCAL_WORKER_ID,
  BOARD_SEED_STAGE_IDS,
  DEFAULT_BOARD_CI_MAX_FIX_ATTEMPTS,
  areBoardStagesAdjacent,
  isBoardCiActive,
  isBoardCiSwitchedOn,
  boardCiFixIssues,
  boardCiNextSegment,
  boardCiStopsOnFailure,
  boardCiPassStepsFromSnapshot,
  type BoardCiForgeChecksReading,
  boardCiAgentStepId,
  composeBoardCiAgentStepPrompt,
  type BoardCardCi,
  type BoardCiHeadline,
  type BoardCiStep,
  type BoardCiPassStep,
  isBoardCiStepFailure,
  type BoardCiActionResult,
  isBoardCiPassSettledPhase,
  parseBoardCiAgentStepId,
  parseBoardCiFixStepId,
  boardCiScriptDefinitions,
  isBoardCiStageExecution,
  type BoardSkipCiResult,
  boardCardEffectiveWorkerId,
  boardRepositoryGroupingKey,
  boardThreadLinkWorkerId,
  EMPTY_BOARD_WORKERS_STATE,
  type BoardStepQueuedBy,
  type BoardWorkerId,
  boardCardAutoArchiveDue,
  BOARD_AUTO_PLAN_OFF_INSTRUCTION,
  boardAutoPlanInstruction,
  BOARD_PLAN_REVIEW_LATE_START_LEAD,
  boardPlanReviewRoundsChangedLead,
  BOARD_PLAN_REVIEW_STOP_INSTRUCTION,
  BOARD_DECISION_REASON_MAX_LENGTH,
  BOARD_DECISION_TEXT_MAX_LENGTH,
  isBoardCardAutoPlanPending,
  boardCardAutoBuildDue,
  boardStageBeforeBuild,
  boardCardPlanningFinished,
  type BoardAutomationChanged,
  type BoardResolvedAutomation,
  resolveBoardCardAutomationIn,
  boardCardChildren,
  boardBuildHumanInLoopDefault,
  boardCardPendingSplit,
  boardCardPlans,
  boardSubBoardFloorStage,
  unmetBoardCardDependencies,
  boardCardPullRequestsEqual,
  boardPullRequestPredatesCard,
  boardCardStepCompletions,
  boardCardUnfinishedChildren,
  boardCardStepState,
  boardReviewRoundsStarted,
  boardReviewStuckState,
  boardReviewCarryFromStuck,
  type BoardReviewCarry,
  type BoardRequestReviewRoundInput,
  boardRunLabel,
  boardSelectedStepLabel,
  boardNextStageId,
  boardProjectStageConfig,
  boardNonTerminalStepStates,
  boardSeedStageRole,
  boardStageById,
  boardStageEntryRecoveryCount,
  boardStepErrorSummary,
  boardStageIndex,
  boardCardHasLiveBranch,
  boardStageWithRole,
  parseReviewStepId,
  resolveBoardCardEffectiveBase,
  CommandId,
  BOARD_ENVELOPE_QUESTION_MECHANISM,
  boardBlockedInstruction,
  boardReviewQuestionAnswer,
  boardTextEndsWithQuestion,
  applyBoardRetryJitter,
  boardCardAutoMergeArmed,
  type BoardCardAutoMergeHold,
  BOARD_AUTO_MERGE_RETRY_DELAYS_MS,
  boardRetryDelayMs,
  type BoardCardStepStalledReason,
  BOARD_SUBMIT_STEP_ID,
  BOARD_SUBMIT_STEP_LABEL,
  DEFAULT_BOARD_BUILD_STAGE_EXECUTION,
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EMPTY_BOARD_STATE,
  effectiveBoardStageRole,
  isBoardCardPullRequestTerminal,
  isBoardBuildStageExecution,
  isBoardMergeStageExecution,
  isBoardReviewStageExecution,
  DEFAULT_BOARD_CHECKS_FIX_PROMPT,
  type BoardMergeFixKind,
  isBoardCardScheduleDue,
  isBoardParkedStepStatus,
  isBoardTerminalStepStatus,
  effectiveBoardRuntimeMode,
  isLiveBoardCardThreadLink,
  resolveBoardStageExecution,
  resolveBoardDefaultModelSelection,
  resolveBoardStageModelSelection,
  resolveBoardCardMergeStrategy,
  resolveBoardCardStageModelOverride,
  boardModelSelectionOfOverride,
  type BoardCardStageModelOverride,
  ThreadId,
  type ChatAttachment,
  type BoardCard,
  type BoardWorkspaceIntegrationBranch,
  type BoardCardId,
  type BoardCheckCardWorktreeResult,
  type BoardCardPullRequest,
  type BoardCardPullRequestTarget,
  type BoardLinkCardPullRequestResult,
  type ProjectId,
  // T3o: the refresh answers rather than staying silent.
  type BoardRefreshCardPullRequestResult,
  type BoardCardStepAwaitingReason,
  type BoardCardStepState,
  type BoardSettings,
  type BoardStageExecution,
  type BoardStageRole,
  type BoardState,
  type BoardEvent,
  boardCardActiveChildren,
  boardCardAncestors,
  boardCardGroupOf,
  boardCardInheritedDependsOn,
  boardCardDisplayPullRequest,
  boardCardIntegrationAncestor,
  boardCardLiveChildren,
  boardCardWorktreeIsCancelledWork,
  boardGroupRevertsToCard,
  boardCardMergesIntoIntegrationBranch,
  deriveBoardGroupStage,
  isBoardCardPlanned,
  type BoardCiFixIssue,
  textGeneratorForSelection,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { BoardSetupScriptRunner } from "./ports/BoardSetupScriptRunner.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked, ServerActivation } from "../serverActivation.ts";
import { BoardStepSlots, type BoardConcurrencyLimit, type BoardSlotKey } from "./BoardStepSlots.ts";
import { BoardEngine } from "./BoardEngine.ts";
import type { BoardDispatchError } from "./errors.ts";
import { BoardQueries } from "./BoardQueries.ts";
import {
  ThreadCommandFailedError,
  ThreadGateway,
  ThreadReadError,
  UNKNOWN_THREAD_STATE,
  type BoardProject,
  type ThreadCommandError,
  type ThreadSignal,
} from "./ThreadGateway.ts";
import type { BoardCommand } from "./decider.ts";
import { resolveCardPullRequestTarget } from "./cardPullRequestTarget.ts";
import {
  removeBoardCardAttachmentsDir,
  resolveBoardCardAttachmentPath,
  spawnPushesBriefImages,
  stageBoardCardImagesAsPending,
} from "./attachments.ts";
import { BoardPlacement, boardPlacementGate } from "./workers/BoardPlacement.ts";
import {
  assertSingleBoardWorktreeWriter,
  boardCardWorktreeBranchName,
  resolveBoardCardBaseRef,
  runBoardCardWorktreeSetup,
} from "./worktree.ts";
import {
  BOARD_STEP_RESUME_NUDGE,
  BOARD_STEP_USAGE_LIMIT_RESUME_NUDGE,
  boardBackgroundCheckInCharged,
  boardBackgroundCheckInDueMs,
  boardBackgroundCheckInNudge,
  boardOfflineCreditMs,
  boardRecoveryNudge,
  composeStepPrompt,
  orderBoardQueue,
  outputSignalShieldsStep,
  reconcileStepDecision,
  recoveryCeilingCrossed,
  recoveryDecision,
  resolveBoardConcurrencyLimit,
  type BoardOfflineInterval,
  type BoardQueueCandidate,
} from "./supervisor.ts";
// T3o: the auto-merge classification and retry ladder.
import {
  boardAutoMergeLadderStep,
  classifyBoardAutoMergeRefusal,
  UNCLASSIFIED_AUTO_MERGE_VERDICT,
  type BoardAutoMergeVerdict,
} from "./autoMergeClassification.ts";
import {
  boardFilteredMergeChecks,
  boardHostMergeRefusalReason,
  LOCAL_CONFLICT_MERGE_STATE,
  type BoardMergeState,
} from "./boardMergeState.ts";
import { stageExecutorFor } from "./stageExecutor.ts";
import { BoardCiRunner, boardCiLogDir } from "./ci/BoardCiRunner.ts";
import { remoteCiRunner } from "./ci/remoteCiRunner.ts";
import { boardCiMachineHoldReason } from "./ci/ciFailureHeadline.ts";
import { boardCiHostName, boardCiLowDiskReason } from "./ci/diskSpace.ts";
import { WorkerConnections } from "./workers/WorkerConnections.ts";
import { BOARD_HUMAN_ACTOR_FALLBACK_NAME, boardActivityActorFor } from "./activityActors.ts";
import {
  BOARD_CI_SLOT_INSTANCE,
  makeBoardCiPasses,
  type BoardCiPasses,
  type BoardCiPassFinished,
} from "./ci/ciPasses.ts";
import type { BoardCiFailure, BoardStagePlan } from "./stageExecutor.ts";
import { boardCiSendBackFinding } from "./ci/ciStageExecutor.ts";
import { BoardWorkspaces, type BoardCardWorkspace } from "./workspace/BoardWorkspace.ts";
import { planReviewInstructions, runningPlanReviewStep } from "./planReview.ts";
import { keepsPlanningThreadOnExit, keptPlanningThreadId } from "./planningThreadKeep.ts";
import { boardReleasedThreadIds } from "./threadRelease.ts";

/** What a Merge click did, for the RPC to turn into a toast. */
export type BoardMergeAttemptResult =
  | { readonly outcome: "merged"; readonly number: number }
  | { readonly outcome: "conflict"; readonly detail: string }
  /** T3o: the checks failed and a CI-fix step has been started. */
  | { readonly outcome: "checks-fix"; readonly detail: string }
  | {
      readonly outcome: "refused";
      readonly detail: string;
      /**
       * The probe that produced `detail`. Absent when the refusal was decided without asking the
       * forge, which the ladder reads as unclassifiable (the safe direction). Internal: the RPC
       * layer reads only `detail`.
       */
      readonly mergeState?: BoardMergeState | null;
      /**
       * The refusal is permanent (an unsupported merge strategy, a missing permission), so the
       * ladder must not re-ask; it reads like the `not-open` / `no-pull-request` outcomes.
       */
      readonly permanent?: boolean;
    }
  | { readonly outcome: "not-open"; readonly state: "closed" | "merged" }
  | { readonly outcome: "no-pull-request" }
  | { readonly outcome: "no-workspace" }
  /** The card is not in the merge-role stage. The button only renders there,
      so this is a client that called the RPC without one. */
  | { readonly outcome: "wrong-stage" }
  /** The card's base moved since its last review round started:
      the card went back to review to rebase and run one gate round instead of
      merging an unreviewed combined diff. */
  | { readonly outcome: "stale-base" }
  | { readonly outcome: "unknown-card" };

/** What a "Submit for merge — no review" click did, for the RPC
    to turn into a sentence on the card. */
export type BoardSubmitAttemptResult =
  | { readonly outcome: "started" }
  | { readonly outcome: "wrong-stage" }
  | { readonly outcome: "step-running" }
  | { readonly outcome: "no-branch" }
  | { readonly outcome: "no-merge-stage" }
  | { readonly outcome: "blocked" }
  /** A forward gate past the build role would refuse the directed move — an
      unfinished sub-board child, an unapproved split. Pre-checked, because the
      refusal itself only lands after the step has pushed and opened the pull
      request. */
  | { readonly outcome: "refused"; readonly detail: string }
  | { readonly outcome: "unknown-card" }
  | { readonly outcome: "failed" };

/** What "Another review round" / "Request review" did, for
    the RPC to turn into a sentence on the card. */
export type BoardRequestReviewRoundResult =
  | { readonly outcome: "started"; readonly round: number }
  | { readonly outcome: "no-review-stage" }
  | { readonly outcome: "wrong-stage" }
  | { readonly outcome: "step-running" }
  | { readonly outcome: "no-branch" }
  | { readonly outcome: "unknown-card" }
  | { readonly outcome: "not-stuck" }
  | { readonly outcome: "stuck" }
  | { readonly outcome: "failed" };

/** What "Remove worktree" did, for the RPC to turn into a
    sentence on the card. */
export type BoardForceRemoveWorktreeResult =
  | { readonly outcome: "removed" }
  | { readonly outcome: "no-worktree" }
  | { readonly outcome: "not-finished" }
  | { readonly outcome: "unknown-card" }
  | { readonly outcome: "failed" };

/** What one reclaim attempt on a card's worktree did: removed, kept
    with the refusal it recorded, or skipped because another reclaim of the
    same card was already running. */
type BoardCardReclaimAttempt =
  | { readonly outcome: "removed" }
  | { readonly outcome: "kept"; readonly reason: string | null }
  | { readonly outcome: "busy" }
  | { readonly outcome: "failed" };

/** How a CI hold marks the pass beyond its reason. */
type CiHoldOptions = { readonly machine?: boolean; readonly headline?: BoardCiHeadline };

const isThreadCommandFailed = Schema.is(ThreadCommandFailedError);

/**
 * What a failed spawn left behind, read off the remote gateway's cause: `none` (no thread
 * exists), `worker-offline` (nothing was sent), or `unknown` (a `WorkerRpcError` on the spawn
 * call itself: the worker may have created the thread, so it must not be read as none).
 */
const spawnFailureLeft = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause).pipe(Option.getOrUndefined);
  const reason = isThreadCommandFailed(error) ? error.cause : undefined;
  if (Predicate.isTagged(reason, "WorkerUnavailable")) return "worker-offline" as const;
  if (Predicate.isTagged(reason, "WorkerRpcError")) return "unknown" as const;
  return "none" as const;
};

// Consecutive git failures provisioning one card's branch before the build
// step parks for a human instead of retrying again.
const TRANSIENT_PROVISION_FAILURE_LIMIT = 3;

/** What provisioning a card's worktree came to: a path, a failure
    only a human can fix, or one the next scheduling pass may get past. */
type WorktreeOutcome =
  | { readonly kind: "ready"; readonly path: string }
  | { readonly kind: "stuck"; readonly reason: string }
  | { readonly kind: "transient"; readonly reason?: string };

export interface SupervisorReactorShape {
  /** Reconcile persisted step state, then subscribe to board and thread
      events. Must run in a scope so worker fibers finalize on shutdown. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Reconcile every non-terminal step against the live world (boot / test). */
  readonly reconcile: Effect.Effect<void>;
  /** One timeout-sweep pass over running unattended steps. In
      production the worker runs it on a timer; exposed so tests can drive the
      liveness clock deterministically. */
  readonly sweep: Effect.Effect<void>;
  /** One scheduled-start pass: clear every card whose time has arrived, which
      is what makes it act. Rides the same 30s timer as the
      sweep in production; exposed for the same reason, so a test can fire a due
      card without wall-clock time. */
  readonly fireSchedules: Effect.Effect<void>;
  /** One auto-archive pass over idle Done cards. Same 30s timer;
      exposed so a test can age a card with `TestClock` and fire the pass. */
  readonly fireAutoArchives: Effect.Effect<void>;
  /** One auto-start pass: move every armed card whose dependencies are all met
      into the build-role stage. Rides the same 30s timer and
      boot reconciliation; exposed so a test can drive the self-healing pass
      without wall-clock time. */
  readonly startArmed: Effect.Effect<void>;
  /** One retry pass: requeue every step whose backoff rung has arrived.
      Rides the same 30s timer and boot reconciliation; exposed so a test
      can fire a due rung without waiting two minutes of wall-clock time. */
  readonly fireRetries: Effect.Effect<void>;
  /** One auto-merge pass: attempt every armed card whose retry rung has
      arrived. Same 30s timer and boot reconciliation as the
      passes above; exposed so a test can walk the ladder without
      waiting eighty-six minutes of wall-clock time. */
  readonly fireAutoMerges: Effect.Effect<void>;
  /** One release pass: settle every thread the board is finished with.
      Runs on the same timer as the sweep and at every step boundary; exposed so
      tests can drive the retry that lands after an agent's turn ends. */
  readonly releaseThreads: Effect.Effect<void>;
  /** Resolves when the internal queue, and the per-card worktree cleanup it
      hands off, are empty and idle (test hook). */
  readonly drain: Effect.Effect<void>;
  /** Ask for a worktree-cleanup pass; single-flight, so a burst
      of requests runs at most one pass plus one follow-up. */
  readonly sweepWorktrees: (options?: {
    readonly refreshOpenPullRequests?: boolean;
  }) => Effect.Effect<void>;
  /** Resolves when the reactor's queue is idle and no worktree-cleanup pass
      is running or queued (test hook). */
  readonly drainWorktreeSweep: Effect.Effect<void>;
  /** A human's "Remove worktree" on a finished card. */
  readonly forceRemoveWorktree: (
    cardId: BoardCardId,
  ) => Effect.Effect<BoardForceRemoveWorktreeResult>;
  /** A human's "Check again" on a card that kept its worktree: a
      forced pull-request refresh, then the settle, answering what the reclaim
      did — so a repeat refusal, which writes nothing, still says so. */
  readonly checkWorktree: (cardId: BoardCardId) => Effect.Effect<BoardCheckCardWorktreeResult>;
  /**
   * Re-resolve one card's pull request from the forge and record any change. `force` is a
   * human's "Check again": it bypasses the lookup cache and its backoff, and the answer tells
   * "no pull request" apart from "the forge could not be asked".
   */
  readonly refreshPullRequest: (
    cardId: BoardCardId,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<BoardRefreshCardPullRequestResult>;
  /** Check a pull request can be linked to a card in this project:
      on the project's repository, and known to the forge. Records nothing. */
  readonly resolvePullRequestLink: (
    projectId: ProjectId,
    target: BoardCardPullRequestTarget,
  ) => Effect.Effect<
    | { readonly outcome: "resolved"; readonly pullRequest: BoardCardPullRequest }
    | { readonly outcome: "refused"; readonly detail: string }
  >;
  /** Link a pull request to a card explicitly, or clear the link with `null`.
      `resolved` is a `resolvePullRequestLink` answer the caller
      already holds. */
  readonly linkPullRequest: (
    cardId: BoardCardId,
    target: BoardCardPullRequestTarget | null,
    options?: { readonly resolved?: BoardCardPullRequest },
  ) => Effect.Effect<BoardLinkCardPullRequestResult>;
  /** Merge a card's pull request and advance it (the Merge button). */
  readonly mergePullRequest: (cardId: BoardCardId) => Effect.Effect<BoardMergeAttemptResult>;
  /** Open the card's pull request from Building and route it past Code review
      ("Submit for merge — no review"). */
  readonly submitForMerge: (cardId: BoardCardId) => Effect.Effect<BoardSubmitAttemptResult>;
  /** Run one more review round on a settled loop — "Another
      review round" from Code review or Ready for merge, and "Request review"
      on a card that has never had one. */
  /** Wait until no CI pass is running and what each one's end started has
      been handled. Tests drain on it. */
  readonly drainCi: Effect.Effect<void>;
  /** Skip CI for a card in the CI stage: a human's override. `stamp`
      marks the commands it dispatches as the human's. */
  readonly skipCi: (
    cardId: BoardCardId,
    stamp: (command: BoardCommand) => Effect.Effect<void>,
  ) => Effect.Effect<BoardSkipCiResult>;
  readonly requestReviewRound: (
    cardId: BoardCardId,
    carry?: BoardRequestReviewRoundInput["carry"] | undefined,
  ) => Effect.Effect<BoardRequestReviewRoundResult>;
  /** Retry CI and "Send back to review anyway": a human's way out
      of a stopped or held CI pass. */
  /** Retry CI, or Stop CI with `action: "stop"`. */
  readonly retryCi: (
    cardId: BoardCardId,
    action?: "retry" | "stop",
  ) => Effect.Effect<BoardCiActionResult>;
  readonly ciSendBack: (cardId: BoardCardId) => Effect.Effect<BoardCiActionResult>;
}

/** A string cut to `max` characters, ending in an ellipsis when cut. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** Epoch millis off the Effect clock, never `new Date()`, so a test's
    `TestClock` moves every due-time comparison the reactor makes. */
const clockNowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

/** How long past a provider's reset time the board's own safety-net wake
    waits for a usage-limit park. The engine resumes the thread AT the
    reset; the grace keeps the board from racing it to the same thread. */
const USAGE_LIMIT_RESUME_GRACE_MS = 10 * 60_000;

export class SupervisorReactor extends Context.Service<SupervisorReactor, SupervisorReactorShape>()(
  "t3/board/supervisorReactor",
) {}

type SupervisorInput =
  | { readonly source: "domain"; readonly event: BoardEvent }
  | { readonly source: "thread"; readonly signal: ThreadSignal }
  // Boot reconcile, run THROUGH the worker so it is serialised before the live
  // events it causes (the subscriptions attach first — see `start`).
  | { readonly source: "reconcile" }
  // Periodic timeout sweep: the edge-triggered turn.completed path
  // cannot see a turn that HANGS, so a timer funnels overdue running steps
  // into the same recovery ladder.
  | { readonly source: "timeout-sweep" }
  // The board's workers changed — a clone finished, a worker came
  // online, an instance appeared — which may start a held card.
  | { readonly source: "workers" }
  // A CI pass finished on its own fiber; what follows is decided here.
  | { readonly source: "ci"; readonly finished: BoardCiPassFinished };

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** How much of a forge refusal an auto-merge hold keeps. The
    reason rides every card-carrying event and renders in a banner; `gh` will
    happily print several paragraphs. Long enough for the sentence that
    matters, short enough that it cannot bloat the log. */
const MAX_AUTO_MERGE_REASON_LENGTH = 400;

/** The board with the projects its cards live in. */
interface BoardWorld {
  readonly board: BoardState | undefined;
  readonly projects: ReadonlyArray<BoardProject>;
}

/**
 * A card whose work was cancelled to make it a parent and whose
 * checkout is still there. Only an own-branch group legitimately holds a ready
 * worktree, and the decider refuses `target=own` until this one is reclaimed
 * and refuses dropping `own` while a group's integration worktree exists.
 */
function holdsCancelledWork(card: BoardCard): boolean {
  return boardCardWorktreeIsCancelledWork(card) && card.worktree?.status === "ready";
}

/** The children of `card` archived before it, with everything under them. */
function earlierArchivedSubtrees(
  cards: ReadonlyArray<BoardCard>,
  card: BoardCard,
): ReadonlyArray<BoardCard> {
  const out: BoardCard[] = [];
  const seen = new Set<string>([String(card.id)]);
  const walk = (parentId: BoardCardId, all: boolean) => {
    for (const child of cards) {
      if (child.parentCardId !== parentId || seen.has(String(child.id))) continue;
      if (!all && (child.archivedAt === null || child.archivedAt === card.archivedAt)) continue;
      seen.add(String(child.id));
      out.push(child);
      walk(child.id, true);
    }
  };
  walk(card.id, false);
  return out;
}

/**
 * The model/access override for the card's current stage, nearest group ancestor first, or
 * null when the workspace config governs. Handed down on the executor config rather than
 * folded into `model`, so only the executor knows how a review stage treats it.
 */
function cardStageModelOverride(
  board: BoardState,
  card: BoardCard,
): BoardCardStageModelOverride | null {
  return resolveBoardCardStageModelOverride({
    card,
    ancestors: boardCardAncestors(board, card),
    stageId: card.stage,
  });
}

/**
 * Whether the step row is a review-loop phase that settled `succeeded` while the card is still
 * in its review stage, so the loop may owe a phase nobody started. Only an owed `run` resumes,
 * without measuring base staleness: a failed final `advanceStage`, an owed `sync@N` and a failed
 * stage-entry kickoff stay parked until a human moves the card.
 */
function settledReviewPhase(
  board: BoardState,
  card: BoardCard,
  state: BoardCardStepState,
): boolean {
  if (state.status !== "succeeded" || parseReviewStepId(state.stepId) === null) return false;
  const stage = boardStageById(board, card.stage);
  return stage !== null && effectiveBoardStageRole(stage) === "review";
}

/** Triage and adjudication steps, which never wait on a human. */
const spawnFailureError = (result: string | null) =>
  result === "no-agent-model"
    ? { lastError: "No model to run this stage: set a default model in Settings → Board." }
    : {};

const isReviewDecidingStep = (state: Pick<BoardCardStepState, "stepId">): boolean =>
  boardReviewQuestionAnswer(state.stepId) !== null;

const make = Effect.gen(function* () {
  const crypto = yield* SecureRandom.SecureRandom;
  const boardEngine = yield* BoardEngine;
  const boardQueries = yield* BoardQueries;
  const threads = yield* ThreadGateway;
  const serverSettings = yield* ServerSettingsService;
  const slots = yield* BoardStepSlots;
  // Every git and forge operation for a card runs in the card's
  // workspace — this server's, or the worker it is placed on.
  const workspaces = yield* BoardWorkspaces;
  const workspaceFor = (card: Pick<BoardCard, "id" | "projectId">) => workspaces.forCard(card);
  const setupRunner = yield* BoardSetupScriptRunner;
  // Captured at construction, where the reference is in scope: `reconcile` runs on the worker
  // fiber in the caller's context. Defaults to `undefined`, so tests wire no activation.
  const serverActivation = yield* ServerActivation;
  // Each project's committed t3o.json, read from its checkout here.
  // CI steps run by the board itself, here or on a card's worker.
  const ciRunner = yield* BoardCiRunner;
  const workerConnections = yield* Effect.serviceOption(WorkerConnections);

  const commandId = (tag: string) =>
    crypto.uuidV4().pipe(Effect.map((uuid) => CommandId.make(`server:board-${tag}:${uuid}`)));
  const freshThreadId = crypto.uuidV4().pipe(Effect.map((uuid) => ThreadId.make(`thread-${uuid}`)));

  const readBoard = boardEngine.getReadModel.pipe(
    Effect.map((model): BoardState => model.board ?? EMPTY_BOARD_STATE),
  );

  /**
   * Where a step's slot is held: the worker its thread runs on,
   * or — before it has one — the worker its card runs on. A release lands on
   * the worker its acquire did: a move is refused while a step runs, and every
   * parked status gives its slot back first.
   */
  const slotKeyFor = (
    board: BoardState,
    state: Pick<BoardCardStepState, "cardId" | "threadId" | "providerInstanceId">,
  ): BoardSlotKey => {
    const card = board.cards.find((candidate) => candidate.id === state.cardId);
    const link =
      state.threadId === null
        ? undefined
        : card?.threadLinks.find((candidate) => candidate.threadId === state.threadId);
    const workerId: BoardWorkerId =
      link !== undefined
        ? boardThreadLinkWorkerId(link)
        : card === undefined
          ? BOARD_LOCAL_WORKER_ID
          : boardCardEffectiveWorkerId(card, board.defaultWorkerId);
    return { workerId, providerInstanceId: state.providerInstanceId };
  };

  /** The board with every project beside it — the one view a pass that reads
      both cards and project roots decides from. */
  const readModel = Effect.all([threads.projects(), boardEngine.getReadModel]).pipe(
    Effect.map(([projects, model]): BoardWorld => ({ projects, board: model.board })),
  );

  /** A thread the board can still act on — present and not deleted — or
      undefined. */
  const liveThread = (threadId: ThreadId) =>
    threads.threadState(threadId).pipe(
      Effect.flatMap((state) =>
        // T3o: a thread on a worker the board cannot reach is neither
        // gone nor alive, so no decision may be taken on it: surfaced as a
        // read failure until offline handling owns it.
        state === UNKNOWN_THREAD_STATE
          ? Effect.fail(
              new ThreadReadError({
                operation: "threadState",
                detail: `Thread ${threadId} is on a worker the board cannot reach.`,
              }),
            )
          : Effect.succeed(state === null || state.deleted ? undefined : state),
      ),
    );

  const dispatchAny = (command: BoardCommand) => boardEngine.dispatch(command);

  /** Log a failed command the caller treats as best-effort. */
  const logged = <E>(commandType: string, effect: Effect.Effect<unknown, E>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor dispatch failed", {
          commandType,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const dispatch = (command: BoardCommand) => logged(command.type, dispatchAny(command));

  /**
   * `dispatch`, but a refusal (`BoardCommandInvariantError` or `ThreadCommandRefusedError`) is
   * an expected answer logged quietly: these callers speculate and the refusal is their guard.
   * Other failures still warn. Returns whether the command landed, so a retrying caller can stop.
   */
  const optional = (
    commandType: string,
    effect: Effect.Effect<unknown, BoardDispatchError | ThreadCommandError>,
  ) =>
    effect.pipe(
      Effect.as(true),
      Effect.catchCause((cause) => {
        const refusal = Cause.findErrorOption(cause).pipe(
          Option.filter(
            (error) =>
              error._tag === "BoardCommandInvariantError" ||
              error._tag === "ThreadCommandRefusedError",
          ),
          Option.getOrUndefined,
        );
        return refusal === undefined
          ? Effect.logWarning("board supervisor dispatch failed", {
              commandType,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false))
          : Effect.logDebug("board supervisor dispatch refused", {
              commandType,
              detail: refusal.detail,
            }).pipe(Effect.as(false));
      }),
    );
  const dispatchOptional = (command: BoardCommand) => optional(command.type, dispatchAny(command));

  /**
   * `dispatch`, answering the decider's refusal sentence, or `null` when the command landed. For
   * writes whose refusal must reach the user, not the log. Only an invariant refusal comes back;
   * any other failure is a fault, logged like any dispatch, never shown as a rule refusing.
   */
  const dispatchRefusal = (command: BoardCommand) =>
    dispatchAny(command).pipe(
      Effect.as<string | null>(null),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const refusal = Cause.findErrorOption(cause).pipe(
          Option.filter((error) => error._tag === "BoardCommandInvariantError"),
          Option.getOrUndefined,
        );
        return refusal === undefined
          ? Effect.logWarning("board supervisor dispatch failed", {
              commandType: command.type,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as<string | null>(null))
          : Effect.succeed<string | null>(refusal.detail);
      }),
    );

  /** `dispatch`, but the caller learns whether the command LANDED. The plain
      helper above swallows a rejection, which is right for best-effort writes
      and wrong for the two commands a spawn is built from: a thread that was
      never created must not be recorded as the step's running thread. */
  const landed = <E>(commandType: string, effect: Effect.Effect<unknown, E>) =>
    effect.pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        // An interrupt-only cause is a teardown: the command's fate is unknown, and "did not land"
        // would make the caller compensate (delete a thread that may exist). Re-interrupt instead.
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("board supervisor dispatch failed", {
              commandType,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
      ),
    );
  const dispatchLanded = (command: BoardCommand) => landed(command.type, dispatchAny(command));

  const boardSettings = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.board ?? DEFAULT_BOARD_SETTINGS),
    Effect.catchCause(() => Effect.succeed(DEFAULT_BOARD_SETTINGS)),
  );

  /**
   * What a stage with no model of its own runs on: the board's default model when set, else the
   * app's text-generation selection. No compiled-in pair: it may name a provider not installed.
   */
  const fallbackModelSelection = serverSettings.getSettings.pipe(
    Effect.map((settings) =>
      resolveBoardDefaultModelSelection(settings.board ?? DEFAULT_BOARD_SETTINGS, {
        instanceId: settings.textGenerationModelSelection.instanceId,
        model: settings.textGenerationModelSelection.model,
      }),
    ),
    Effect.catchCause(() =>
      Effect.succeed({
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      }),
    ),
  );

  // Threads spawned for a step whose admit was then rejected. An interrupt fired right after
  // spawn races provider session startup and no-ops, so `session.started` for an orphan
  // re-dispatches it. Entries clear on interrupt or the orphan's turn end, keeping the set bounded.
  const orphanedThreads = new Set<string>();
  const interruptOrphan = Effect.fn("board-supervisor-interruptOrphan")(function* (
    threadId: ThreadId,
  ) {
    yield* logged(
      "thread.interrupt",
      threads.interrupt({ commandId: yield* commandId("interrupt-orphan"), threadId }),
    );
  });

  // Threads unlinked while still alive: the one release `boardReleasedThreadIds` cannot derive
  // from the card. Entries clear the first time a settle lands.
  const abandonedThreads = new Set<string>();
  /** Thread → the interview run auto-plan interrupted to steer. Only
      that run's question, Stop and end are ignored; the next turn end clears it. */
  const steeredThreads = new Map<string, string>();
  /** Thread → an auto-plan instruction held until its usage limit lifts. */
  const deferredSteers = new Map<string, string>();
  /** Thread → the run the board interrupted to recover a review step that
      asked a question. Its Stop and question are the board's own; the
      next turn end clears it. */
  const boardInterruptedRuns = new Set<string>();
  /** Card → the `stepId attempt` whose question the board already answered:
      a second question in the same attempt is recovered instead.
      Keyed by card so a later step or attempt replaces it. */
  const answeredReviewQuestions = new Map<string, string>();
  const answeredReviewQuestion = (state: BoardCardStepState) =>
    answeredReviewQuestions.get(state.cardId) === `${state.stepId} ${state.attempt}`;
  /** The live thread is still running the run auto-plan interrupted. */
  const stillOnSteeredRun = Effect.fn("board-supervisor-stillOnSteeredRun")(function* (
    threadId: ThreadId,
  ) {
    const runId = steeredThreads.get(String(threadId));
    if (runId === undefined) return false;
    const shell = yield* liveThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
    return shell?.activeTurnRef === runId;
  });

  /**
   * Settle every thread the board is finished with. The only place it settles: it re-derives
   * the released set each pass because an agent completes its step inside its own turn, when the
   * settle is refused. Pre-filters (one batch read, then `autoSettleCandidate`) keep a settle
   * nobody could accept from writing a rejected receipt every pass.
   */
  const releaseFinishedThreads = Effect.gen(function* () {
    const board = yield* readBoard;
    const released = [...boardReleasedThreadIds(board, abandonedThreads)];
    const records = released.length === 0 ? new Map() : yield* threads.threadRecords(released);
    for (const threadId of released) {
      steeredThreads.delete(String(threadId));
      deferredSteers.delete(String(threadId));
      const thread = records.get(threadId);
      // No record is no answer: the thread's worker couldn't be asked,
      // so an abandoned thread there is kept for the next pass.
      if (thread === undefined) continue;
      if (thread.deleted || thread.archived || thread.settlementDecided) {
        // Nothing left to ask about — and an abandoned thread that reaches this
        // is finished business, so stop carrying it.
        abandonedThreads.delete(String(threadId));
        continue;
      }
      const shell = yield* liveThread(threadId);
      // Busy is the common refusal, and it is why this is a sweep rather than a
      // single shot: the agent that just reported its step complete is still
      // mid-turn. An unanswered approval is the other one, and unlike busy it
      // can last for days — which is exactly the receipt-per-pass this avoids.
      if (shell === undefined || !shell.autoSettleCandidate) continue;
      const settled = yield* optional(
        "thread.settle",
        threads.settle({ commandId: yield* commandId("release-thread"), threadId, auto: true }),
      );
      if (settled) abandonedThreads.delete(String(threadId));
    }
  }).pipe(
    // Total, like the timeout sweep it rides with: a read-model hiccup must not
    // take down the handler that asked, and the next pass asks again anyway.
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: thread release failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const isAfter = (candidate: string, floor: string): boolean => {
    const a = Date.parse(candidate);
    const b = Date.parse(floor);
    return Number.isFinite(a) && Number.isFinite(b) && a > b;
  };

  /**
   * Latest commit time unique to the card's own branch (`--not <base>`), or null on any error.
   * Scoped so base syncs (a sibling's merge) never count as this agent's heartbeat. An unresolvable
   * base answers null rather than falling back to the tip, so it shields nothing.
   */
  const latestBranchCommitIso = (card: BoardCard, worktreePath: string, baseRefName: string) =>
    workspaceFor(card).pipe(
      Effect.flatMap((workspace) => workspace.branchHeartbeat({ worktreePath, baseRefName })),
      Effect.map((heartbeat) => heartbeat.committedAt),
      Effect.catchCause(() => Effect.succeed(null as string | null)),
    );

  /** The step thread's cached todo row, or null. Best-effort: a
      snapshot query built without the board factory (upstream test mocks) or a
      read failure both answer "no list", which reads as "no progress" — the
      conservative direction. */
  const threadTodoState = Effect.fn("board-supervisor-threadTodoState")(function* (
    threadId: ThreadId | null,
  ) {
    if (threadId === null) return null;
    return yield* boardQueries
      .boardThreadTodo(threadId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
  });

  /**
   * When the step thread last produced output, or null on a missing read model or failure.
   * Liveness, not progress: only the timeout sweep reads it, so a thrashing agent still climbs
   * the stall ladder.
   */
  const threadLastSignalAt = Effect.fn("board-supervisor-threadLastSignalAt")(function* (
    threadId: ThreadId | null,
  ) {
    if (threadId === null) return null;
    return yield* threads
      .lastSignalAt(threadId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
  });

  /**
   * Whether a turn was requested on the step's thread since `lastNudgeAt ?? startedAt` and has
   * not begun. Its completion is then one the human already moved past, and nothing would
   * re-resume a park on it. `session.activeTurnId` cannot see this window. A read failure
   * answers false.
   */
  const supersededByPendingTurn = Effect.fn("board-supervisor-supersededByPendingTurn")(function* (
    state: BoardCardStepState,
  ) {
    if (state.threadId === null) return false;
    const floor = state.lastNudgeAt ?? state.startedAt;
    if (floor === null) return false;
    const requestedAt = yield* threads
      .pendingTurnStartAt(state.threadId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    return requestedAt !== null && isAfter(requestedAt, floor);
  });

  /**
   * The step thread's todo list advanced, or a commit landed on the card's branch, since
   * `lastNudgeAt`. The first stall has no nudge window, so never counts. Kept out of the pure
   * `recoveryDecision`.
   */
  const resolveProgressedSinceLastNudge = Effect.fn(
    "board-supervisor-resolveProgressedSinceLastNudge",
  )(function* (state: BoardCardStepState, card: BoardCard) {
    if (state.lastNudgeAt === null) return false;
    return yield* progressedSince(state, card, state.lastNudgeAt);
  });

  /** The progress signal itself, measured from any instant: the step thread's
      todo list advanced, or a commit unique to the card's branch landed, after
      `since`. */
  const progressedSince = Effect.fn("board-supervisor-progressedSince")(function* (
    state: BoardCardStepState,
    card: BoardCard,
    since: string,
  ) {
    const todo = yield* threadTodoState(state.threadId);
    if (todo?.advancedAt != null && isAfter(todo.advancedAt, since)) return true;
    return yield* committedSince(state, card, since);
  });

  /**
   * A commit unique to the card's branch landed after `since`. Background-wait check-ins read
   * only this half: answering one is itself a todo edit, which would restart the schedule forever.
   */
  const committedSince = Effect.fn("board-supervisor-committedSince")(function* (
    state: BoardCardStepState,
    card: BoardCard,
    since: string,
  ) {
    // A commit counts too; only a build-mode step has a worktree to
    // inspect, and only a commit unique to the card's branch is its agent's
    // work — otherwise a sibling's merge, synced in from the base,
    // would reset this card's stall counter.
    const worktreePath = card.worktree?.path ?? null;
    const baseRefName = card.worktree?.baseRefName ?? null;
    if (state.mode !== "build" || worktreePath === null || baseRefName === null) return false;
    const committedAt = yield* latestBranchCommitIso(card, worktreePath, baseRefName);
    return committedAt !== null && isAfter(committedAt, since);
  });

  /**
   * Whether the agent stopped with a question for a human. Only an assistant message since
   * `lastNudgeAt ?? startedAt` counts, so a silent turn never re-parks on an answered question.
   * A read failure, or no message, answers false.
   */
  const endedWithQuestion = Effect.fn("board-supervisor-endedWithQuestion")(function* (
    state: Pick<BoardCardStepState, "threadId" | "lastNudgeAt" | "startedAt">,
  ) {
    const threadId = state.threadId;
    if (threadId === null) return false;
    const message = yield* threads
      .latestAssistantMessage(threadId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (message === null) return false;
    const since = state.lastNudgeAt ?? state.startedAt;
    if (since !== null && !isAfter(message.createdAt, since)) return false;
    return boardTextEndsWithQuestion(message.text);
  });

  /** The card + step the reactor is watching for a given thread, or null. */
  const stepThreadCard = (
    board: BoardState,
    threadId: ThreadId,
  ): { readonly card: BoardCard; readonly state: BoardCardStepState } | null => {
    const state = (board.stepStates ?? []).find((entry) => entry.threadId === threadId);
    if (state === undefined) return null;
    const card = board.cards.find((candidate) => candidate.id === state.cardId);
    return card === undefined ? null : { card, state };
  };

  const projectCwd = (board: BoardWorld, card: BoardCard): string | null => {
    const project = board.projects.find((entry) => entry.id === card.projectId);
    return project?.workspaceRoot ?? null;
  };

  /** A card's Automation toggles off the board alone. Board-wide
      auto-merge lives in settings; a caller that needs Auto-merge reads
      `automationOf`. */
  const automationIn = (board: BoardState, card: BoardCard): BoardResolvedAutomation =>
    resolveBoardCardAutomationIn({ board, card, boardWideAutoMerge: false });

  /**
   * The build stage's per-card human-in-the-loop default; a sub-board child counts as planned.
   * Shared with the card detail so the toggle's hint and the run agree.
   */
  const buildHumanInLoopDefault = (
    board: BoardState,
    exec: BoardStageExecution,
    card: BoardCard,
  ): boolean => boardBuildHumanInLoopDefault(exec, isBoardCardPlanned(board, card.id));

  /**
   * The human-in-the-loop stance for a stage's first-entry run: the build role reads the
   * per-card toggle, other stages their own setting. Re-entry is the caller's to force.
   */
  const resolveHumanInLoop = (
    board: BoardState,
    settings: BoardSettings,
    card: BoardCard,
    exec: BoardStageExecution,
  ): boolean => {
    const stage = boardStageById(board, card.stage);
    const role = stage === null ? null : effectiveBoardStageRole(stage);
    // The Automation toggles are the human's authorisation: Auto-build
    // runs the build unattended over the card's own stance, and an
    // auto-planned card is planned unattended — nobody is there to answer.
    if (role === "build") {
      if (automationIn(board, card).autoBuild.value) return false;
      return card.humanInLoop ?? buildHumanInLoopDefault(board, exec, card);
    }
    if (
      role === "plan" &&
      (isBoardCardAutoPlanPending(card) || automationIn(board, card).autoPlan.value)
    ) {
      return false;
    }
    return exec.humanInLoop;
  };

  /** Whether the card already has a live (non-tombstoned) linked thread for a
      stage's step: auto-kickoff is suppressed so a manually adopted thread
      is never trampled. The step's role is the stage id. */
  const hasLiveStageThread = (card: BoardCard, stageId: string): boolean =>
    card.threadLinks.some((link) => link.role === stageId && isLiveBoardCardThreadLink(link));

  // Send a follow-up turn (recovery nudge or escalation question) to an
  // existing step thread.
  const sendTurn = Effect.fn("board-supervisor-sendTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    /**
     * Inert for existing threads today; passing the step's real value keeps the "board never
     * forces full-access" invariant true at every dispatch.
     */
    readonly runtimeMode: BoardCardStepState["runtimeMode"];
  }) {
    yield* logged(
      "thread.send",
      threads.send({
        commandId: yield* commandId("recover-turn"),
        threadId: input.threadId,
        text: input.text,
        attachments: [],
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
      }),
    );
  });

  /**
   * Report a worktree failure onto the card with an actionable reason, including pre-flight
   * arms that fail before a worktree record exists, so it is visible in the activity rail.
   */
  const failWorktree = Effect.fn("board-supervisor-failWorktree")(function* (
    card: BoardCard,
    error: string,
  ) {
    yield* dispatch({
      type: "board.card.fail-worktree",
      commandId: yield* commandId("fail-worktree"),
      cardId: card.id,
      error,
      createdAt: yield* nowIso,
    });
  });

  // `defaultBranch === ""` is the failure signal; `detachedHead` and `unbornBranch`
  // disambiguate the message. `unavailable` is an unreachable worker, so nothing is reported.
  const resolveDefaultBranch = (workspace: BoardCardWorkspace) =>
    workspace.resolveDefaultBranch({}).pipe(
      Effect.map((resolved) => ({ ...resolved, unavailable: false })),
      Effect.catch((error) =>
        Effect.succeed({
          defaultBranch: "",
          detachedHead: false,
          unbornBranch: "",
          checkoutPath: workspace.checkoutPath ?? "",
          unavailable: error._tag === "WorkerUnavailable",
        }),
      ),
      Effect.catchCause(() =>
        Effect.succeed({
          defaultBranch: "",
          detachedHead: false,
          unbornBranch: "",
          checkoutPath: workspace.checkoutPath ?? "",
          unavailable: false,
        }),
      ),
    );

  // Why `resolveDefaultBranch` found nothing, in words that name the fix.
  // Shared by card and integration-branch provisioning so both say the same.
  const noDefaultBranchReason = (
    cwd: string,
    resolved: { readonly detachedHead: boolean; readonly unbornBranch: string },
    what: string,
  ) =>
    resolved.detachedHead
      ? `The project checkout at ${cwd} is on a detached HEAD, so there is no branch to cut ${what} from.`
      : resolved.unbornBranch !== ""
        ? `${cwd} has no commits yet, so there is no branch to cut ${what} from. Make a first commit on '${resolved.unbornBranch}'.`
        : `${cwd} is not a git repository, or has no commits yet, so there is no branch to cut ${what} from.`;

  /**
   * Make sure `base` names a local branch, creating it from `<remote>/<base>` when only the
   * remote has it. Answers whether the caller may cut from it, or `unavailable`.
   */
  const ensureLocalBaseBranch = (workspace: BoardCardWorkspace, base: string) =>
    workspace.ensureLocalBaseBranch({ base }).pipe(
      Effect.map((result): boolean | "unavailable" => result.exists),
      Effect.catch((error) =>
        Effect.succeed<boolean | "unavailable">(
          error._tag === "WorkerUnavailable" ? "unavailable" : false,
        ),
      ),
      Effect.catchCause(() => Effect.succeed<boolean | "unavailable">(false)),
    );

  // Answers the worktree path, or why there is none. `stuck` failures are deterministic, so the
  // caller parks the step; transient ones leave it pending for the next pass to retry.
  const ensureWorktree = Effect.fn("board-supervisor-ensureWorktree")(function* (card: BoardCard) {
    if (card.worktree !== null && card.worktree.status === "ready" && card.worktree.path !== null) {
      return { kind: "ready", path: card.worktree.path } as WorktreeOutcome;
    }
    const stuck = (reason: string) =>
      failWorktree(card, reason).pipe(Effect.as<WorktreeOutcome>({ kind: "stuck", reason }));
    // A worker the board cannot reach is no fault of the repository.
    // Nothing is reported, no attempt is spent, and the next pass retries.
    const unreachable = { kind: "transient" } as WorktreeOutcome;
    const workspace = yield* workspaceFor(card);
    const cwd = workspace.checkoutPath;
    // Pre-flight failures report onto the card, not the server log: the card is where the human
    // is looking.
    if (cwd === null) {
      return yield* stuck(noWorkspaceFolderReason(workspace));
    }
    // A provision the worker dropped mid-way resumes on the slice it
    // already recorded: `provision-worktree` would be refused for a worktree
    // still `provisioning`, and re-dispatching it would count an attempt.
    const resuming =
      card.worktree !== null &&
      card.worktree.status === "provisioning" &&
      interruptedProvisions.has(String(card.id));
    if (resuming && card.worktree !== null) {
      return yield* provisionOnWorkspace(card, workspace, {
        branch: card.worktree.branch,
        baseRefName: card.worktree.baseRefName,
      });
    }
    const branch = boardCardWorktreeBranchName(card);
    // A sub-board plan card branches off its parent's integration branch;
    // a top-level card off the project default.
    const resolved = yield* resolveDefaultBranch(workspace);
    if (resolved.unavailable) return unreachable;
    const { defaultBranch } = resolved;
    // A live split's child retries the integration-branch creation before resolving its base:
    // approval fires it once and may have failed. Triggered by the parent's state, not a null base
    // (a second-round parent resolves to its old base). `parentFailure` is quoted in the child's
    // "no base" reason, since the fix is in the parent's repo state.
    let parentFailure: {
      readonly key: string;
      readonly reason: string;
      readonly transient: boolean;
    } | null = null;
    if (card.parentCardId !== null) {
      const board = yield* readBoard;
      // The group whose integration branch this card is cut from:
      // the nearest own-target ancestor; inherit groups pass through.
      const parent = boardCardIntegrationAncestor(board, card) ?? undefined;
      const buildStage = boardStageWithRole(board, "build");
      const branchLive =
        parent?.worktree != null &&
        parent.worktree.status !== "failed" &&
        parent.worktree.status !== "reclaimed";
      if (
        parent !== undefined &&
        parent.archivedAt === null &&
        buildStage !== null &&
        parent.stage === buildStage.stageId &&
        !branchLive
      ) {
        const failure = yield* ensureIntegrationBranch(parent);
        // The parent's worker is out of reach: retried next pass, unreported.
        if (failure?.unavailable === true) return unreachable;
        if (failure !== null) parentFailure = { key: parent.key, ...failure };
      }
    }
    const baseRefName = resolveBoardCardBaseRef({
      card,
      cards: (yield* readBoard).cards,
      defaultBranch,
    });
    if (baseRefName === null && defaultBranch !== "" && parentFailure?.transient === true) {
      // git itself failed cutting the parent's branch: the next build attempt
      // is the retry, exactly as for this card's own `git worktree add`.
      yield* failWorktree(
        card,
        `The parent card ${parentFailure.key} has no integration branch yet. ${parentFailure.reason}`,
      );
      return { kind: "transient", reason: parentFailure.reason } as WorktreeOutcome;
    }
    if (baseRefName === null || defaultBranch === "") {
      // Say WHICH of the four ways base-ref resolution failed — "could not
      // resolve the base branch" is true but unactionable, and the four have
      // different fixes (commit the parent's work, check out a branch, make a
      // first commit in an empty repository, run `git init`).
      return yield* stuck(
        baseRefName !== null
          ? noDefaultBranchReason(cwd, resolved, "the card's branch")
          : parentFailure !== null
            ? `The parent card ${parentFailure.key} has no integration branch, so there is no base to cut this card's branch from. ${parentFailure.reason}`
            : "The parent card has no branch yet, so there is no base to cut this card's branch from.",
      );
    }
    // The base must exist locally: `measureBaseTip`, `pullMergedBaseBranch` and the rebase all
    // use it as a local name and break silently on a remote-qualified one.
    const baseExists = yield* ensureLocalBaseBranch(workspace, baseRefName);
    if (baseExists === "unavailable") return unreachable;
    if (!baseExists) {
      // Never fall back to the default. A card pinned to `release/2.4` that
      // silently builds off `main` is worse than a card that does not build,
      // and this path is card-visible and retryable.
      return yield* stuck(
        `The card's base branch '${baseRefName}' does not exist in ${cwd}, locally or on a remote, so there is nothing to cut the card's branch from.`,
      );
    }
    // Observe the provision dispatch: a rejected command (e.g. the worktree is
    // not in a provisionable state) must abort BEFORE the git effect, or the
    // tree lands on disk untracked while `record-worktree` is then rejected too.
    const provisionAccepted = yield* boardEngine
      .dispatch({
        type: "board.card.provision-worktree",
        commandId: yield* commandId("provision-worktree"),
        cardId: card.id,
        branch,
        baseRefName,
        createdAt: yield* nowIso,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: provision-worktree rejected; skipping git work", {
            cardId: card.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
    if (!provisionAccepted) return { kind: "transient" } as WorktreeOutcome;
    return yield* provisionOnWorkspace(card, workspace, { branch, baseRefName });
  });

  /** Why a card's checkout cannot be found, naming where it was looked for. */
  const noWorkspaceFolderReason = (workspace: BoardCardWorkspace) =>
    workspace.workerId === BOARD_LOCAL_WORKER_ID
      ? "The card's project has no workspace folder on this server."
      : "The card's project has no checkout on its worker.";

  /**
   * Cards whose provision the worker dropped mid-way: their worktree
   * is recorded `provisioning`, and the next pass finishes the provision on
   * that slice instead of starting another. In memory — after a restart the
   * boot reconcile sees the slice as it always did.
   */
  const interruptedProvisions = new Set<string>();

  /** Drop the entries whose card is gone or no longer provisioning — deleted,
      archived, failed or reset since — so the set holds only live resumes. */
  const forgetSettledProvisions = (board: BoardState) => {
    const provisioning = new Set(
      board.cards
        .filter((card) => card.worktree?.status === "provisioning")
        .map((card) => String(card.id)),
    );
    for (const id of interruptedProvisions) {
      if (!provisioning.has(id)) interruptedProvisions.delete(id);
    }
  };

  /** The git half of a provision, once `provision-worktree` is recorded:
      create the worktree in the card's workspace, then `record-worktree`. */
  const provisionOnWorkspace = Effect.fn("board-supervisor-provisionOnWorkspace")(function* (
    card: BoardCard,
    workspace: BoardCardWorkspace,
    slice: { readonly branch: string; readonly baseRefName: string },
  ) {
    type Provisioned =
      | { readonly kind: "ok"; readonly path: string }
      | { readonly kind: "unavailable" }
      | { readonly kind: "failed" };
    const provisioned = yield* workspace.provisionWorktree(slice).pipe(
      Effect.map((worktree): Provisioned => ({ kind: "ok", path: worktree.path })),
      Effect.catch((error): Effect.Effect<Provisioned> =>
        error._tag === "WorkerUnavailable"
          ? Effect.succeed({ kind: "unavailable" } as const)
          : Effect.logWarning("board supervisor: worktree provisioning failed", {
              cardId: card.id,
              detail: error.detail,
            }).pipe(Effect.as({ kind: "failed" } as const)),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor: worktree provisioning failed", {
          cardId: card.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({ kind: "failed" } as const)),
      ),
    );
    if (provisioned.kind === "unavailable") {
      interruptedProvisions.add(String(card.id));
      return { kind: "transient" } as WorktreeOutcome;
    }
    interruptedProvisions.delete(String(card.id));
    if (provisioned.kind === "failed") {
      yield* failWorktree(card, "git worktree add failed; retry the build.");
      return { kind: "transient", reason: "git worktree add failed." } as WorktreeOutcome;
    }
    yield* dispatch({
      type: "board.card.record-worktree",
      commandId: yield* commandId("record-worktree"),
      cardId: card.id,
      path: provisioned.path,
      createdAt: yield* nowIso,
    });
    return { kind: "ready", path: provisioned.path } as WorktreeOutcome;
  });

  // A failure only a human can fix parks the step `stalled` (`no-worktree`) so the card shows
  // it, spending no recovery budget. Git failures retry on later passes up to a limit; the
  // in-memory count clears on success or park, so Continue starts fresh.
  const transientProvisionFailures = new Map<string, number>();
  const provisionBuildStep = Effect.fn("board-supervisor-provisionBuildStep")(function* (
    card: BoardCard,
  ) {
    let outcome = yield* ensureWorktree(card);
    if (outcome.kind === "transient" && outcome.reason !== undefined) {
      const failures = (transientProvisionFailures.get(card.id) ?? 0) + 1;
      transientProvisionFailures.set(card.id, failures);
      if (failures >= TRANSIENT_PROVISION_FAILURE_LIMIT) {
        outcome = {
          kind: "stuck",
          reason: `Preparing the card's branch failed ${failures} times in a row: ${outcome.reason} Check the repository, then press Continue.`,
        };
      }
    }
    if (outcome.kind !== "transient") transientProvisionFailures.delete(card.id);
    if (outcome.kind === "ready") return outcome.path;
    if (outcome.kind === "stuck") {
      const state = boardCardStepState(yield* readBoard, card.id);
      if (
        state !== null &&
        state.mode === "build" &&
        (state.status === "pending" || state.status === "queued")
      ) {
        yield* Effect.logWarning("board supervisor: build step cannot start", {
          cardId: card.id,
          stepId: state.stepId,
          reason: outcome.reason,
        });
        yield* dispatch({
          type: "board.card.recover-step",
          commandId: yield* commandId("recover-step"),
          cardId: card.id,
          stepId: state.stepId,
          threadId: state.threadId,
          escalateToHuman: true,
          progressed: false,
          lastError: outcome.reason,
          stalledReason: "no-worktree",
          chargeBudget: false,
          createdAt: yield* nowIso,
        });
      }
    }
    return null;
  });

  // Spawn and link a fresh thread for a step (initial spawn, or recovery of a vanished
  // thread); the link is how the agent's board_* tools resolve their card. Build and plan-mode
  // spawns stage the brief's images as pending uploads; with no config nothing is staged.
  const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  // The reactor's shape promises `never` requirements, so the file services
  // its storage helpers need are captured here and provided at the call.
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const withFileServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );
  const stageSpawnAttachments = (card: BoardCard) =>
    Option.match(serverConfig, {
      onNone: () => Effect.succeed([] as ReadonlyArray<ChatAttachment>),
      onSome: (config) =>
        card.attachments.length === 0 || !spawnPushesBriefImages(boardSeedStageRole(card.stage))
          ? Effect.succeed([] as ReadonlyArray<ChatAttachment>)
          : withFileServices(
              stageBoardCardImagesAsPending({
                stateDir: config.stateDir,
                attachmentsDir: config.attachmentsDir,
                card,
              }),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("board supervisor: staging brief images for spawn failed", {
                  cardId: card.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as([] as ReadonlyArray<ChatAttachment>)),
              ),
            ),
    });

  // The board's workers as placement sees them — absent on a
  // local-only harness, where every card runs here.
  const placement = yield* Effect.serviceOption(BoardPlacement);
  const workersNow = Option.match(placement, {
    onNone: () => Effect.succeed(EMPTY_BOARD_WORKERS_STATE),
    onSome: (service) => service.workers,
  });
  /** The board project's repository key, which names its checkout on a worker. */
  const projectRepositoryKey = (projectId: ProjectId) =>
    threads.project(projectId).pipe(
      Effect.map((project) => boardRepositoryGroupingKey(project?.repositoryIdentity)),
      Effect.catchCause(() => Effect.succeed(null)),
    );
  /** Where a card's next thread runs, and whether the step can start there now. */
  const placementFor = Effect.fn("board-supervisor-placementFor")(function* (
    board: BoardState,
    card: BoardCard,
    state: Pick<BoardCardStepState, "providerInstanceId">,
  ) {
    const workerId = boardCardEffectiveWorkerId(card, board.defaultWorkerId);
    if (workerId === BOARD_LOCAL_WORKER_ID) {
      return { workerId, gate: { kind: "ready", workerProjectId: null } } as const;
    }
    return {
      workerId,
      gate: boardPlacementGate({
        workerId,
        workers: yield* workersNow,
        projectRepositoryKey: yield* projectRepositoryKey(card.projectId),
        providerInstanceId: state.providerInstanceId,
      }),
    } as const;
  });
  // A worker the board can't reach is unknown, not dead: nothing it ran is decided on until it
  // is back and reconciled. In memory, so a restart starts every worker unreconciled.
  /** Workers online and reconciled since they last came back. */
  const reconciledWorkers = new Set<BoardWorkerId>();
  /** When each registered worker the board can't reach went out of reach. */
  const unreachableSince = new Map<BoardWorkerId, number>();
  /** Each worker's finished out-of-reach stretches, which the timeout sweep
      does not count against a step (`boardOfflineCreditMs`). */
  const offlineIntervals = new Map<BoardWorkerId, Array<BoardOfflineInterval>>();
  /** Workers the change feed saw out of reach since `syncWorkerReach` last
      ran, and when it first did. Recorded as each summary arrives, not when
      the serial queue reaches it, so a worker that drops and comes back before
      then is still reconciled, and its time away still credited. */
  const droppedWorkers = new Map<BoardWorkerId, number>();
  /** Signals from a worker not yet reconciled, released after it is. */
  const heldSignals = new Map<BoardWorkerId, Array<ThreadSignal>>();
  /** Threads a reconcile of each worker settled, recovered or parked, kept
      across a pass that failed partway until the held signals are released:
      the retry reads those steps as already handled, so only this remembers
      that their held signals predate what was decided. */
  const decidedThreads = new Map<BoardWorkerId, Set<string>>();
  /** A held-signal backlog's ceiling. Reconcile reads the truth anyway, so a
      dropped signal costs nothing it would not re-learn. */
  const HELD_SIGNALS_MAX = 1000;
  /** Whether a worker's steps are paused: not this server, and not online and
      reconciled. Read off the live summary, so a worker that dropped a moment
      ago pauses before its status change has been processed. */
  const workerReconciled = (workerId: BoardWorkerId) =>
    reconciledWorkers.has(workerId) && !droppedWorkers.has(workerId);
  const workerPausedNow = Effect.gen(function* () {
    if (Option.isNone(placement)) return (_workerId: BoardWorkerId) => false;
    const online = new Set(
      (yield* workersNow).workers
        .filter((worker) => worker.status.state === "online")
        .map((worker) => worker.id),
    );
    return (workerId: BoardWorkerId) =>
      workerId !== BOARD_LOCAL_WORKER_ID && !(online.has(workerId) && workerReconciled(workerId));
  });

  // The brief's files a thread on a worker reads from where they were
  // staged there.
  const stagedBriefFiles = (card: BoardCard) => ({
    cardId: String(card.id),
    files: Option.match(serverConfig, {
      onNone: () => [],
      onSome: (config) =>
        card.attachments.flatMap((attachment) => {
          const filePath = resolveBoardCardAttachmentPath({
            path: pathService,
            stateDir: config.stateDir,
            cardId: card.id,
            name: attachment.name,
          });
          return filePath === null ? [] : [{ name: attachment.name, path: filePath }];
        }),
    }),
  });

  const spawnStepThread = Effect.fn("board-supervisor-spawnStepThread")(function* (input: {
    readonly card: BoardCard;
    /** The frozen run-row fields a spawn needs. */
    readonly step: {
      readonly stepId: string;
      /** Null on a stage with no steps; the title falls back to
          the frozen stage label. */
      readonly stepLabel: string | null;
      readonly stageLabel: string | null;
      readonly providerInstanceId: BoardCardStepState["providerInstanceId"];
      readonly model: string;
      /** Frozen run-row mode: governs resources (worktree + slot). */
      readonly mode: BoardCardStepState["mode"];
      /** Frozen run-row agent authority: the user-chosen posture, read
          verbatim — the board never derives it from `mode`. */
      readonly runtimeMode: BoardCardStepState["runtimeMode"];
      /** Frozen run-row model options (reasoning/effort). */
      readonly modelOptions: BoardCardStepState["modelOptions"];
    };
    /** Where the thread runs: the card's worktree for a `build`-mode step, the
        project workspace root for a `plan`-mode step (no worktree). */
    readonly worktreePath: string;
    /** The branch to open the thread on — the worktree's branch for `build`,
        null for `plan` (read-only, no branch). */
    readonly branch: string | null;
    /** Whether to run the worktree setup script — build only. */
    readonly runSetup: boolean;
    readonly text: string;
    /** The brief's images on a build/plan spawn (K4); `[]` elsewhere. */
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    const { card, step } = input;
    const threadId = yield* freshThreadId;
    // The user's agent authority, frozen onto the run row at stage entry; the board never forces
    // `full-access`. An approval-gated command surfaces as "Input needed".
    const runtimeMode = step.runtimeMode;
    // The worker the thread runs on — where the card holds its
    // worktree, else its pin, else the default — recorded as the card's
    // placement before anything spawns there.
    const board = yield* readBoard;
    const fresh = board.cards.find((candidate) => candidate.id === card.id) ?? card;
    const workerId = boardCardEffectiveWorkerId(fresh, board.defaultWorkerId);
    if (fresh.placedWorkerId !== workerId) {
      yield* dispatch({
        type: "board.card.place",
        commandId: yield* commandId("place"),
        cardId: card.id,
        workerId,
        createdAt: yield* nowIso,
      });
    }
    const remoteWorker = workerId === BOARD_LOCAL_WORKER_ID ? null : workerId;
    // An API-only text generator can't run an agent. Only this server's settings are known here,
    // so a worker's own instances are left to the worker.
    if (remoteWorker === null) {
      const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (
        settings !== null &&
        textGeneratorForSelection(settings, step.providerInstanceId) !== undefined
      ) {
        return "no-agent-model" as const;
      }
    }
    // T3o: pin the agent's gh to origin on every build-mode spawn,
    // not only at provisioning, so a worktree that predates the pin gets it
    // before its next agent runs. Idempotent and never fails the spawn.
    if (input.branch !== null) {
      yield* workspaceFor(card).pipe(
        Effect.flatMap((workspace) => workspace.pinGhDefault({ worktreePath: input.worktreePath })),
        Effect.ignoreCause,
      );
    }
    // A refused spawn leaves no thread. An unreachable worker was sent nothing, so the step waits.
    // A mid-call drop may have created the thread: it is linked and run as spawned, so the worker's
    // reconcile watches or recovers it, never a second agent in the worktree.
    const spawned = yield* threads
      .spawn({
        commandId: yield* commandId("spawn-thread"),
        threadId,
        projectId: card.projectId,
        title: `${card.key} · ${boardRunLabel(step) ?? card.stage}`,
        modelSelection: {
          instanceId: step.providerInstanceId,
          model: step.model,
          ...(step.modelOptions === undefined ? {} : { options: step.modelOptions }),
        },
        runtimeMode,
        interactionMode: "default",
        branch: input.branch,
        worktreePath: input.worktreePath,
        text: input.text,
        attachments: input.attachments,
        ...(remoteWorker === null
          ? {}
          : { workerId: remoteWorker, stageAttachments: stagedBriefFiles(card) }),
      })
      .pipe(
        Effect.as("spawned" as const),
        Effect.catchCause((cause) =>
          // An interrupt-only cause is a teardown, as in `landed`.
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("board supervisor dispatch failed", {
                commandType: "thread.spawn",
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(spawnFailureLeft(cause))),
        ),
      );
    if (spawned === "none") return null;
    if (spawned === "worker-offline") return "worker-offline" as const;
    yield* dispatch({
      type: "board.card.link-thread",
      commandId: yield* commandId("link-thread"),
      cardId: card.id,
      threadId,
      role: step.stepId,
      ...(remoteWorker === null ? {} : { workerId: remoteWorker }),
      createdAt: yield* nowIso,
    });
    // Run the worktree setup script in the build thread's terminal.
    // Build-mode only — a plan-mode step has no worktree. Best-effort.
    if (input.runSetup && remoteWorker === null) {
      yield* runBoardCardWorktreeSetup({
        threadId,
        projectId: card.projectId,
        worktreePath: input.worktreePath,
      }).pipe(
        Effect.provideService(BoardSetupScriptRunner, setupRunner),
        Effect.catchCause(() => Effect.void),
      );
    }
    return threadId;
  });

  /**
   * A spawn that produced no thread lands the step `stalled`, not `running`: a phantom running
   * step would block every later kickoff, while a stalled one shows and can be restarted.
   */
  const escalateSpawnFailure = Effect.fn("board-supervisor-escalateSpawnFailure")(
    function* (input: {
      readonly card: BoardCard;
      readonly state: BoardCardStepState;
      readonly lastError?: string;
    }) {
      yield* Effect.logWarning("board supervisor: could not spawn a thread for the step", {
        cardId: input.card.id,
        stepId: input.state.stepId,
      });
      // Same reason as the recovery escalation: a spawn failure parks the step
      // for a human without settling it, so disarm here too.
      disarmPendingMerge(input.card.id);
      yield* dispatch({
        type: "board.card.recover-step",
        commandId: yield* commandId("spawn-failed"),
        cardId: input.card.id,
        stepId: input.state.stepId,
        threadId: null,
        escalateToHuman: true,
        progressed: false,
        ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        createdAt: yield* nowIso,
      });
      // Escalation releases the step's slot exactly as the recovery escalation
      // does, gated on the PERSISTED `slotHeld`: a step that reached this
      // through recovery holds one, a step that never got admitted does not
      // (its caller releases the slot it had just acquired itself).
      yield* releaseSlot(input.state);
    },
  );

  // Whether a step's thread is gone (deleted or never present) — recovery must
  // respawn rather than nudge a thread that no longer exists.
  const threadGone = (threadId: ThreadId | null) =>
    threadId === null
      ? Effect.succeed(true)
      : liveThread(threadId).pipe(Effect.map((state) => state === undefined));

  /**
   * The prompt for a step's run, composed from the frozen run row. The base branch prefers
   * `worktree.baseRefName` (what the branch was really cut from), then the pin, then the default.
   */
  const stepPromptFor = Effect.fn("board-supervisor-stepPromptFor")(function* (
    card: BoardCard,
    state: BoardCardStepState,
  ) {
    const role = boardSeedStageRole(card.stage);
    // A started plan review rides every respawn and nudge, so a
    // recovered planning thread resumes it rather than completing without it.
    const planReview =
      role === "plan" && state.planReviewStartedAt !== undefined
        ? yield* runningPlanReviewFor(card, state)
        : null;
    return composeStepPrompt({
      ...(role === "build" ? { draftPullRequests: yield* draftPullRequestsOn(card) } : {}),
      card: { ...card, baseBranch: yield* resolvePromptBaseBranch(card) },
      stageLabel: state.stageLabel,
      step: {
        stepId: state.stepId,
        stepLabel: state.stepLabel,
        prompt: state.prompt,
        humanInLoop: state.humanInLoop,
        ...(role === "plan" && isBoardCardAutoPlanPending(card)
          ? {
              autoPlan: true,
              ...(automationIn(yield* readBoard, card).autoBuild.value ? { autoBuild: true } : {}),
            }
          : {}),
        ...(planReview === null ? {} : { planReview }),
      },
      role,
    });
  });

  /** The instructions of the plan review running on this step, or null when
      none is (plan review). */
  const runningPlanReviewFor = Effect.fn("board-supervisor-runningPlanReviewFor")(function* (
    card: BoardCard,
    state: BoardCardStepState,
  ) {
    const board = yield* readBoard;
    const settings = yield* boardSettings;
    if (runningPlanReviewStep({ board, card, settings }) === null) return null;
    return planReviewInstructions({ board, card, settings, state });
  });

  /** A human turned a running plan review off (plan review): tell the
      planning thread to wrap up. A paused step is not told, for the reason
      the human-in-the-loop retune gives: the turn would un-pause it. */
  const handlePlanReviewStopped = Effect.fn("board-supervisor-handlePlanReviewStopped")(function* (
    event: Extract<BoardEvent, { type: "board.plan-review-stopped" }>,
  ) {
    const state = boardCardStepState(yield* readBoard, event.payload.cardId);
    if (
      state === null ||
      state.stepId !== event.payload.stepId ||
      state.threadId === null ||
      state.status === "paused" ||
      isBoardTerminalStepStatus(state.status)
    ) {
      return;
    }
    yield* sendTurn({
      threadId: state.threadId,
      text: BOARD_PLAN_REVIEW_STOP_INSTRUCTION,
      runtimeMode: state.runtimeMode,
    });
  });

  /** A human turned plan review on after the plan was posted:
      no tool result will carry the instructions, so send them as a
      turn. The decider has already resumed a paused step or reopened a
      finished one, so the state it reads here is running. */
  const handlePlanReviewStartedLate = Effect.fn("board-supervisor-handlePlanReviewStartedLate")(
    function* (event: Extract<BoardEvent, { type: "board.plan-review-started" }>) {
      if (event.payload.turnedOnLate !== true) return;
      // Putting the step to work overtakes a schedule, as the
      // `board.card-step-recovered` arm does for every other resume.
      yield* clearScheduleForCard(event.payload.cardId);
      const board = yield* readBoard;
      const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
      const state = boardCardStepState(board, event.payload.cardId);
      if (
        card === undefined ||
        state === null ||
        state.stepId !== event.payload.state.stepId ||
        state.threadId === null ||
        state.status === "paused" ||
        isBoardTerminalStepStatus(state.status)
      ) {
        return;
      }
      const review = yield* runningPlanReviewFor(card, state);
      if (review === null) return;
      yield* sendTurn({
        threadId: state.threadId,
        text: `${BOARD_PLAN_REVIEW_LATE_START_LEAD}\n\n${review.instructions}`,
        runtimeMode: state.runtimeMode,
      });
    },
  );

  /** A human changed a running plan review's rounds: tell the
      planning thread the new total. A paused step is not told, as with a
      stop; it reads the new count when it resumes. */
  const handlePlanReviewRoundsChanged = Effect.fn("board-supervisor-handlePlanReviewRoundsChanged")(
    function* (event: Extract<BoardEvent, { type: "board.plan-review-rounds-changed" }>) {
      const board = yield* readBoard;
      const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
      const state = boardCardStepState(board, event.payload.cardId);
      if (
        card === undefined ||
        state === null ||
        state.stepId !== event.payload.state.stepId ||
        state.threadId === null ||
        state.status === "paused" ||
        isBoardTerminalStepStatus(state.status)
      ) {
        return;
      }
      const review = yield* runningPlanReviewFor(card, state);
      if (review === null) return;
      yield* sendTurn({
        threadId: state.threadId,
        text: `${boardPlanReviewRoundsChangedLead(review.rounds)}\n\n${review.instructions}`,
        runtimeMode: state.runtimeMode,
      });
    },
  );

  /** Whether the Code review stage's open-as-draft setting is on. */
  const draftPullRequestsOn = Effect.fnUntraced(function* (card: BoardCard) {
    const board = yield* readBoard;
    const reviewStage = boardStageWithRole(board, "review");
    if (reviewStage === null) return false;
    const review = resolveBoardStageExecution(
      yield* boardSettings,
      reviewStage.stageId,
      boardProjectStageConfig(board, card.projectId),
    );
    return isBoardReviewStageExecution(review) && review.draftPullRequests;
  });

  /** The base branch the envelope states, or null when it cannot be resolved —
      in which case the envelope says nothing rather than putting placeholder
      English where a branch name belongs. */
  const resolvePromptBaseBranch = Effect.fn("board-supervisor-resolvePromptBaseBranch")(function* (
    card: BoardCard,
  ) {
    const recorded = card.worktree?.baseRefName ?? null;
    if (recorded !== null) return recorded;
    if (card.baseBranch !== null) return card.baseBranch;
    const workspace = yield* workspaceFor(card);
    if (workspace.checkoutPath === null) return null;
    const { defaultBranch } = yield* resolveDefaultBranch(workspace);
    return resolveBoardCardEffectiveBase({
      card,
      cards: (yield* readBoard).cards,
      defaultBranch: defaultBranch === "" ? null : defaultBranch,
    });
  });

  /**
   * Admit a step that owns a live thread by nudging it, keeping the agent's context and never
   * putting two writers on one worktree. A gone thread answers `no-thread` and the caller spawns.
   * Admits before nudging: a refused admit after a nudge would leave an agent on a queued step.
   */
  const resumeExistingStepThread = Effect.fn("board-supervisor-resumeExistingStepThread")(
    function* (input: { readonly card: BoardCard; readonly state: BoardCardStepState }) {
      const { card, state } = input;
      if (state.threadId === null) return "no-thread";
      // A card moved since this thread ran starts afresh where it is now. Checked before reading
      // the thread: the old worker may be offline or removed, and the caller already holds a slot.
      const board = yield* readBoard;
      const link = card.threadLinks.find((candidate) => candidate.threadId === state.threadId);
      const fresh = board.cards.find((candidate) => candidate.id === card.id) ?? card;
      if (
        link !== undefined &&
        boardThreadLinkWorkerId(link) !== boardCardEffectiveWorkerId(fresh, board.defaultWorkerId)
      ) {
        return "no-thread";
      }
      if (yield* threadGone(state.threadId)) return "no-thread";
      const admitted = yield* dispatchOptional({
        type: "board.card.admit-step",
        commandId: yield* commandId("admit-step"),
        cardId: card.id,
        stepId: state.stepId,
        admitted: true,
        threadId: state.threadId,
        createdAt: yield* nowIso,
      });
      if (!admitted) return "refused";
      // The resume text depends on why it stopped; a backoff rung resumes with the recovery nudge
      // recomposed from the step row.
      const text =
        state.stalledReason === "usage-limit"
          ? BOARD_STEP_USAGE_LIMIT_RESUME_NUDGE
          : state.stalledReason === "waiting-retry"
            ? boardRecoveryNudge({
                stallCount: state.stallCount,
                endedWithQuestion: yield* endedWithQuestion(state),
                stepId: state.stepId,
              })
            : BOARD_STEP_RESUME_NUDGE;
      yield* sendTurn({
        threadId: state.threadId,
        text,
        runtimeMode: state.runtimeMode,
      });
      return "admitted";
    },
  );

  /**
   * Leave a step queued, saying which limit holds it. A pending
   * step is recorded queued; a queued one is re-recorded only when the limit
   * changed, so a card waiting on a full worker writes one event, not one per
   * scheduling pass.
   */
  const holdQueued = Effect.fn("board-supervisor-holdQueued")(function* (
    state: BoardCardStepState,
    queuedBy: BoardStepQueuedBy,
  ) {
    if (state.status !== "pending" && state.queuedBy === queuedBy) return;
    yield* dispatch({
      type: "board.card.admit-step",
      commandId: yield* commandId("admit-step"),
      cardId: state.cardId,
      stepId: state.stepId,
      admitted: false,
      threadId: null,
      queuedBy,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Stall a step whose provider instance its worker does not have: the
   * board never runs it elsewhere or on another provider. Amber, for
   * a human — another worker, or a model this one offers — and it spends no
   * recovery budget, because the agent never ran.
   */
  const stallProviderMissing = Effect.fn("board-supervisor-stallProviderMissing")(function* (
    state: BoardCardStepState,
    workerId: BoardWorkerId,
  ) {
    yield* dispatch({
      type: "board.card.recover-step",
      commandId: yield* commandId("recover-step"),
      cardId: state.cardId,
      stepId: state.stepId,
      threadId: state.threadId,
      escalateToHuman: true,
      progressed: false,
      lastError: `The step's provider instance '${state.providerInstanceId}' isn't on worker ${workerId}.`,
      stalledReason: "provider-not-on-worker",
      chargeBudget: false,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Stall a step its worker can't be asked about any more (removed, or the card force-moved off
   * it): amber, no recovery budget spent, slot released.
   */
  const stallWorkerRemoved = Effect.fn("board-supervisor-stallWorkerRemoved")(function* (
    state: BoardCardStepState,
    detail: string,
  ) {
    const landed = yield* dispatchOptional({
      type: "board.card.recover-step",
      commandId: yield* commandId("worker-removed"),
      cardId: state.cardId,
      stepId: state.stepId,
      threadId: state.threadId,
      escalateToHuman: true,
      progressed: false,
      lastError: detail,
      stalledReason: "worker-removed",
      chargeBudget: false,
      createdAt: yield* nowIso,
    });
    if (landed) yield* releaseSlot(state);
  });

  /**
   * Whether a step is running on its thread or parked on it waiting to resume there. A human's
   * Pause is excluded: their resume starts afresh wherever the card now is.
   */
  const stepBoundToThread = (state: BoardCardStepState) =>
    state.threadId !== null &&
    (state.status === "running" ||
      state.status === "completing" ||
      state.status === "awaiting-input" ||
      (state.status === "stalled" && state.stalledReason !== "worker-removed"));

  /** Every step running or parked on a worker just removed from the board.
      A card that follows the default from now on restarts there. */
  const stallStepsOnRemovedWorker = Effect.fn("board-supervisor-stallStepsOnRemovedWorker")(
    function* (workerId: BoardWorkerId) {
      reconciledWorkers.delete(workerId);
      heldSignals.delete(workerId);
      decidedThreads.delete(workerId);
      const board = yield* readBoard;
      for (const state of boardNonTerminalStepStates(board)) {
        if (!stepBoundToThread(state)) continue;
        if (slotKeyFor(board, state).workerId !== workerId) continue;
        yield* stallWorkerRemoved(state, "The worker this step ran on was removed from the board.");
      }
      yield* requeueResolvedPlacementStalls();
    },
  );

  /**
   * A live step still reads as running or parked on an unreachable worker while the card now
   * runs elsewhere. Nothing will end or resume that run, so it is stalled.
   */
  const stallStrandedStep = Effect.fn("board-supervisor-stallStrandedStep")(function* (
    cardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    const state = boardCardStepState(board, cardId);
    if (card === undefined || state === null || !stepBoundToThread(state)) return;
    const at = slotKeyFor(board, state).workerId;
    const runsOn =
      card.workerMove?.status === "moving"
        ? card.workerMove.toWorkerId
        : boardCardEffectiveWorkerId(card, board.defaultWorkerId);
    if (at === runsOn || !(yield* workerPausedNow)(at)) return;
    yield* stallWorkerRemoved(state, "The card was moved off the worker this step ran on.");
  });

  /**
   * Provision a build step's worktree at stage entry only where it can run now. Other cards are
   * left to `schedule()`, so a worktree is never cut on the wrong worker.
   */
  const provisionPlacedBuildStep = Effect.fn("board-supervisor-provisionPlacedBuildStep")(
    function* (cardId: BoardCardId) {
      const board = yield* readBoard;
      const card = board.cards.find((candidate) => candidate.id === cardId);
      const state = boardCardStepState(board, cardId);
      if (card === undefined || state === null || card.workerMove !== null) return;
      const { gate } = yield* placementFor(board, card, state);
      if (gate.kind !== "ready") return;
      yield* provisionBuildStep(card);
    },
  );

  /**
   * Requeue a step stalled for a missing provider once its card can run it, or one stalled for
   * a removed worker once the card is moved, re-pinned or the worker is back. The following pass
   * re-checks, so a step whose worker still can't run it simply stalls again.
   */
  const requeueResolvedPlacementStalls = Effect.fn(
    "board-supervisor-requeueResolvedPlacementStalls",
  )(function* (onlyCardId?: BoardCardId) {
    const board = yield* readBoard;
    for (const state of board.stepStates ?? []) {
      if (
        state.status !== "stalled" ||
        (state.stalledReason !== "provider-not-on-worker" &&
          state.stalledReason !== "worker-removed")
      )
        continue;
      if (onlyCardId !== undefined && state.cardId !== onlyCardId) continue;
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined || card.archivedAt !== null) continue;
      if (
        state.stalledReason === "worker-removed" &&
        (card.placementOrphaned !== null || card.workerMove !== null)
      ) {
        continue;
      }
      // Not while the worker is offline: nothing has been fixed, and
      // requeueing would hide the needs-a-human stall until it reconnects and
      // stalls again. A worker still cloning the project (a re-pin to one
      // being set up) requeues, and the pass holds the step as "setting up".
      const { gate } = yield* placementFor(board, card, state);
      if (gate.kind === "offline") continue;
      // A step whose worker went is requeued whatever the new one lacks: the
      // pass that follows stalls it again for the reason that now applies.
      if (gate.kind === "provider-missing" && state.stalledReason === "provider-not-on-worker") {
        continue;
      }
      yield* dispatch({
        type: "board.card.requeue-step",
        commandId: yield* commandId("requeue-step"),
        cardId: card.id,
        preserveBudget: true,
        createdAt: yield* nowIso,
      });
    }
  });

  // Offer one build-mode step to the governor: acquire a slot under the resolved
  // caps and spawn its thread on the card's worktree, or leave it queued.
  // Enforces the one-writer-per-worktree invariant BEFORE acquiring, so
  // a refused spawn never leaks a slot.
  const admitBuildCandidate = Effect.fn("board-supervisor-admitBuildCandidate")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    readonly worktreePath: string;
    /** The worker the step runs on, whose limits it is offered under. */
    readonly workerId: BoardWorkerId;
    readonly limits: BoardConcurrencyLimit;
  }) {
    const { card, state } = input;
    const slotKey: BoardSlotKey = {
      workerId: input.workerId,
      providerInstanceId: state.providerInstanceId,
    };
    // One writer at a time per worktree (an invariant). The assertion counts
    // the writer we are ABOUT to spawn, so an existing writer plus the new one
    // fails it; on failure we REFUSE before acquiring a slot, so the invariant
    // blocks rather than stranding a slot.
    const board = yield* readBoard;
    // Re-check on the fresh read: external RPC commands are not serialised with
    // the worker, so the card may have been archived since `schedule` snapshot
    // it — admitting would be rejected AFTER the slot was acquired.
    const fresh = board.cards.find((candidate) => candidate.id === card.id);
    if (fresh === undefined || fresh.archivedAt !== null) return;
    // A step being RE-admitted already owns its thread (a paused step
    // resumed through the queue keeps the conversation it had), so counting it
    // alongside the `board-admit:` sentinel below would be counting the same
    // writer twice and the re-admission would refuse itself every time.
    const liveWriters = (board.stepStates ?? [])
      .filter(
        (candidate) =>
          candidate.cardId === card.id &&
          !isBoardTerminalStepStatus(candidate.status) &&
          candidate.threadId !== null &&
          !(candidate.stepId === state.stepId && candidate.threadId === state.threadId),
      )
      .map((candidate) => String(candidate.threadId));
    const wouldConflict = yield* assertSingleBoardWorktreeWriter({
      cardId: card.id,
      activeWriterThreadIds: [...liveWriters, `board-admit:${state.stepId}`],
    }).pipe(
      Effect.as(false),
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor: refusing to spawn a second writer", {
          cardId: card.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(true)),
      ),
    );
    if (wouldConflict) return;

    // A human forced this step over the cap, so the slot is taken unconditionally (`restore`); the
    // count sits above the ceiling until this step releases it, exactly once.
    const admission = yield* state.forceStart
      ? slots.restore(slotKey).pipe(Effect.as({ admitted: true } as const))
      : slots.acquire(slotKey, input.limits);
    if (!admission.admitted) {
      // No slot right now. A fresh (pending) step is recorded queued so the card
      // shows its badge; a queued step stays put and is re-offered next
      // boundary — re-recorded only when the limit holding it changed.
      yield* holdQueued(state, admission.blockedBy);
      return;
    }

    // Until an admit lands the slot is this candidate's alone (`slotHeld` is still false), so any
    // failure before then returns it here. Nothing after a landed admit can fail.
    yield* Effect.gen(function* () {
      // A step that already owns a live thread is being RESUMED, not started:
      // it was paused, a human pressed Resume, and the governor has just
      // admitted it. A refused resume must give the slot straight back, or the
      // acquire above leaks capacity nothing will ever release.
      const resumed = yield* resumeExistingStepThread({ card, state });
      if (resumed === "refused") {
        yield* slots.release(slotKey);
        return;
      }
      if (resumed === "admitted") return;
      const spawnAttachments = yield* stageSpawnAttachments(card);
      const threadId = yield* spawnStepThread({
        card,
        attachments: spawnAttachments,
        step: {
          stepId: state.stepId,
          stepLabel: state.stepLabel,
          stageLabel: state.stageLabel,
          providerInstanceId: state.providerInstanceId,
          model: state.model,
          mode: state.mode,
          runtimeMode: state.runtimeMode,
          modelOptions: state.modelOptions,
        },
        worktreePath: input.worktreePath,
        branch: card.worktree?.branch ?? null,
        runSetup: true,
        text: yield* stepPromptFor(card, state),
      });
      if (threadId === null || threadId === "no-agent-model") {
        // No thread was created, so release the slot this candidate just acquired
        // (the persisted `slotHeld` is still false — admit-step never ran — so
        // `releaseSlot` would decline it) and escalate rather than admit.
        yield* slots.release(slotKey);
        yield* escalateSpawnFailure({ card, state, ...spawnFailureError(threadId) });
        return;
      }
      if (threadId === "worker-offline") {
        // Its worker went between the placement gate and the spawn, and was
        // sent nothing: the step waits for it, as the gate would have held it.
        yield* slots.release(slotKey);
        yield* holdQueued(state, "worker-offline");
        return;
      }
      // If admit-step does not land, `slotHeld` stays false and nothing would release the slot:
      // release it here and unlink the orphaned thread.
      const admitLanded = yield* boardEngine
        .dispatch({
          type: "board.card.admit-step",
          commandId: yield* commandId("admit-step"),
          cardId: card.id,
          stepId: state.stepId,
          admitted: true,
          threadId,
          createdAt: yield* nowIso,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "board supervisor: admit-step rejected after acquire; releasing slot",
              {
                cardId: card.id,
                stepId: state.stepId,
                cause: Cause.pretty(cause),
              },
            ).pipe(Effect.as(false)),
          ),
        );
      if (!admitLanded) {
        yield* slots.release(slotKey);
        // Interrupt the orphan's turn. This lands only if the session has bound; otherwise
        // `orphanedThreads` re-dispatches it on the thread's `session.started`.
        orphanedThreads.add(String(threadId));
        yield* interruptOrphan(threadId);
        yield* dispatch({
          type: "board.card.unlink-thread",
          commandId: yield* commandId("unlink-orphan"),
          cardId: card.id,
          threadId,
          createdAt: yield* nowIso,
        });
        // Unlinked while alive, so no card derives it any more. It is a
        // thread for a step the board refused to admit — nothing will use it.
        abandonedThreads.add(String(threadId));
      }
    }).pipe(Effect.onError(() => slots.release(slotKey)));
  });

  // A plan-mode step holds no slot and needs no worktree: spawn it directly
  // in the project workspace root and mark it admitted. The decider records
  // `slotHeld: false` for a plan-mode admit, so nothing is charged against the
  // concurrency ceiling.
  const admitPlanStep = Effect.fn("board-supervisor-admitPlanStep")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
  }) {
    const { card, state } = input;
    // A paused plan-mode step resumes its existing thread like a build step. It holds no slot, so
    // a refusal leaks nothing and leaves the step queued.
    const resumed = yield* resumeExistingStepThread({ card, state });
    if (resumed !== "no-thread") return;
    const model = yield* readModel;
    const cwd = projectCwd(model, card);
    if (cwd === null) {
      // Same wedge as a refused spawn, so the same exit: left `pending`, the
      // step would be re-offered and re-logged at every boundary forever with
      // nothing the human can see or restart.
      yield* Effect.logWarning("board supervisor: no project cwd for plan-mode step", {
        cardId: card.id,
      });
      yield* escalateSpawnFailure({ card, state });
      return;
    }
    const spawnAttachments = yield* stageSpawnAttachments(card);
    const threadId = yield* spawnStepThread({
      card,
      attachments: spawnAttachments,
      step: {
        stepId: state.stepId,
        stepLabel: state.stepLabel,
        stageLabel: state.stageLabel,
        providerInstanceId: state.providerInstanceId,
        model: state.model,
        mode: state.mode,
        runtimeMode: state.runtimeMode,
        modelOptions: state.modelOptions,
      },
      worktreePath: cwd,
      branch: null,
      runSetup: false,
      text: yield* stepPromptFor(card, state),
    });
    // A plan step holds no slot, so a failed spawn leaks no capacity — but it
    // must still not be admitted against a thread that was never created.
    if (threadId === null || threadId === "no-agent-model") {
      yield* escalateSpawnFailure({ card, state, ...spawnFailureError(threadId) });
      return;
    }
    if (threadId === "worker-offline") {
      yield* holdQueued(state, "worker-offline");
      return;
    }
    yield* dispatch({
      type: "board.card.admit-step",
      commandId: yield* commandId("admit-step"),
      cardId: card.id,
      stepId: state.stepId,
      admitted: true,
      threadId,
      createdAt: yield* nowIso,
    });
  });

  // The governor's scheduling pass. Plan-mode steps spawn
  // immediately (no slot, no worktree). Build-mode steps waiting for a slot,
  // whose worktree is ready, are ordered by the priority rule (stage desc →
  // started before unstarted → drag order) and offered to the governor greedily.
  const schedule = Effect.fn("board-supervisor-schedule")(function* () {
    // Queued CI passes go first: whatever freed a slot (a step settling, a
    // pass ending) runs this pass, and CI cards are later-stage than any step.
    yield* ciPasses.admitQueued;
    const board = yield* readBoard;
    const settings = yield* boardSettings;
    // Read once for the whole pass: every candidate is gated against the same
    // instant, so a long pass cannot admit one card and withhold its neighbour
    // over a boundary that moved underneath them.
    const nowMs = Date.parse(yield* nowIso);
    const entries = new Map<
      string,
      {
        readonly card: BoardCard;
        readonly state: BoardCardStepState;
        readonly worktreePath: string;
        readonly workerId: BoardWorkerId;
        readonly limits: BoardConcurrencyLimit;
      }
    >();
    const candidates: BoardQueueCandidate[] = [];
    for (const state of board.stepStates ?? []) {
      if (state.status !== "pending" && state.status !== "queued") continue;
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined || card.archivedAt !== null) continue;
      // A card moving to another worker holds until its new worktree is
      // ready, and one whose move failed until a human retries or picks
      // another worker — its old worktree is gone.
      if (card.workerMove !== null) continue;
      // Placement: the step runs on the card's worker, and only
      // once that worker is online, has a checkout of the project and has the
      // step's provider instance. Ahead of the plan branch: a planning thread
      // needs the checkout as much as a build does.
      const placed = yield* placementFor(board, card, state);
      if (placed.gate.kind === "offline") {
        // Held, saying so: the card wears Worker offline until its
        // worker is back.
        yield* holdQueued(state, "worker-offline");
        continue;
      }
      if (placed.gate.kind === "no-checkout") {
        yield* holdQueued(state, "setup");
        continue;
      }
      if (placed.gate.kind === "provider-missing") {
        yield* stallProviderMissing(state, placed.workerId);
        continue;
      }
      if (state.mode === "plan") {
        // Plan-mode holds no slot: spawn a freshly selected step now. Nothing
        // withholds a plan step, so `queued` used to be unreachable here — but a
        // paused planning step sent back through Resume arrives exactly
        // that way, and skipping it would wedge the card in the queue forever.
        yield* admitPlanStep({ card, state });
        continue;
      }
      // Scheduled-start gate, before provisioning or a slot: a future card holds neither and cuts
      // no branch from a base that will have moved. After the plan-mode branch, since a plan step
      // is never withheld. `forceStart` wins.
      if (!state.forceStart && !isBoardCardScheduleDue(card.scheduledStartAt, nowMs)) {
        continue;
      }
      // Anything not `ready` or mid-`provisioning` is (re)provisioned here, so a failure is a
      // visible, retried step rather than a wedged pending one. `ensureWorktree` is idempotent
      // and attaches to an existing branch.
      let worktreePath =
        card.worktree !== null && card.worktree.status === "ready" ? card.worktree.path : null;
      if (
        worktreePath === null &&
        (card.worktree === null ||
          card.worktree.status !== "provisioning" ||
          interruptedProvisions.has(String(card.id)))
      ) {
        worktreePath = yield* provisionBuildStep(card);
      }
      if (worktreePath === null) continue;
      const key = `${String(card.id)}::${state.stepId}`;
      entries.set(key, {
        card,
        state,
        worktreePath,
        workerId: placed.workerId,
        limits: resolveBoardConcurrencyLimit(
          settings.concurrency,
          state.providerInstanceId,
          placed.workerId,
        ),
      });
      // "Started" = the card has begun THIS stage's step (a recorded completion
      // for it), so a re-entered stage never ranks as mid-flight on a fresh run.
      candidates.push({
        cardId: card.id,
        stepId: state.stepId,
        providerInstanceId: state.providerInstanceId,
        stageOrder: boardStageIndex(board, card.stage),
        // …or the step already owns a thread: a paused step sent back through the queue is
        // mid-stage with no recorded completion, and would otherwise rank as fresh work.
        started:
          state.threadId !== null ||
          boardCardStepCompletions(board, card.id).some((c) => c.stepId === state.stepId),
        orderKey: card.orderKey,
      });
    }
    // A force-started step is offered FIRST, and its position in the
    // priority order is irrelevant: it is not competing for a slot, it takes
    // one. Leaving it in place would only make it wait behind candidates the
    // governor is about to refuse anyway.
    const ordered = orderBoardQueue(candidates).map((candidate) => ({
      candidate,
      entry: entries.get(`${String(candidate.cardId)}::${candidate.stepId}`),
    }));
    const forced = ordered.filter(({ entry }) => entry?.state.forceStart === true);
    const rest = ordered.filter(({ entry }) => entry?.state.forceStart !== true);
    for (const { entry } of [...forced, ...rest]) {
      if (entry !== undefined) yield* admitBuildCandidate(entry);
    }
  });

  // The base's tip as the remote has it, fetched first, so a merge from another worker counts as
  // movement. Null when unmeasurable: staleness is measured, never assumed.
  const measureBaseTip = Effect.fn("board-supervisor-measureBaseTip")(function* (card: BoardCard) {
    const baseRefName = card.worktree?.baseRefName ?? null;
    if (baseRefName === null) return null;
    const workspace = yield* workspaceFor(card);
    if (workspace.checkoutPath === null) return null;
    return yield* workspace.measureBaseTip({ baseRefName }).pipe(
      Effect.map((measured) => measured.tip),
      Effect.catchCause(() => Effect.succeed(null as string | null)),
    );
  });

  // Whether the base moved since the run row's `baseTipAtRoundStart`; the reactor's one impure
  // input to `planNext` and the crossing/merge-click interceptions.
  const resolveBaseStale = Effect.fn("board-supervisor-resolveBaseStale")(function* (
    card: BoardCard,
  ) {
    // A retarget counts at any level: the stated base and the actual cut point disagree, so a pull
    // request would show commits nobody wrote. This lets even a top-level card get a sync step.
    if (yield* resolveBaseRetargeted(card)) return true;
    // Tip movement counts only for sub-board children: siblings are created to collide on their
    // shared base, while a top-level base moving is ordinary trunk development.
    if (card.parentCardId === null) return false;
    const board = yield* readBoard;
    // Only cards merging into an integration branch: a child of an
    // inherit group lands on trunk like a top-level card.
    if (!boardCardMergesIntoIntegrationBranch(board, card)) return false;
    const recorded = boardCardStepState(board, card.id)?.baseTipAtRoundStart ?? null;
    if (recorded === null) return false;
    const tip = yield* measureBaseTip(card);
    if (tip === null) return false;
    return tip !== recorded;
  });

  /**
   * The base the card was retargeted at, when it differs from the one its branch was cut from;
   * null when they agree, with no live branch, or when unresolvable. The one source for the
   * retarget trigger, the sync target, `record-base-ref` and the card's divergence line.
   */
  const resolveBaseRetargetTarget = Effect.fn("board-supervisor-resolveBaseRetargetTarget")(
    function* (card: BoardCard) {
      const recorded = card.worktree?.baseRefName ?? null;
      if (recorded === null || !boardCardHasLiveBranch(card)) return null;
      // Only an unpinned top-level card needs the project default (git); everything else answers
      // from fields, so this check, run at every plan and crossing, usually does no I/O.
      const needsDefault =
        card.parentCardId === null
          ? card.baseBranch === null
          : !boardCardMergesIntoIntegrationBranch(yield* readBoard, card);
      const defaultBranch = needsDefault
        ? yield* Effect.gen(function* () {
            const workspace = yield* workspaceFor(card);
            if (workspace.checkoutPath === null) return null;
            const resolved = yield* resolveDefaultBranch(workspace);
            return resolved.defaultBranch === "" ? null : resolved.defaultBranch;
          })
        : null;
      // A child always needs the cards: an inherit group resolves through its
      // own parent chain, which can end at a pinned or unpinned top level.
      const effective = resolveBoardCardEffectiveBase({
        card,
        cards: card.parentCardId === null ? [] : (yield* readBoard).cards,
        defaultBranch,
      });
      return effective !== null && effective !== recorded ? effective : null;
    },
  );

  const resolveBaseRetargeted = Effect.fn("board-supervisor-resolveBaseRetargeted")(function* (
    card: BoardCard,
  ) {
    return (yield* resolveBaseRetargetTarget(card)) !== null;
  });

  // Measured fresh when the plan starts a review round (`recordBaseTip`), else carried forward
  // so a round's later steps keep the tip their review started from.
  const baseTipForPlan = Effect.fn("board-supervisor-baseTipForPlan")(function* (
    card: BoardCard,
    recordBaseTip: boolean,
  ) {
    if (recordBaseTip) return yield* measureBaseTip(card);
    const board = yield* readBoard;
    return boardCardStepState(board, card.id)?.baseTipAtRoundStart ?? null;
  });

  // Resolves the stage's execution config, freezes it onto the run row and spawns. Auto-kickoff
  // acts only on auto-executing stages; on-demand always starts. A re-entry opens a clean
  // human-in-the-loop thread with no prompt; a stage with a live thread is skipped.
  const beginStageRun = Effect.fn("board-supervisor-beginStageRun")(function* (input: {
    readonly card: BoardCard;
    readonly onDemand: boolean;
    /** Reconcile's end-of-boot kickoff pass (see `reconcile`): FIRST entries
        only — a re-entry's clean human thread stays a human action (drag /
        on-demand), never a restart side effect. */
    readonly bootPass?: boolean;
  }) {
    const { card, onDemand } = input;
    const bootPass = input.bootPass === true;
    const board = yield* readBoard;
    const stage = boardStageById(board, card.stage);
    if (stage === null) return;
    // A split parent builds through its children: while any is unfinished no run starts, since a
    // thread for a frozen card could only watch.
    if (boardCardUnfinishedChildren(board, card.id).length > 0) return;
    // A group's pipeline is paused: it runs only the integration
    // review of its own branch, once every active child is done. An inherit
    // group or an empty heading never runs anything.
    {
      const group = boardCardGroupOf(board, card);
      if (
        group !== null &&
        (group.target !== "own" || boardCardActiveChildren(board, card.id).length === 0)
      ) {
        return;
      }
    }
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(
      settings,
      card.stage,
      boardProjectStageConfig(board, card.projectId),
    );
    const mergeRole = effectiveBoardStageRole(stage) === "merge";
    // An on-demand request for a stage that runs nothing must not spawn a promptless thread.
    // Checked after superseding a stalled step, which Restart still offers on an empty stage.
    const emptyOnDemand =
      onDemand &&
      !exec.autoExecute &&
      !mergeRole &&
      !isBoardReviewStageExecution(exec) &&
      exec.prompt.trim() === "";
    // The automatic kickoff never starts a run while one is live or tramples a thread on the stage.
    // An on-demand restart supersedes whatever the card rests on instead: settle the old step
    // abandoned, stop its thread, spawn fresh, so no two threads own one step.
    const existing = boardCardStepState(board, card.id);
    let kept: ThreadId | null = null;
    if (onDemand) {
      if (existing !== null && !isBoardTerminalStepStatus(existing.status)) {
        yield* settleStep({ card, state: existing, outcome: "abandoned" });
        // Stalled and paused steps drive nothing; anything else may still have a turn in the
        // worktree, and a restart must not create a second writer.
        if (
          existing.status !== "stalled" &&
          existing.status !== "paused" &&
          existing.threadId !== null
        ) {
          yield* interruptOrphan(existing.threadId);
          // Named so its interrupt is not read as a human Stop; the release
          // sweep settles it from the retired link below.
          abandonedThreads.add(String(existing.threadId));
        }
      }
      // Retire the stage's own threads (role = stage id) so they don't trip the live-stage-thread
      // guard on the next kickoff. Adopted threads (role `linked`) are untouched.
      for (const link of card.threadLinks) {
        if (!isLiveBoardCardThreadLink(link)) continue;
        if (link.role !== card.stage && link.threadId !== existing?.threadId) continue;
        yield* dispatch({
          type: "board.card.retire-thread",
          commandId: yield* commandId("retire-superseded"),
          cardId: card.id,
          threadId: link.threadId,
          createdAt: yield* nowIso,
        });
      }
      if (emptyOnDemand) return;
    } else {
      // Never trample a thread already running this stage — except the
      // planning thread the card kept when it left unfinished, which
      // the step resumes on below rather than spawning a fresh interview.
      kept = keptPlanningThreadId(board, card);
      let stageLinks = card.threadLinks;
      if (kept !== null && (yield* threadGone(kept))) {
        // Deleted while the card was away: nothing to resume, and its link
        // would trip the guard below for good. Drop it and run the stage as
        // a card that never kept a thread would.
        yield* dispatch({
          type: "board.card.unlink-thread",
          commandId: yield* commandId("unlink-kept-gone"),
          cardId: card.id,
          threadId: kept,
          createdAt: yield* nowIso,
        });
        const gone = kept;
        stageLinks = stageLinks.filter((link) => link.threadId !== gone);
        kept = null;
      }
      if (kept === null && hasLiveStageThread({ ...card, threadLinks: stageLinks }, card.stage))
        return;
      if (existing !== null && !isBoardTerminalStepStatus(existing.status)) return;
    }
    // Auto-kickoff fires only for an auto-executing stage; on-demand runs any stage that
    // has work. An auto-plan run is always a fresh, unattended planning run, even when Planning
    // does not auto-execute, so the card's earlier planning step is set aside.
    const autoPlanRun =
      effectiveBoardStageRole(stage) === "plan" && isBoardCardAutoPlanPending(card);
    if (!onDemand && !exec.autoExecute && !autoPlanRun) return;
    const completions = boardCardStepCompletions(board, card.id).filter(
      (completion) => !autoPlanRun || completion.stepId !== card.stage,
    );
    // Re-entry (a recorded completion for this stage's step) runs nothing and opens a clean
    // human-in-the-loop conversation. The merge role is stricter: it runs unattended only when
    // armed by the board (a Merge click that hit a conflict or failed checks), on any visit; an
    // unarmed merge stage is always a conversation, even on the card's first visit.
    const armedFix = mergeRole ? (mergeAwaitingConflictFix.get(String(card.id)) ?? null) : null;
    const armedConflictFix = armedFix !== null;
    // An armed card's merge stage is never a conversation. Re-attempt the merge rather than
    // assume a conflict: a lost arm (escalation or restart) and a policy refusal look alike,
    // and only the forge can tell them apart. Gated on `!armedConflictFix` so the conflict step
    // this call starts does not re-enter here and merge in a loop.
    if (mergeRole && !armedConflictFix && (yield* cardAutoMergeArmed(card))) {
      yield* autoMergeCard(card);
      return;
    }
    const firstEntry =
      armedConflictFix ||
      (!mergeRole && !completions.some((completion) => completion.stepId === card.stage));
    // The boot pass only ever STARTS fresh work (or resumes an executor-driven
    // continuation below); a re-entry is skipped — its clean human thread must
    // not re-open on every server restart.
    if (bootPass && !firstEntry) return;
    const model = resolveBoardStageModelSelection(exec.model, yield* fallbackModelSelection);
    const cardOverride = cardStageModelOverride(board, card);
    // The stage executor decides what runs next. At entry a simple stage yields its single
    // seeded step; `complete`/`escalate` are not reached here.
    const plan = stageExecutorFor(stage.role, exec).planNext({
      card,
      config: {
        stepId: card.stage,
        stageLabel: stage.label,
        prompt: armedFix === "checks" ? DEFAULT_BOARD_CHECKS_FIX_PROMPT : exec.prompt,
        model,
        timeoutMs: exec.timeoutMs,
        maxAttempts: exec.maxAttempts,
        runtimeMode: exec.runtimeMode,
        cardOverride,
        execution: exec,
      },
      completions,
      // Stage entry: nothing of this card's is in flight yet, and nothing of
      // this card's has just settled.
      runState: {
        round: 1,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: null,
        baseStale: yield* resolveBaseStale(card),
        baseRetargetedTo: yield* resolveBaseRetargetTarget(card),
      },
    });
    // CI: entering the stage, or restarting it, runs the steps.
    if (plan.kind === "ci-pass" || plan.kind === "ci-stop") {
      // A pass already under way (the boot recovery got there first) is this
      // entry's pass; only a human's restart replaces it.
      if (!onDemand && ciPasses.current(card.id) !== null) return;
      yield* actOnCiPlan(card, plan, { fixThreadId: null, stageLabel: stage.label, exec });
      return;
    }
    if (plan.kind === "complete") {
      // A multi-step executor plans from ALL-TIME completions, so a finished review loop reports
      // `complete` forever. A re-entry or on-demand request still gets a clean human-in-the-loop
      // thread on the stage's own step id, but never from the boot pass: a restart is not a human.
      if (bootPass) return;
      const reentryModel =
        cardOverride === null ? model : boardModelSelectionOfOverride(cardOverride);
      yield* dispatch({
        type: "board.card.select-step",
        commandId: yield* commandId("select-step"),
        cardId: card.id,
        stepId: card.stage,
        // A re-entry conversation on the stage's own step: no step identity,
        // just the stage's name.
        stepLabel: null,
        stageLabel: stage.label,
        prompt: "",
        // The card's model override governs its re-entry conversation too; no executor plans a
        // re-entry, so the reactor applies it.
        providerInstanceId: reentryModel.instanceId,
        model: reentryModel.model,
        runtimeMode: cardOverride?.runtimeMode ?? exec.runtimeMode,
        ...(reentryModel.options === undefined ? {} : { modelOptions: reentryModel.options }),
        mode: exec.mode,
        humanInLoop: true,
        maxAttempts: exec.maxAttempts,
        timeoutMs: exec.timeoutMs,
        // A re-entry conversation starts no review round: carry the recorded
        // tip forward so a parked card's staleness stays
        // answerable.
        baseTipAtRoundStart: yield* baseTipForPlan(card, false),
        createdAt: yield* nowIso,
      });
      yield* schedule();
      return;
    }
    if (plan.kind !== "run") return;
    // Mode and human-in-the-loop are reactor policy layered onto
    // the executor's step: a re-entry forces a clean human-in-the-loop thread
    // with no prompt injected.
    const humanInLoop = firstEntry ? resolveHumanInLoop(board, settings, card, exec) : true;
    const prompt = firstEntry ? plan.prompt : "";
    yield* dispatch({
      type: "board.card.select-step",
      commandId: yield* commandId("select-step"),
      cardId: card.id,
      stepId: plan.stepId,
      // The step label is the armed fix's persisted identity ("this merge is held by conflicts").
      // `boardSelectedStepLabel` strips the reserved label from an unarmed plan, so no executor
      // can light the conflict pill by naming a step `Conflicts`. `recoverStep` re-dispatches it.
      stepLabel: boardSelectedStepLabel(armedFix, plan.stepLabel),
      stageLabel: stage.label,
      prompt,
      providerInstanceId: plan.model.instanceId,
      model: plan.model.model,
      runtimeMode: plan.runtimeMode,
      ...(plan.model.options === undefined ? {} : { modelOptions: plan.model.options }),
      mode: exec.mode,
      humanInLoop,
      maxAttempts: plan.maxAttempts,
      timeoutMs: plan.timeoutMs,
      // Measured fresh when this plan starts a review round, carried forward
      // otherwise.
      baseTipAtRoundStart: yield* baseTipForPlan(card, plan.recordBaseTip),
      createdAt: yield* nowIso,
    });
    if (kept !== null) {
      yield* resumeKeptPlanningThread({ card, stepId: plan.stepId, threadId: kept });
      return;
    }
    // `schedule` provisions the selected step's worktree; provisioning here as well would
    // report a failing provision onto the card twice.
    yield* schedule();
  });

  // On a successful run, move the card to the next stage in order when the stage's
  // `autoAdvance` is on, whether or not a human was in the loop. Never past the last stage. Rides
  // the ordinary move command, so a refused crossing leaves the card put.
  const advanceStage = Effect.fn("board-supervisor-advanceStage")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    /**
     * The role a DIRECTED advance ends toward. It ignores `autoAdvance` (a human asked for
     * this move) and moves with `override`, since the target is non-adjacent by construction.
     * Every other gate still applies, and a refused move leaves the card put.
     */
    readonly toRole?: BoardStageRole;
  }) {
    const board = yield* readBoard;
    if (input.toRole !== undefined) {
      // A card bound for merge in a CI project goes through CI first.
      const target =
        input.toRole === "merge" && isBoardCiActive(board, input.card.projectId)
          ? boardStageById(board, BOARD_SEED_STAGE_IDS.ci)
          : boardStageWithRole(board, input.toRole);
      if (target === null) {
        // The target stage was deleted while the step ran. The branch is already pushed and the
        // pull request open, so say so on the card rather than return silently.
        yield* dispatch({
          type: "board.card.record-note",
          commandId: yield* commandId("advance-directed-missing"),
          cardId: input.card.id,
          kind: "card-merge-refused",
          detail: `Held the move: this board no longer has a stage with the "${input.toRole}" role.`,
          createdAt: yield* nowIso,
        });
        return;
      }
      // Already there — the move is a no-op, not a held one, so nothing to say.
      if (target.stageId === input.card.stage) return;
      const refusal = yield* dispatchRefusal({
        type: "board.card.pipeline-move",
        commandId: yield* commandId("advance-directed"),
        cardId: input.card.id,
        toStage: target.stageId,
        override: true,
        createdAt: yield* nowIso,
      });
      if (refusal === null) return;
      // A gate closed between the click and here, after the step pushed and opened the pull
      // request. `submitCardForMerge` pre-checks these gates; this is the race, and the decider's
      // own sentence is recorded so it is not silent.
      yield* dispatch({
        type: "board.card.record-note",
        commandId: yield* commandId("advance-directed-refused"),
        cardId: input.card.id,
        kind: "card-merge-refused",
        detail: `Held the move to ${target.label}. ${refusal}`,
        createdAt: yield* nowIso,
      });
      return;
    }
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(
      settings,
      input.card.stage,
      boardProjectStageConfig(board, input.card.projectId),
    );
    if (!exec.autoAdvance) return;
    const next = boardNextStageId(board, input.card.stage, input.card.projectId);
    if (next === null) return;
    // The board's own move: it may carry a card into CI.
    yield* dispatch({
      type: "board.card.pipeline-move",
      commandId: yield* commandId("advance"),
      cardId: input.card.id,
      toStage: next,
      createdAt: yield* nowIso,
    });
  });

  // The board runs a CI project's steps itself, in the card's worktree. A pass moves the card
  // on and runs no agent; a failure is the CI executor's to decide. Passes run on their own
  // fibers (`ciPasses`); their ends come back through the serial worker.

  const ciPasses: BoardCiPasses = yield* makeBoardCiPasses({
    runner: ciRunner,
    slots,
    dispatch: (command) => dispatch(command),
    commandId: (tag) => commandId(tag).pipe(Effect.orDie),
    nowIso,
    onFinished: (finished): Effect.Effect<void> =>
      Effect.asVoid(worker.enqueue({ source: "ci", finished })),
  });

  /** Move a card out of CI to the next stage of its pipeline: the board's own
      move, which CI's human rules do not hold back. */
  const advanceFromCi = Effect.fn("board-supervisor-advanceFromCi")(function* (card: BoardCard) {
    const board = yield* readBoard;
    const next = boardNextStageId(board, BOARD_SEED_STAGE_IDS.ci, card.projectId);
    if (next === null) return;
    yield* dispatch({
      type: "board.card.pipeline-move",
      commandId: yield* commandId("ci-advance"),
      cardId: card.id,
      toStage: next,
      createdAt: yield* nowIso,
    });
  });

  /**
   * CI was switched off for the card's project while it sat in CI:
   * stop its pass and move it on with auto-merge disarmed, so nothing merges
   * that never passed CI. The confirmation in Settings said so.
   */
  const leaveCiSwitchedOff = Effect.fn("board-supervisor-leaveCiSwitchedOff")(function* (
    card: BoardCard,
  ) {
    yield* ciPasses.cancel(card.id);
    yield* dispatchOptional({
      type: "board.card.set-automation",
      commandId: yield* commandId("ci-off-disarm"),
      cardId: card.id,
      autoMerge: false,
      createdAt: yield* nowIso,
    });
    yield* dispatch({
      type: "board.card.record-note",
      commandId: yield* commandId("ci-off"),
      cardId: card.id,
      kind: "card-ci-held",
      detail: "CI was switched off for this project, so the card moved on with auto-merge off.",
      createdAt: yield* nowIso,
    });
    yield* advanceFromCi(card);
  });

  /** A project's config changed: with CI now off, its cards in CI
      move on. Cards in CI with no steps left wait (`startCiPass` holds them). */
  const handleProjectConfigSet = Effect.fn("board-supervisor-handleProjectConfigSet")(function* (
    projectId: ProjectId,
  ) {
    const board = yield* readBoard;
    if (isBoardCiSwitchedOn(board, projectId)) return;
    for (const card of board.cards) {
      if (card.archivedAt !== null || card.projectId !== projectId) continue;
      if (card.stage !== BOARD_SEED_STAGE_IDS.ci) continue;
      yield* leaveCiSwitchedOff(card);
    }
  });

  /** A held pass's reason ends by saying what to do, once. */
  const withCiRetryHint = (detail: string) =>
    detail.includes("Retry CI") ? detail : `${detail} Retry CI, or Skip CI.`;

  /** Hold a card in CI with a reason on its rail: a human can Skip CI. */
  const holdInCi = Effect.fn("board-supervisor-holdInCi")(function* (
    card: BoardCard,
    detail: string,
  ) {
    yield* dispatch({
      type: "board.card.record-note",
      commandId: yield* commandId("ci-held"),
      cardId: card.id,
      kind: "card-ci-held",
      detail,
      createdAt: yield* nowIso,
    });
  });

  /** Start a pass at the first step (entry, a fix, or a restart). */
  const startCiPass = Effect.fn("board-supervisor-startCiPass")(function* (
    cardId: BoardCardId,
    options: { readonly fixThreadId: ThreadId | null; readonly fresh?: boolean },
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || card.archivedAt !== null) return;
    if (card.stage !== BOARD_SEED_STAGE_IDS.ci) return;
    // One pass at a time: a restart replaces the one in flight, which the new
    // pass's record settles as interrupted.
    yield* ciPasses.cancel(card.id);
    const projectConfig = boardProjectStageConfig(board, card.projectId);
    if (!isBoardCiSwitchedOn(board, card.projectId) || projectConfig === null) {
      // CI was switched off for this project while the card sat in it: there
      // is nothing to run, so it moves on like a card in a switched-off stage.
      yield* leaveCiSwitchedOff(card);
      return;
    }
    // A Retry or recovery can land here with a live pass: hold that pass with
    // the real reason, or the sweep later holds it as one that stopped silently.
    const holdBeforeStart = (held: BoardCard, why: string, action?: string) =>
      held.ci !== null && isCiPassLive(held, held.ci.runId)
        ? holdCiPass(held, held.ci.runId, why).pipe(Effect.asVoid)
        : holdInCi(held, action === undefined ? why : `${why} ${action}`);
    const steps = projectConfig.ci.steps;
    if (steps.length === 0) {
      // Emptying the step list doesn't turn CI off; the card waits.
      yield* holdBeforeStart(card, "This project's CI has no steps.", "Add one, or skip CI.");
      return;
    }
    const workerId = boardCardEffectiveWorkerId(card, board.defaultWorkerId);
    // A placed card's steps run on its worker, streamed back here.
    const runner =
      workerId === BOARD_LOCAL_WORKER_ID
        ? undefined
        : Option.isSome(workerConnections)
          ? remoteCiRunner(workerConnections.value, workerId)
          : null;
    if (runner === null) {
      yield* holdBeforeStart(
        card,
        "CI can't reach the card's worker.",
        "Restart the stage, or Skip CI.",
      );
      return;
    }
    const worktree = yield* ensureWorktree(card);
    if (worktree.kind !== "ready") {
      yield* holdBeforeStart(card, "CI is waiting for the card's worktree, which is not ready.");
      return;
    }
    const detail = yield* boardQueries
      .boardCardDetail(card.id)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const passes = detail?.ciPasses ?? [];
    const latestEntry = passes.reduce((highest, pass) => Math.max(highest, pass.entry), 0);
    // A human's fresh retry is a new entry, so the passes group by it.
    const entry =
      options.fresh === true
        ? Math.max(latestEntry, card.ci?.entry ?? 0) + 1
        : (card.ci?.entry ?? latestEntry + 1);
    const ordinal = passes.filter((pass) => pass.entry === entry).length + 1;
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(
      settings,
      BOARD_SEED_STAGE_IDS.ci,
      boardProjectStageConfig(board, card.projectId),
    );
    const runId = `ci-${yield* crypto.uuidV4()}`;
    const landed = yield* dispatchLanded({
      type: "board.card.record-ci",
      commandId: yield* commandId("ci-start"),
      cardId: card.id,
      action: {
        kind: "start-pass",
        runId,
        entry,
        ordinal,
        steps,
        configVersion: projectConfig.version,
        maxFixAttempts: isBoardCiStageExecution(exec)
          ? exec.maxFixAttempts
          : DEFAULT_BOARD_CI_MAX_FIX_ATTEMPTS,
        logDir: boardCiLogDir(worktree.path, runId),
        // Until a slot admits it; its first step report says running.
        queued: true,
        fixThreadId: options.fixThreadId,
        ...(options.fresh === true ? { fresh: true } : {}),
        // Frozen on the pass, so a flip applies from the next one.
        ...(boardCiStopsOnFailure(projectConfig.ci) ? {} : { continueOnFailure: true }),
      },
      createdAt: yield* nowIso,
    });
    if (!landed) return;
    rememberCiSnapshot(card.id, runId, steps, ordinal);
    yield* runCiSegment(card.id, runId, steps, 0);
  });

  /**
   * Run a pass from step `from`: the script groups up to the next
   * agent or forge step on the runner (holding a slot), or that step, or —
   * past the last step — the pass's end. A pass is segments between its agent
   * and forge steps, and the runner never holds a slot while one runs.
   */
  const runCiSegment: (
    cardId: BoardCardId,
    runId: string,
    steps: ReadonlyArray<BoardCiStep>,
    from: number,
  ) => Effect.Effect<void> = Effect.fn("board-supervisor-runCiSegment")(
    function* (
      cardId: BoardCardId,
      runId: string,
      steps: ReadonlyArray<BoardCiStep>,
      from: number,
    ) {
      const board = yield* readBoard;
      const card = board.cards.find((candidate) => candidate.id === cardId);
      if (card === undefined || !isCiPassLive(card, runId)) return;
      const segment = boardCiNextSegment(steps, from);
      if (segment.kind === "done") {
        // Fail closed. A pass whose record can't be read is held, and
        // one with any failed step fails, whatever the setting.
        const read = yield* ciPassFailures(card.id, runId);
        if (read === null) {
          yield* holdCiPass(
            card,
            runId,
            "CI lost track of this pass's steps. Retry CI, or Skip CI.",
          );
          return;
        }
        if (
          read.failures.length > 0 ||
          card.ci.steps.some((step) => isBoardCiStepFailure(step.status))
        ) {
          yield* failCiPass(card, runId);
          return;
        }
        const recorded = yield* dispatchLanded({
          type: "board.card.record-ci",
          commandId: yield* commandId("ci-finish"),
          cardId: card.id,
          action: { kind: "finish-pass", runId, result: "passed" },
          createdAt: yield* nowIso,
        });
        if (!recorded) ciLostResults.set(runId, { exitCode: 0 });
        else if (yield* ciPassRecordedAs(card.id, runId, "passed")) yield* advanceFromCi(card);
        return;
      }
      if (segment.kind !== "scripts") {
        if (segment.kind === "agent") yield* startCiAgentStep(card, runId, steps, segment.index);
        else yield* startCiForgeStep(card, runId, steps, segment.index);
        return;
      }
      const workerId = boardCardEffectiveWorkerId(card, board.defaultWorkerId);
      const runner =
        workerId === BOARD_LOCAL_WORKER_ID
          ? undefined
          : Option.isSome(workerConnections)
            ? remoteCiRunner(workerConnections.value, workerId)
            : null;
      if (runner === null) {
        yield* holdCiPass(card, runId, "CI can't reach the card's worker. Retry CI, or Skip CI.");
        return;
      }
      const worktree = yield* ensureWorktree(card);
      if (worktree.kind !== "ready") {
        yield* holdCiPass(
          card,
          runId,
          "CI is waiting for the card's worktree, which is not ready. Retry CI once it is.",
        );
        return;
      }
      const settings = yield* boardSettings;
      // The board's own disk (its database) needs room to record the
      // pass; a worker's worktree disk is the runner's to check.
      if (Option.isSome(serverConfig)) {
        const lowDisk = yield* boardCiLowDiskReason(serverConfig.value.stateDir);
        if (lowDisk !== null) {
          yield* holdCiPass(card, runId, lowDisk, { machine: true });
          return;
        }
      }
      // Retry and Stop run on their own fibers: the pass may have been
      // replaced or held while the worktree was readied.
      const fresh = yield* readCard(cardId);
      if (fresh === null || !isCiPassLive(fresh, runId)) return;
      yield* ciPasses.start({
        cardId: card.id,
        runId,
        worktreePath: worktree.path,
        workerId,
        steps: boardCiScriptDefinitions(steps.slice(segment.start, segment.end)),
        indexOffset: segment.start,
        ...(card.ci.continueOnFailure === true ? { stopOnFailure: false } : {}),
        limits: resolveBoardConcurrencyLimit(
          settings.concurrency,
          BOARD_CI_SLOT_INSTANCE,
          workerId,
        ),
        ...(runner === undefined ? {} : { runner }),
      });
      // A hold that landed since the re-read cancelled nothing of this
      // segment, so it is this segment's to drop.
      const after = yield* readCard(cardId);
      if (after === null || !isCiPassLive(after, runId)) {
        if ((yield* cancelCiRun(cardId, runId)) !== null) yield* schedule();
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: CI segment failed", { cause: Cause.pretty(cause) }),
    ),
  );

  /** Each live pass's frozen steps and ordinal, by run id: kept in memory
      as the pass starts, and read back off its row after a restart. A card
      has one live pass, so a card's new pass drops its old entry. */
  const ciSnapshots = new Map<
    string,
    {
      readonly cardId: BoardCardId;
      readonly steps: ReadonlyArray<BoardCiStep>;
      readonly ordinal: number;
    }
  >();
  const rememberCiSnapshot = (
    cardId: BoardCardId,
    runId: string,
    steps: ReadonlyArray<BoardCiStep>,
    ordinal: number,
  ) => {
    for (const [known, entry] of ciSnapshots) {
      if (entry.cardId === cardId && known !== runId) ciSnapshots.delete(known);
    }
    ciSnapshots.set(runId, { cardId, steps, ordinal });
  };

  /** The steps a pass froze at its start, and its pass rows as templates. */
  const ciPassSnapshot = Effect.fn("board-supervisor-ciPassSnapshot")(function* (
    cardId: BoardCardId,
    runId: string,
  ) {
    const known = ciSnapshots.get(runId);
    if (known !== undefined) {
      return {
        steps: known.steps,
        ordinal: known.ordinal,
        rows: boardCiPassStepsFromSnapshot(known.steps),
      };
    }
    const detail = yield* boardQueries
      .boardCardDetail(cardId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const pass = detail?.ciPasses.find((candidate) => candidate.runId === runId);
    if (pass?.snapshot == null) return { steps: null, ordinal: 1, rows: [] };
    rememberCiSnapshot(cardId, runId, pass.snapshot, pass.ordinal);
    return { steps: pass.snapshot, ordinal: pass.ordinal, rows: pass.steps };
  });

  /** A pass row as it stands now: the template, with the card's live state. */
  const ciStepRow = (card: BoardCard, rows: ReadonlyArray<BoardCiPassStep>, index: number) => {
    const row = rows[index];
    if (row === undefined) return undefined;
    const live = card.ci?.steps[index];
    return live === undefined ? row : { ...row, startedAt: live.startedAt };
  };

  /** Record one step's row on a pass. */
  const recordCiStep = Effect.fn("board-supervisor-recordCiStep")(function* (
    cardId: BoardCardId,
    runId: string,
    index: number,
    step: BoardCiPassStep,
  ) {
    return yield* dispatchLanded({
      type: "board.card.record-ci",
      commandId: yield* commandId("ci-step"),
      cardId,
      action: { kind: "step", runId, index, step },
      createdAt: yield* nowIso,
    });
  });

  /**
   * A CI agent step: a card step through the ordinary executor
   * machinery — slots, the watchdog, recovery and `board_complete_step` —
   * run alone. Its prompt is the project's, inside the board's prefix and
   * suffix.
   */
  const startCiAgentStep = Effect.fn("board-supervisor-startCiAgentStep")(function* (
    card: BoardCard,
    runId: string,
    steps: ReadonlyArray<BoardCiStep>,
    index: number,
  ) {
    const step = steps[index];
    if (step === undefined || step.kind !== "agent" || card.ci === null) return;
    const board = yield* readBoard;
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(
      settings,
      BOARD_SEED_STAGE_IDS.ci,
      boardProjectStageConfig(board, card.projectId),
    );
    const startedAt = yield* nowIso;
    const { rows, ordinal } = yield* ciPassSnapshot(card.id, runId);
    const row = ciStepRow(card, rows, index);
    if (row === undefined) return;
    yield* recordCiStep(card.id, runId, index, { ...row, status: "running", startedAt });
    const model =
      step.model ?? resolveBoardStageModelSelection(exec.model, yield* fallbackModelSelection);
    const brief = yield* boardQueries
      .boardCardBrief(card.id)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    yield* dispatch({
      type: "board.card.select-step",
      commandId: yield* commandId("select-step"),
      cardId: card.id,
      stepId: boardCiAgentStepId(runId, index),
      stepLabel: `CI · ${step.name}`,
      stageLabel: "Continuous integration",
      prompt: composeBoardCiAgentStepPrompt({
        cardKey: card.key,
        cardTitle: card.title,
        briefExcerpt: brief === null ? null : brief.slice(0, 1_500),
        branch: card.worktree?.branch ?? null,
        baseBranch: card.worktree?.baseRefName ?? null,
        pullRequestUrl: card.pullRequest?.url ?? null,
        stepName: step.name,
        pass: ordinal,
        fixAttempt: card.ci.fixAttempts,
        maxFixAttempts: card.ci.maxFixAttempts,
        earlier: card.ci.steps
          .slice(0, index)
          .map((entry) => ({ name: entry.name, status: entry.status })),
        remaining: steps.slice(index + 1).map((entry) => entry.name),
        prompt: step.prompt,
      }),
      providerInstanceId: model.instanceId,
      model: model.model,
      runtimeMode: exec.runtimeMode,
      ...(model.options === undefined ? {} : { modelOptions: model.options }),
      mode: "build",
      humanInLoop: false,
      maxAttempts: exec.maxAttempts,
      timeoutMs: step.timeoutMinutes * 60_000,
      priorRecoveries: 0,
      baseTipAtRoundStart: yield* baseTipForPlan(card, false),
      createdAt: yield* nowIso,
    });
    yield* provisionPlacedBuildStep(card.id);
    yield* schedule();
  });

  /**
   * Forge-check steps in flight, by card: the pass and step, when
   * it started, whether the board readied the pull request, and the last
   * reading recorded (so only changes are). In memory: a restart re-runs the
   * pass from the top.
   */
  const forgeSteps = new Map<
    string,
    {
      readonly runId: string;
      readonly index: number;
      readonly startedMs: number;
      readied: boolean;
      errors: number;
      lastKey: string;
    }
  >();

  const startCiForgeStep: (
    card: BoardCard,
    runId: string,
    steps: ReadonlyArray<BoardCiStep>,
    index: number,
  ) => Effect.Effect<void> = Effect.fn("board-supervisor-startCiForgeStep")(
    function* (card: BoardCard, runId: string, steps: ReadonlyArray<BoardCiStep>, index: number) {
      const step = steps[index];
      if (step === undefined || step.kind !== "forge-checks") return;
      const { rows } = yield* ciPassSnapshot(card.id, runId);
      const row = ciStepRow(card, rows, index);
      if (row === undefined) return;
      yield* recordCiStep(card.id, runId, index, {
        ...row,
        status: "running",
        startedAt: yield* nowIso,
        note: "Waiting for the pull request's checks",
      });
      forgeSteps.set(String(card.id), {
        runId,
        index,
        startedMs: yield* clockNowMs,
        readied: false,
        errors: 0,
        lastKey: "",
      });
      yield* pollCiForgeStep(card.id);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: CI forge step start failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  /**
   * A pass's failures, read off its row: every failed or timed-out
   * step in order, and the fix issues they make. Null when the row can't be
   * read.
   */
  const ciPassFailures = Effect.fn("board-supervisor-ciPassFailures")(function* (
    cardId: BoardCardId,
    runId: string,
  ) {
    const detail = yield* boardQueries
      .boardCardDetail(cardId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const pass = detail?.ciPasses.find((candidate) => candidate.runId === runId);
    if (pass === undefined) return null;
    const failures: BoardCiFailure[] = [];
    for (const [index, step] of pass.steps.entries()) {
      if (!isBoardCiStepFailure(step.status)) continue;
      const status = step.status === "timed-out" ? "timed-out" : "failed";
      const result = step.result ?? null;
      if (step.kind === "agent" || step.kind === "forge-checks") {
        failures.push({
          runId,
          stepName: step.name,
          command: step.kind === "agent" ? "agent step" : "forge checks",
          status,
          exitCode: null,
          tail: step.tail.length > 0 ? step.tail : (step.note ?? ""),
          logPath: null,
          result,
        });
        continue;
      }
      failures.push({
        runId,
        stepName: step.name,
        command: step.command,
        status,
        exitCode: step.exitCode,
        tail: step.tail,
        logPath: pass.logDir == null ? null : `${pass.logDir}/${index}.log`,
        result,
        headline: step.headline ?? null,
      });
    }
    return { steps: pass.steps, failures, issues: boardCiFixIssues(pass.steps) };
  });

  /**
   * Fail a pass and ask the CI executor what follows, with every
   * failure on the pass row. A row that can't be read, or lists none, falls
   * back to the card's failed steps, then to `fallback`: the executor always
   * gets at least one failure.
   */
  const failCiPass = Effect.fn("board-supervisor-failCiPass")(function* (
    card: BoardCard,
    runId: string,
    fallback?: BoardCiFailure,
    exitCode?: number | null,
  ) {
    const recorded = yield* dispatchLanded({
      type: "board.card.record-ci",
      commandId: yield* commandId("ci-finish"),
      cardId: card.id,
      action: { kind: "finish-pass", runId, result: "failed" },
      createdAt: yield* nowIso,
    });
    if (!recorded) {
      // The sweep holds the pass; this is how it says what happened.
      if (exitCode !== undefined) ciLostResults.set(runId, { exitCode });
      return;
    }
    if (!(yield* ciPassRecordedAs(card.id, runId, "failed"))) return;
    const read = yield* ciPassFailures(card.id, runId);
    if (read !== null && read.failures.length > 0) {
      yield* continueCi({
        cardId: card.id,
        settledStepId: null,
        ciFailures: read.failures,
        ciIssues: read.issues,
        fixThreadId: null,
      });
      return;
    }
    const shellSteps = card.ci?.steps ?? [];
    const fromShell: BoardCiFailure[] = shellSteps.flatMap((step) =>
      isBoardCiStepFailure(step.status)
        ? [
            {
              runId,
              stepName: step.name,
              command: "",
              status: step.status === "timed-out" ? ("timed-out" as const) : ("failed" as const),
              exitCode: null,
              tail: "",
              logPath: null,
            },
          ]
        : [],
    );
    // Issue ids name a step by its index (`s<index>`), so the fallback keeps
    // its step's real index; a failure naming no step gets an id naming none.
    const fallbackIssues = (failure: BoardCiFailure) => {
      const at = shellSteps.findIndex((step) => step.name === failure.stepName);
      if (at < 0) {
        return boardCiFixIssues([{ name: failure.stepName, status: failure.status }]).map(
          (issue) => ({ ...issue, id: issue.id.replace(/^s0/, "ci") }),
        );
      }
      return boardCiFixIssues(
        shellSteps.map((step, index) =>
          index !== at
            ? { name: step.name, status: "passed" as const }
            : {
                name: step.name,
                status: failure.status,
                ...(failure.result == null ? {} : { result: failure.result }),
              },
        ),
      );
    };
    const failures =
      fromShell.length > 0
        ? fromShell
        : [
            fallback ?? {
              runId,
              stepName: "CI",
              command: "",
              status: "failed" as const,
              exitCode: null,
              tail: "",
              logPath: null,
            },
          ];
    yield* continueCi({
      cardId: card.id,
      settledStepId: null,
      ciFailures: failures,
      ciIssues: fromShell.length > 0 ? boardCiFixIssues(shellSteps) : fallbackIssues(failures[0]!),
      fixThreadId: null,
    });
  });

  /** Stop the card in CI for a human, with why. A card with no CI
      entry can't record a stop, so it is held with the reason instead. */
  const stopCiForHuman = Effect.fn("board-supervisor-stopCiForHuman")(function* (
    card: BoardCard,
    reason: string,
    fixThreadId: ThreadId | null,
  ) {
    if (card.ci === null) {
      yield* holdInCi(card, reason);
      return;
    }
    yield* dispatchLanded({
      type: "board.card.record-ci",
      commandId: yield* commandId("ci-stop"),
      cardId: card.id,
      action: {
        kind: "stop",
        runId: card.ci.runId,
        reason,
        finding: "",
        ...(fixThreadId === null ? {} : { fixThreadId }),
      },
      createdAt: yield* nowIso,
    });
  });

  /** Settle a live pass as interrupted and hold the card for a human, with
      why, so Retry CI can start it again. Returns whether the hold landed. */
  const holdCiPass = Effect.fn("board-supervisor-holdCiPass")(function* (
    card: BoardCard,
    runId: string,
    detail: string,
    options: CiHoldOptions = {},
  ) {
    if (forgeSteps.get(String(card.id))?.runId === runId) forgeSteps.delete(String(card.id));
    const reason = withCiRetryHint(detail);
    const held = yield* dispatchLanded({
      type: "board.card.record-ci",
      commandId: yield* commandId("ci-pass-held"),
      cardId: card.id,
      action: {
        kind: "finish-pass",
        runId,
        result: "interrupted",
        reason,
        ...(options.machine === true ? { machine: true } : {}),
        ...(options.headline === undefined ? {} : { headline: options.headline }),
      },
      createdAt: yield* nowIso,
    });
    if (!held) {
      // The sweep holds the pass later; this keeps the hold's own words.
      ciLostResults.set(runId, { hold: { detail, options } });
      return false;
    }
    // A segment started after a Stop's cancel but before its hold landed
    // would otherwise run on the held pass with nothing to stop it.
    if ((yield* cancelCiRun(card.id, runId)) !== null) yield* schedule();
    ciLostResults.delete(runId);
    ciSuspectPasses.delete(String(card.id));
    // A pass replaced or settled meanwhile is left alone by the record, so
    // only a hold that took is noted on the rail.
    const after = (yield* readBoard).cards.find((candidate) => candidate.id === card.id);
    if (after?.ci?.runId !== runId || after.ci.phase !== "held") return false;
    yield* holdInCi(card, reason);
    return true;
  });

  /** Cancel the card's pass fiber only if it is still `runId`'s. */
  const cancelCiRun = (cardId: BoardCardId, runId: string) =>
    Effect.suspend(() =>
      ciPasses.current(cardId) === runId ? ciPasses.cancel(cardId) : Effect.succeed(null),
    );

  /** Whether `runId` is the card's pass and still under way: in CI, live,
      and not yet passed, held or stopped. */
  const isCiPassLive = (
    card: BoardCard,
    runId: string,
  ): card is BoardCard & { readonly ci: BoardCardCi } =>
    card.archivedAt === null &&
    card.stage === BOARD_SEED_STAGE_IDS.ci &&
    card.ci?.runId === runId &&
    !isBoardCiPassSettledPhase(card.ci.phase);

  /** Whether the result just recorded for `runId` took: a Stop or hold that
      landed between the liveness read and the record leaves the card's pass
      settled, and nothing may move it on. */
  const ciPassRecordedAs = (cardId: BoardCardId, runId: string, result: "passed" | "failed") =>
    readCard(cardId).pipe(
      Effect.map((card) =>
        result === "passed"
          ? card !== null &&
            card.archivedAt === null &&
            card.stage === BOARD_SEED_STAGE_IDS.ci &&
            card.ci?.runId === runId &&
            card.ci.phase === "passed"
          : card !== null && isCiPassLive(card, runId),
      ),
    );

  /**
   * Results whose record didn't land, by run id: in memory only, to
   * word the hold the sweep makes. Nothing re-sends them — a resend that
   * keeps failing is its own wedge.
   */
  const ciLostResults = new Map<
    string,
    | { readonly exitCode: number | null }
    | {
        readonly hold: {
          readonly detail: string;
          readonly options: CiHoldOptions;
        };
      }
  >();

  /** Cards the last sweep found with a pass nothing is running, by card, with
      the run it saw. A second sighting of the same run holds it. */
  const ciSuspectPasses = new Map<string, string>();

  /**
   * A pass with nothing behind it: live in CI at `running` or
   * `queued`, with no pass fiber (running, finishing or queued), no CI agent
   * step of this run or fix step still going, and no forge step polling.
   * Terminal step states stay on the card, so only live ones count.
   */
  const isCiPassOrphaned = (board: BoardState, card: BoardCard): boolean => {
    const ci = card.ci;
    if (ci === null || card.archivedAt !== null || card.stage !== BOARD_SEED_STAGE_IDS.ci) {
      return false;
    }
    if (ci.phase !== "running" && ci.phase !== "queued") return false;
    if (ciPasses.current(card.id) !== null) return false;
    if (forgeSteps.get(String(card.id))?.runId === ci.runId) return false;
    const state = boardCardStepState(board, card.id);
    if (state !== null && !isBoardTerminalStepStatus(state.status)) {
      if (parseBoardCiFixStepId(state.stepId) !== null) return false;
      if (parseBoardCiAgentStepId(state.stepId)?.runId === ci.runId) return false;
    }
    return true;
  };

  /** The hold for an orphaned pass: what's known of how it ended. */
  const ciOrphanHold = (runId: string): readonly [string, CiHoldOptions] => {
    const lost = ciLostResults.get(runId);
    if (lost === undefined) return ["The CI run stopped without reporting a result. Retry CI.", {}];
    if ("hold" in lost) return [lost.hold.detail, lost.hold.options];
    const code = lost.exitCode === null ? "" : ` (exit code ${lost.exitCode})`;
    return [`The CI script ended${code} but its result couldn't be saved. Retry CI.`, {}];
  };

  /** Hold every pass that has had nothing behind it on two sweeps in a row.
      One sighting isn't enough: a worktree being readied, an agent
      step settling before the next segment, or a queued result look the same
      for a moment. A hold that doesn't land is tried on the next sweep. */
  const sweepOrphanedCiPasses = Effect.gen(function* () {
    const board = yield* readBoard;
    const seen = new Set<string>();
    for (const card of board.cards) {
      if (!isCiPassOrphaned(board, card)) continue;
      const runId = card.ci!.runId;
      seen.add(String(card.id));
      if (ciSuspectPasses.get(String(card.id)) !== runId) {
        ciSuspectPasses.set(String(card.id), runId);
        continue;
      }
      yield* holdCiPass(card, runId, ...ciOrphanHold(runId));
    }
    for (const cardId of ciSuspectPasses.keys()) {
      if (!seen.has(cardId)) ciSuspectPasses.delete(cardId);
    }
    // A lost result whose pass was retried, skipped or moved on never gets
    // its hold, so it's dropped here.
    const unsettled = new Set(
      board.cards.flatMap((card) =>
        card.ci === null || isBoardCiPassSettledPhase(card.ci.phase) ? [] : [card.ci.runId],
      ),
    );
    for (const runId of ciLostResults.keys()) {
      if (!unsettled.has(runId)) ciLostResults.delete(runId);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: CI orphan sweep failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  /**
   * Read one card's forge checks and act on them. A draft pull request is marked ready first,
   * since draft-gated workflows never run. No pull request, an unreadable forge, or five failed
   * reads in a row hold the card.
   */
  const pollCiForgeStep: (cardId: BoardCardId) => Effect.Effect<void> = Effect.fn(
    "board-supervisor-pollCiForgeStep",
  )(
    function* (cardId: BoardCardId) {
      const entry = forgeSteps.get(String(cardId));
      if (entry === undefined) return;
      const card = yield* readCard(cardId);
      if (card === null || !isCiPassLive(card, entry.runId)) {
        forgeSteps.delete(String(cardId));
        return;
      }
      const { rows, steps } = yield* ciPassSnapshot(card.id, entry.runId);
      const step = steps?.[entry.index];
      const row = ciStepRow(card, rows, entry.index);
      if (
        steps === null ||
        step === undefined ||
        step.kind !== "forge-checks" ||
        row === undefined
      ) {
        forgeSteps.delete(String(cardId));
        return;
      }
      if (card.pullRequest === null || card.pullRequest.state !== "open") {
        yield* holdCiPass(
          card,
          entry.runId,
          `${step.name} waits on the pull request's checks, but the card has no open pull request. Open one, then Retry CI, or Skip CI.`,
        );
        return;
      }
      if (!entry.readied) {
        entry.readied = true;
        yield* markCardPullRequestReady(card, { forMerge: true });
      }
      const probe = yield* probeMergeState(card);
      if (probe.state === null) {
        entry.errors += 1;
        if (entry.errors >= 5) {
          yield* holdCiPass(
            card,
            entry.runId,
            `The pull request's checks couldn't be read${probe.failure === undefined ? "" : ` (${probe.failure})`}. Retry CI, or Skip CI.`,
          );
        }
        return;
      }
      entry.errors = 0;
      const state = probe.state;
      if (state.checksUnread) {
        yield* holdCiPass(
          card,
          entry.runId,
          "This forge doesn't report check results, so the board can't tell when they pass. Skip CI, or replace the forge-checks step.",
        );
        return;
      }
      const checks = boardFilteredMergeChecks(state.checks, step.only);
      const { failing, running } = checks;
      const reading: BoardCiForgeChecksReading = {
        total: checks.total,
        passed: checks.passed,
        pending: checks.pending,
        failed: checks.failed,
        failing,
        running,
        headSha: state.headSha,
      };
      const nowMs = yield* clockNowMs;
      const elapsedMs = nowMs - entry.startedMs;
      const settle = Effect.fn("board-supervisor-settleForgeStep")(
        function* (status: "passed" | "failed" | "timed-out", note: string) {
          forgeSteps.delete(String(cardId));
          const recorded = yield* recordCiStep(card.id, entry.runId, entry.index, {
            ...row,
            status,
            finishedAt: yield* nowIso,
            checks: reading,
            note,
            tail: status === "passed" ? "" : note,
          });
          if (status === "passed" || (recorded && card.ci?.continueOnFailure === true)) {
            yield* runCiSegment(card.id, entry.runId, steps, entry.index + 1);
            return;
          }
          yield* failCiPass(card, entry.runId, {
            runId: entry.runId,
            stepName: row.name,
            command: "forge checks",
            status: status === "timed-out" ? "timed-out" : "failed",
            exitCode: null,
            tail: note,
            logPath: null,
          });
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: forge step settle failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      if (checks.failed > 0) {
        yield* settle(
          "failed",
          `Failing checks: ${failing.join(", ")}${checks.failed > failing.length ? ` and ${checks.failed - failing.length} more` : ""}.`,
        );
        return;
      }
      if (checks.total === 0) {
        if (elapsedMs < step.appearTimeoutMinutes * 60_000) {
          yield* noteCiForgeStep(card, entry, row, reading, "Waiting for checks to appear");
          return;
        }
        yield* settle(
          step.whenNoChecks === "pass" ? "passed" : "failed",
          `No checks appeared within ${step.appearTimeoutMinutes} min${step.whenNoChecks === "pass" ? "; passed as set." : "."}`,
        );
        return;
      }
      if (checks.pending > 0) {
        if (elapsedMs >= step.timeoutMinutes * 60_000) {
          yield* settle(
            "timed-out",
            `Checks still running after ${step.timeoutMinutes} min: ${running.join(", ") || "pending checks"}.`,
          );
          return;
        }
        yield* noteCiForgeStep(
          card,
          entry,
          row,
          reading,
          `Waiting on checks ${checks.passed}/${checks.total}`,
        );
        return;
      }
      yield* settle("passed", `${checks.passed}/${checks.total} checks passed.`);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: forge check poll failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  /** Record a forge step's waiting line, only when it changed. */
  const noteCiForgeStep = Effect.fn("board-supervisor-noteCiForgeStep")(function* (
    card: BoardCard,
    entry: { readonly runId: string; readonly index: number; lastKey: string },
    row: BoardCiPassStep,
    reading: BoardCiForgeChecksReading,
    note: string,
  ) {
    const key = `${note}|${reading.passed}|${reading.total}|${reading.running.join(",")}`;
    if (key === entry.lastKey) return;
    entry.lastKey = key;
    yield* recordCiStep(card.id, entry.runId, entry.index, { ...row, checks: reading, note });
  });

  /** Poll every forge-check step in flight; on the board's sweep tick. */
  const sweepCiForgeSteps = Effect.gen(function* () {
    for (const cardId of forgeSteps.keys()) {
      yield* pollCiForgeStep(cardId as BoardCardId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: forge check poll failed", {
            cardId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  /** A CI agent step reported: its verdict on the pass row, then
      the next step — or, failed, the pass's failure. */
  const finishCiAgentStep: (
    card: BoardCard,
    plan: Extract<BoardStagePlan, { kind: "ci-agent-done" }>,
    threadId: ThreadId | null,
  ) => Effect.Effect<void> = Effect.fn("board-supervisor-finishCiAgentStep")(
    function* (
      card: BoardCard,
      plan: Extract<BoardStagePlan, { kind: "ci-agent-done" }>,
      threadId: ThreadId | null,
    ) {
      if (!isCiPassLive(card, plan.runId)) return;
      const { rows, steps } = yield* ciPassSnapshot(card.id, plan.runId);
      const row = ciStepRow(card, rows, plan.index);
      if (row === undefined || steps === null) return;
      const verdict = plan.verdict;
      const failures = verdict?.failures ?? [];
      const summary =
        verdict === null ? "The agent step finished without a readable verdict." : verdict.summary;
      const passed = verdict?.verdict === "passed";
      const recorded = yield* recordCiStep(card.id, plan.runId, plan.index, {
        ...row,
        status: passed ? "passed" : "failed",
        finishedAt: yield* nowIso,
        result: { summary, failures },
        ...(threadId === null ? {} : { threadId }),
      });
      // Without stop on failure a failed agent step is recorded and
      // the pass carries on; the end of the pass fails it.
      if (passed || (recorded && card.ci.continueOnFailure === true)) {
        yield* runCiSegment(card.id, plan.runId, steps, plan.index + 1);
        return;
      }
      yield* failCiPass(card, plan.runId, {
        runId: plan.runId,
        stepName: row.name,
        command: "agent step",
        status: "failed",
        exitCode: null,
        tail: [summary, ...failures.map((failure) => `- ${failure.title}`)].join("\n"),
        logPath: null,
        result: { summary, failures },
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: CI agent step result failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  /** Back to the review-role stage with the CI failure as a must-fix finding,
      for a fresh round: one more round when the card had used them all. Only
      a human's "Send back to review anyway" reaches it. */
  const sendBackFromCi = Effect.fn("board-supervisor-sendBackFromCi")(function* (
    card: BoardCard,
    input: {
      readonly stepName: string | null;
      readonly finding: string;
      readonly fixThreadId: ThreadId | null;
    },
  ) {
    const board = yield* readBoard;
    const reviewStage = boardStageWithRole(board, "review");
    // A fresh round, through the same override "Another review round" writes:
    // it floors the budget, so a card that used every round gets one more.
    const round =
      boardReviewRoundsStarted({
        completions: boardCardStepCompletions(board, card.id),
        liveStepId: null,
      }) + 1;
    const landed = yield* dispatchLanded({
      type: "board.card.record-ci",
      commandId: yield* commandId("ci-send-back"),
      cardId: card.id,
      action: {
        kind: "send-back",
        runId: card.ci?.runId ?? null,
        stepName: input.stepName,
        finding: input.finding,
        round,
        fixThreadId: input.fixThreadId,
        byHuman: true,
      },
      createdAt: yield* nowIso,
    });
    if (!landed || reviewStage === null) return;
    const opened = yield* openReviewRound({ cardId: card.id, round, reason: "ci-send-back-round" });
    if (!opened) return;
    yield* dispatch({
      type: "board.card.pipeline-move",
      commandId: yield* commandId("ci-send-back-move"),
      cardId: card.id,
      toStage: reviewStage.stageId,
      override: true,
      createdAt: yield* nowIso,
    });
  });

  /** Ask the CI executor what follows, and do it. */
  const continueCi = Effect.fn("board-supervisor-continueCi")(function* (input: {
    readonly cardId: BoardCardId;
    readonly settledStepId: string | null;
    readonly ciFailures: ReadonlyArray<BoardCiFailure> | null;
    readonly ciIssues?: ReadonlyArray<BoardCiFixIssue>;
    readonly fixThreadId: ThreadId | null;
  }) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === input.cardId);
    if (card === undefined || card.archivedAt !== null) return;
    if (card.stage !== BOARD_SEED_STAGE_IDS.ci) return;
    const stage = boardStageById(board, card.stage);
    if (stage === null) return;
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(
      settings,
      card.stage,
      boardProjectStageConfig(board, card.projectId),
    );
    const model = resolveBoardStageModelSelection(exec.model, yield* fallbackModelSelection);
    const plan = stageExecutorFor(stage.role, exec).planNext({
      card,
      config: {
        stepId: card.stage,
        stageLabel: stage.label,
        prompt: exec.prompt,
        model,
        timeoutMs: exec.timeoutMs,
        maxAttempts: exec.maxAttempts,
        runtimeMode: exec.runtimeMode,
        cardOverride: cardStageModelOverride(board, card),
        execution: exec,
      },
      completions: boardCardStepCompletions(board, card.id),
      runState: {
        round: 1,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: input.settledStepId,
        baseStale: false,
        baseRetargetedTo: null,
        ciFailures: input.ciFailures,
        ...(input.ciIssues === undefined ? {} : { ciIssues: input.ciIssues }),
      },
    });
    yield* actOnCiPlan(card, plan, {
      fixThreadId: input.fixThreadId,
      stageLabel: stage.label,
      exec,
      ...(input.ciIssues === undefined ? {} : { fixIssues: input.ciIssues.length }),
    });
  });

  const actOnCiPlan = Effect.fn("board-supervisor-actOnCiPlan")(function* (
    card: BoardCard,
    plan: BoardStagePlan,
    context: {
      readonly fixThreadId: ThreadId | null;
      readonly stageLabel: string;
      readonly exec: ReturnType<typeof resolveBoardStageExecution>;
      /** How many issues a fix plan works on. */
      readonly fixIssues?: number;
    },
  ) {
    switch (plan.kind) {
      case "ci-pass":
        yield* startCiPass(card.id, { fixThreadId: context.fixThreadId });
        return;
      case "ci-agent-done":
        yield* finishCiAgentStep(card, plan, context.fixThreadId);
        return;
      case "ci-stop":
        yield* stopCiForHuman(card, plan.reason, context.fixThreadId);
        return;
      case "run": {
        if (card.ci === null) return;
        const began = yield* dispatchLanded({
          type: "board.card.record-ci",
          commandId: yield* commandId("ci-begin-fix"),
          cardId: card.id,
          action: {
            kind: "begin-fix",
            runId: card.ci.runId,
            ...(context.fixIssues === undefined ? {} : { fixIssues: context.fixIssues }),
          },
          createdAt: yield* nowIso,
        });
        if (!began) return;
        const board = yield* readBoard;
        const selected = yield* dispatchLanded({
          type: "board.card.select-step",
          commandId: yield* commandId("select-step"),
          cardId: card.id,
          stepId: plan.stepId,
          stepLabel: plan.stepLabel,
          stageLabel: context.stageLabel,
          prompt: plan.prompt,
          providerInstanceId: plan.model.instanceId,
          model: plan.model.model,
          runtimeMode: plan.runtimeMode,
          ...(plan.model.options === undefined ? {} : { modelOptions: plan.model.options }),
          mode: "build",
          humanInLoop: false,
          maxAttempts: plan.maxAttempts,
          timeoutMs: plan.timeoutMs,
          priorRecoveries: boardStageEntryRecoveryCount(board, card.id),
          baseTipAtRoundStart: yield* baseTipForPlan(card, false),
          createdAt: yield* nowIso,
        });
        if (!selected) return;
        yield* provisionPlacedBuildStep(card.id);
        yield* schedule();
        return;
      }
      default:
        return;
    }
  });

  /** A pass's fiber finished: record it, then move on or fix. */
  const handleCiPassFinished = (finished: BoardCiPassFinished) =>
    // Handled once, by the launch's token; a duplicate report, or one
    // from a launch cancelled since, finds nothing to claim. The entry stays
    // until this is done, so the sweep never mistakes it for a dead pass.
    Effect.suspend(() =>
      ciPasses.claim(finished.cardId, finished.token)
        ? handleClaimedCiPass(finished).pipe(
            Effect.ensuring(Effect.sync(() => ciPasses.settle(finished.cardId, finished.token))),
          )
        : Effect.void,
    );

  const handleClaimedCiPass = Effect.fn("board-supervisor-handleClaimedCiPass")(function* (
    finished: BoardCiPassFinished,
  ) {
    // The slot it held is free for the next queued pass or step.
    yield* schedule();
    const card = yield* readCard(finished.cardId);
    // A pass the card has since left, replaced, held or stopped reports
    // nothing more.
    if (card === null || !isCiPassLive(card, finished.runId) || card.ci === null) return;
    if (finished.outcome.result === "unavailable") {
      yield* holdCiPass(
        card,
        finished.runId,
        finished.outcome.detail,
        finished.outcome.machine === true ? { machine: true } : {},
      );
      return;
    }
    const passed = finished.outcome.result === "passed";
    if (passed) {
      // A segment passed; the pass goes on from its next step.
      const { steps } = yield* ciPassSnapshot(card.id, finished.runId);
      if (steps === null) {
        // Without its frozen steps the pass can't tell what comes next, and
        // passing it would skip any later agent or forge step.
        yield* holdCiPass(
          card,
          finished.runId,
          "CI lost track of this pass's steps. Retry CI, or Skip CI.",
        );
        return;
      }
      yield* runCiSegment(card.id, finished.runId, steps, finished.segmentEnd);
      return;
    }
    // A machine problem is held for a human before any failure is
    // recorded, so no fix agent starts and no fix or round trip is used.
    const verdict = finished.outcome.headline;
    if (verdict?.machine === true) {
      const board = yield* readBoard;
      const workerId = boardCardEffectiveWorkerId(card, board.defaultWorkerId);
      const where =
        workerId === BOARD_LOCAL_WORKER_ID
          ? boardCiHostName()
          : ((board.workers ?? []).find((worker) => worker.id === workerId)?.label ??
            String(workerId));
      yield* holdCiPass(card, finished.runId, boardCiMachineHoldReason(verdict, where), {
        machine: true,
        headline: verdict,
      });
      return;
    }
    const index = finished.outcome.failedIndex ?? -1;
    const fallback: BoardCiFailure = {
      runId: finished.runId,
      stepName: card.ci.steps[index]?.name ?? "CI",
      command: "",
      status: "failed",
      exitCode: null,
      tail: "",
      logPath: null,
      headline: verdict ?? null,
    };
    // Without stop on failure, a segment that ran every step carries
    // on — but only when its failure is on the pass record, so a lost step
    // record never turns a failed pass into a passed one.
    if (card.ci.continueOnFailure === true && finished.outcome.ranAll) {
      const { steps } = yield* ciPassSnapshot(card.id, finished.runId);
      const read = yield* ciPassFailures(card.id, finished.runId);
      const status = read?.steps[index]?.status;
      if (steps !== null && status !== undefined && isBoardCiStepFailure(status)) {
        yield* runCiSegment(card.id, finished.runId, steps, finished.segmentEnd);
        return;
      }
    }
    yield* failCiPass(card, finished.runId, fallback, finished.outcome.exitCode ?? null);
  });

  /** A card left CI (any move): stop its pass. The move itself settled the
      pass row as cancelled. */
  const stopCiOnLeave = Effect.fn("board-supervisor-stopCiOnLeave")(function* (card: BoardCard) {
    if ((yield* ciPasses.cancel(card.id)) === null) return;
    yield* schedule();
  });

  /** A card archived while in CI: stop its pass (a queued one never starts)
      and settle its row as cancelled, since no move will. */
  const stopCiOnArchive = Effect.fn("board-supervisor-stopCiOnArchive")(function* (
    card: BoardCard,
  ) {
    const stopped = yield* ciPasses.cancel(card.id);
    const ci = card.ci;
    if (ci !== null && !isBoardCiPassSettledPhase(ci.phase)) {
      yield* dispatch({
        type: "board.card.record-ci",
        commandId: yield* commandId("ci-archived"),
        cardId: card.id,
        action: { kind: "finish-pass", runId: ci.runId, result: "cancelled" },
        createdAt: yield* nowIso,
      });
    }
    if (stopped !== null) yield* schedule();
  });

  /** Skip CI (a human's override): stop any pass or fix agent, record who
      skipped it, and move the card to the next stage. */
  const skipCi = Effect.fn("board-supervisor-skipCi")(function* (
    cardId: BoardCardId,
    stamp: (command: BoardCommand) => Effect.Effect<void>,
  ) {
    const card = yield* readCard(cardId);
    if (card === null || card.archivedAt !== null) return { outcome: "unknown-card" } as const;
    if (card.stage !== BOARD_SEED_STAGE_IDS.ci) return { outcome: "not-in-ci" } as const;
    // Stopped first, quietly: the skip below settles the pass as skipped.
    yield* ciPasses.cancel(card.id);
    const command: BoardCommand = {
      type: "board.card.record-ci",
      commandId: yield* commandId("ci-skip"),
      cardId: card.id,
      action: { kind: "skip", actor: "You" },
      createdAt: yield* nowIso,
    };
    yield* stamp(command);
    const actor = boardActivityActorFor(command.commandId);
    const skip: BoardCommand = {
      ...command,
      action: { kind: "skip", actor: actor.name ?? BOARD_HUMAN_ACTOR_FALLBACK_NAME },
    };
    if (!(yield* dispatchLanded(skip))) return { outcome: "failed" } as const;
    const board = yield* readBoard;
    const next = boardNextStageId(board, BOARD_SEED_STAGE_IDS.ci, card.projectId);
    if (next !== null) {
      const move: BoardCommand = {
        type: "board.card.pipeline-move",
        commandId: yield* commandId("ci-skip-move"),
        cardId: card.id,
        toStage: next,
        createdAt: yield* nowIso,
      };
      yield* stamp(move);
      if (!(yield* dispatchLanded(move))) return { outcome: "failed" } as const;
    }
    yield* schedule();
    return { outcome: "skipped", toStage: next } as const;
  });

  /**
   * Retry CI: a human's restart of a stopped or held card. From
   * stopped it is a fresh start — new fix attempts, no round trips; from held
   * the count is kept. Refused while the project's CI is off.
   */
  const retryCi = Effect.fn("board-supervisor-retryCi")(function* (cardId: BoardCardId) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || card.archivedAt !== null) return { outcome: "unknown-card" } as const;
    if (card.stage !== BOARD_SEED_STAGE_IDS.ci) return { outcome: "not-in-ci" } as const;
    if (!isBoardCiSwitchedOn(board, card.projectId)) return { outcome: "ci-off" } as const;
    // A pass with nothing behind it can be retried before the sweep
    // holds it; the new pass settles its row as interrupted.
    if (
      card.ci !== null &&
      !isBoardCiPassSettledPhase(card.ci.phase) &&
      !isCiPassOrphaned(board, card)
    ) {
      return { outcome: "running" } as const;
    }
    yield* startCiPass(card.id, { fixThreadId: null, fresh: card.ci?.phase === "stopped" });
    return { outcome: "retried" } as const;
  });

  /**
   * Stop CI: a human's stop of a queued, running or fixing pass. Its
   * fiber is cancelled, a CI agent or fix step is abandoned and its turn
   * interrupted, a forge step stops polling, and the pass is held. Retry CI
   * runs it again.
   */
  const stopCi = Effect.fn("board-supervisor-stopCi")(function* (cardId: BoardCardId) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || card.archivedAt !== null) return { outcome: "unknown-card" } as const;
    if (card.stage !== BOARD_SEED_STAGE_IDS.ci) return { outcome: "not-in-ci" } as const;
    if (card.ci === null || isBoardCiPassSettledPhase(card.ci.phase)) {
      return { outcome: "not-running" } as const;
    }
    const runId = card.ci.runId;
    const cancelled = yield* ciPasses.cancel(card.id);
    const state = boardCardStepState(board, card.id);
    if (
      state !== null &&
      !isBoardTerminalStepStatus(state.status) &&
      (parseBoardCiFixStepId(state.stepId) !== null ||
        parseBoardCiAgentStepId(state.stepId)?.runId === runId)
    ) {
      yield* settleStep({ card, state, outcome: "abandoned" });
      if (state.status !== "stalled" && state.status !== "paused" && state.threadId !== null) {
        yield* interruptOrphan(state.threadId);
        // Named so its interrupt is not read as a human Stop of the step.
        abandonedThreads.add(String(state.threadId));
      }
    }
    forgeSteps.delete(String(card.id));
    const held = yield* holdCiPass(card, runId, BOARD_CI_STOPPED_BY_YOU_REASON);
    if (cancelled !== null || state !== null) yield* schedule();
    if (held) return { outcome: "stopped" } as const;
    // The pass finished or was replaced before the stop's record landed.
    const after = (yield* readBoard).cards.find((candidate) => candidate.id === cardId);
    return after?.ci?.runId === runId && !isBoardCiPassSettledPhase(after.ci.phase)
      ? ({ outcome: "failed" } as const)
      : ({ outcome: "not-running" } as const);
  });

  /** A CI action's answer, with a fault answered as `failed`. */
  const answerCiAction = <E>(
    action: "retry" | "stop",
    cardId: BoardCardId,
    effect: Effect.Effect<BoardCiActionResult, E>,
  ): Effect.Effect<BoardCiActionResult> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`board supervisor: ${action} CI failed`, {
          cardId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({ outcome: "failed" } as const)),
      ),
    );

  /** "Send back to review anyway", from a stopped card. */
  const ciSendBack = Effect.fn("board-supervisor-ciSendBack")(function* (cardId: BoardCardId) {
    const card = yield* readCard(cardId);
    if (card === null || card.archivedAt !== null) return { outcome: "unknown-card" } as const;
    if (card.stage !== BOARD_SEED_STAGE_IDS.ci) return { outcome: "not-in-ci" } as const;
    if (card.ci === null || !isBoardCiPassSettledPhase(card.ci.phase)) {
      return { outcome: "running" } as const;
    }
    if (card.ci.phase !== "stopped") return { outcome: "not-stopped" } as const;
    yield* ciPasses.cancel(card.id);
    const failed = card.ci.steps.find((step) => isBoardCiStepFailure(step.status));
    const read = yield* ciPassFailures(card.id, card.ci.runId);
    yield* sendBackFromCi(card, {
      stepName: failed?.name ?? null,
      finding:
        read !== null && read.failures.length > 0
          ? boardCiSendBackFinding(read.failures)
          : (card.ci.stopReason ?? "A human sent the card back from CI."),
      fixThreadId: null,
    });
    return { outcome: "sent-back" } as const;
  });

  /** Boot: a pass the restart cut off is marked interrupted and runs
      again from the top; one that passed but never moved the card moves it.
      A held pass stays held. */
  const recoverCiPasses = Effect.fn("board-supervisor-recoverCiPasses")(function* () {
    const board = yield* readBoard;
    for (const card of board.cards) {
      if (card.archivedAt !== null || card.stage !== BOARD_SEED_STAGE_IDS.ci) continue;
      if (ciPasses.current(card.id) !== null) continue;
      const state = boardCardStepState(board, card.id);
      if (state !== null && !isBoardTerminalStepStatus(state.status)) continue;
      if (card.ci?.phase === "passed") {
        yield* advanceFromCi(card);
        continue;
      }
      // A fix agent's step that ended without a verdict is the ordinary
      // failed step's business (retry, then amber), not a restart's; a held
      // pass waits for a human to restart or skip it.
      if (
        card.ci?.phase === "fixing" ||
        card.ci?.phase === "held" ||
        card.ci?.phase === "stopped"
      ) {
        continue;
      }
      yield* startCiPass(card.id, { fixThreadId: null });
    }
  });

  /**
   * Start every child of a started split that the plan graph no longer blocks, each by an
   * ordinary adjacent `board.card.move` from the floor into build, so `handleCardMoved` treats
   * it like a drag (and it queues when no slot is free). Called again as each child finishes,
   * so a chain walks itself. `handleCardCreated` still never starts a materialised child.
   */
  const cascadeUnblockedChildren = Effect.fn("board-supervisor-cascadeChildren")(function* (
    parentCardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const parent = board.cards.find((candidate) => candidate.id === parentCardId);
    if (parent === undefined || parent.archivedAt !== null) return;
    const group = boardCardGroupOf(board, parent);
    // Only a group with auto-build on starts its own children; one
    // with it off is started child by child.
    if (group === null || !group.autoBuild) return;
    const buildStage = boardStageWithRole(board, "build");
    const floor = boardSubBoardFloorStage(board);
    if (buildStage === null || floor === null) return;
    // Only once the group has BEGUN (`started`, set when a human starts the group or moves a
    // child into build; never by a child's own Auto-build). After that the group runs to
    // completion wherever it is parked, so dragging it back must not strand freed siblings.
    if (!group.started) return;
    for (const child of boardCardActiveChildren(board, parent.id)) {
      // Waiting on the floor is the only state this starts. A child further
      // along is already running, done, or parked somewhere by a human — and
      // none of those want a move. A child group on the floor is started the
      // same way, and its own arrival cascades one level down.
      if (child.stage !== floor.stageId) continue;
      // One mover per card: a child with its own Auto-build value is
      // the due check's (own on) or stays put (own off).
      if (child.autoBuildSetting !== null) continue;
      // The dependency gate would refuse this move anyway; skipping it
      // here keeps the cascade from teaching the rule by refusal.
      const unmet = unmetBoardCardDependencies({
        board,
        dependsOn: boardCardInheritedDependsOn(board, child),
        cards: board.cards,
      });
      if (unmet.length > 0) continue;
      yield* dispatch({
        type: "board.card.move",
        commandId: yield* commandId("cascade-child"),
        cardId: child.id,
        toStage: buildStage.stageId,
        createdAt: yield* nowIso,
      });
    }
  });

  /**
   * Grouping never touches git: a card that became a group abandons its live step, and a card
   * that landed in a started group with auto-build on may start right away.
   */
  const applyRegroup = Effect.fn("board-supervisor-applyRegroup")(function* (
    updated: BoardCard,
    marks: { readonly becameGroup: boolean; readonly regrouped: boolean },
  ) {
    if (!marks.becameGroup && !marks.regrouped) return;
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === updated.id);
    if (card === undefined || card.archivedAt !== null) return;
    if (marks.becameGroup) {
      const state = boardCardStepState(board, card.id);
      if (state !== null && !isBoardTerminalStepStatus(state.status)) {
        yield* settleStep({ card, state, outcome: "abandoned" });
        yield* schedule();
      }
    }
    if (marks.regrouped) {
      // A new parent changes what the card inherits, so its toggles
      // take effect as if its group's had changed — leaving a group mid
      // auto-plan stops the run.
      yield* reevaluateCardAutomation(card.id, { group: true });
      // Only a card that just landed in a group may start; any other edit must
      // not restart a child a human parked on the floor.
      if (card.parentCardId !== null) yield* cascadeUnblockedChildren(card.parentCardId);
    }
  });

  /** Cascade every group holding a card that waits on `cardId`, directly or
      through a group it sits in. */
  const cascadeDependentGroups = Effect.fn("board-supervisor-cascadeDependentGroups")(function* (
    cardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const parents = new Set<BoardCardId>();
    for (const candidate of board.cards) {
      if (candidate.archivedAt !== null || candidate.parentCardId === null) continue;
      if (boardCardInheritedDependsOn(board, candidate).includes(cardId)) {
        parents.add(candidate.parentCardId);
      }
    }
    for (const parentId of parents) yield* cascadeUnblockedChildren(parentId);
  });

  /**
   * Heal a group out of step with its children. The decider derives
   * every group in the same decision as the child change, so this normally
   * finds nothing; it catches an event the decider did not shape — a boot
   * after migration, a legacy log — by asking the decider to re-derive.
   */
  const syncAncestorGroups = Effect.fn("board-supervisor-syncAncestorGroups")(function* (
    cardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined) return;
    const stale = [card, ...boardCardAncestors(board, card)].some((candidate) => {
      if (candidate.archivedAt !== null) return false;
      const group = boardCardGroupOf(board, candidate);
      if (group === null) return false;
      if (boardCardLiveChildren(board, candidate.id).length === 0) {
        return boardGroupRevertsToCard(board, candidate, group);
      }
      return deriveBoardGroupStage(board, candidate) !== candidate.stage;
    });
    if (!stale) return;
    yield* dispatch({
      type: "board.card.sync-groups",
      commandId: yield* commandId("sync-groups"),
      cardId: card.id,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Whether this card's merge runs itself, reading the board-wide
   * merge-stage setting the shared predicate cannot see for itself.
   */
  const cardAutoMergeArmed = Effect.fn("board-supervisor-cardAutoMergeArmed")(function* (
    card: BoardCard,
  ) {
    const board = yield* readBoard;
    const mergeStage = boardStageWithRole(board, "merge");
    if (mergeStage === null) return false;
    const exec = resolveBoardStageExecution(
      yield* boardSettings,
      mergeStage.stageId,
      boardProjectStageConfig(board, card.projectId),
    );
    return boardCardAutoMergeArmed({
      board,
      card,
      boardWide: isBoardMergeStageExecution(exec) ? exec.autoMerge : false,
    });
  });

  /**
   * Write or clear a card's auto-merge hold. `dispatchOptional`, because the sweep re-probes
   * held cards and a refusal here is the decider's no-op guard, not a fault.
   */
  const recordAutoMergeHold = Effect.fn("board-supervisor-recordAutoMergeHold")(function* (
    cardId: BoardCardId,
    hold: BoardCardAutoMergeHold | null,
  ) {
    yield* dispatchOptional({
      type: "board.card.record-auto-merge-hold",
      commandId: yield* commandId("auto-merge-hold"),
      cardId,
      hold,
      createdAt: yield* nowIso,
    });
  });

  /** Clear a hold that is no longer about anything. Cheap and
      guarded: a card with no hold dispatches nothing at all. */
  const clearAutoMergeHold = (card: BoardCard) =>
    card.autoMergeHold === null ? Effect.void : recordAutoMergeHold(card.id, null);

  /**
   * Merge an ARMED card on arrival at the merge-role stage or on a retry rung. An armed card's
   * merge was initiated by a human (Begin build, a per-card arm, or board policy); an unarmed
   * card still waits for a click. A refusal is classified against a structured probe, never the
   * forge's prose, and either climbs the retry ladder or stops with the reason on the card.
   */
  /**
   * Armed cards skipped because they were BLOCKED when their turn came, so the sweep can retry
   * them once unblocked without merging every armed card parked here. In-memory: after a
   * restart the card waits for a click, never a merge nobody asked for.
   */
  const autoMergeDeferredUntilUnblocked = new Set<string>();

  const autoMergeCard = Effect.fn("board-supervisor-autoMergeCard")(function* (card: BoardCard) {
    // A blocked card already shows the callout naming its dependency, so no hold and no rung
    // are recorded. The skip is remembered so the sweep revisits it once the dependency lands.
    if (card.blocked) {
      autoMergeDeferredUntilUnblocked.add(String(card.id));
      return;
    }
    autoMergeDeferredUntilUnblocked.delete(String(card.id));
    const outcome = yield* mergeCardPullRequest(card.id);
    yield* recordAutoMergeOutcome(card.id, outcome, { resetLadder: false });
  });

  /**
   * Fold a merge attempt's outcome into the card's hold, for both the armed path and the Merge
   * click. The click passes `resetLadder`: a human intervened, so the ladder starts over.
   */
  const recordAutoMergeOutcome = Effect.fn("board-supervisor-recordAutoMergeOutcome")(function* (
    cardId: BoardCardId,
    outcome: Effect.Success<ReturnType<typeof mergeCardPullRequest>>,
    options: { readonly resetLadder: boolean },
  ) {
    const fresh = yield* readCard(cardId);
    if (fresh === null) return;

    switch (outcome.outcome) {
      // Landed: the merge advanced the card to Done, so a hold about it is a
      // stale label.
      case "merged":
        yield* clearAutoMergeHold(fresh);
        return;
      // Another path owns the merge now (a running conflict fix, or a stale base sent back to
      // review), so a hold would describe something that is not happening.
      case "conflict":
      case "checks-fix":
      case "stale-base":
        yield* clearAutoMergeHold(fresh);
        return;
      // Not a state this feature governs — the card is not where it thought it
      // was. No hold recorded and none cleared: a label about a merge that was
      // never attempted here would be a claim the user cannot act on.
      case "wrong-stage":
      case "no-workspace":
      case "unknown-card":
        return;
      default:
        break;
    }

    // Structural outcomes skip the probe: retrying cannot succeed. A refusal the gateway
    // already knows is permanent (an unsupported strategy, a missing permission) joins them.
    const structural =
      outcome.outcome === "not-open"
        ? `Its pull request is ${outcome.state}, so there was nothing to merge.`
        : outcome.outcome === "no-pull-request"
          ? "It has no pull request to merge."
          : outcome.outcome === "refused" && outcome.permanent === true
            ? outcome.detail
            : null;

    const previous = fresh.autoMergeHold;
    const verdict =
      structural !== null
        ? { classification: "other" as const, detail: null, headSha: previous?.headSha ?? null }
        : probeMergeRefusal(outcome.outcome === "refused" ? (outcome.mergeState ?? null) : null);
    const step = boardAutoMergeLadderStep({
      classification: verdict.classification,
      previousAttempt: options.resetLadder ? 0 : (previous?.attempt ?? 0),
      previousHeadSha: options.resetLadder ? null : (previous?.headSha ?? null),
      headSha: verdict.headSha,
    });
    const nowMs = yield* clockNowMs;
    const reason =
      structural ??
      (outcome.outcome === "refused" ? outcome.detail : "The forge refused the merge.");
    // `heldSince` survives every rung: the board pill's clock measures the
    // whole wait, not the time since the last retry. It restarts only when the
    // ladder itself does — a new head sha, or a human click.
    const heldSince =
      previous !== null && step.attempt > 1
        ? previous.heldSince
        : DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const hold: BoardCardAutoMergeHold = {
      reason: boundedHoldReason(reason),
      classification: verdict.classification,
      detail: verdict.detail,
      attempt: step.attempt,
      heldSince,
      retryAt:
        step.retryDelayMs === null ? null : isoAfter(nowMs, yield* jittered(step.retryDelayMs)),
      headSha: verdict.headSha ?? previous?.headSha ?? null,
    };
    yield* recordAutoMergeHold(fresh.id, hold);

    // One rail row, when the ladder actually stops, and not again if it had already stopped.
    // A human's click reports through its return value instead.
    if (!options.resetLadder && hold.retryAt === null && previous?.retryAt !== null) {
      yield* dispatch({
        type: "board.card.record-note",
        commandId: yield* commandId("auto-merge-refused"),
        cardId: fresh.id,
        kind: "card-merge-refused",
        detail: `Held the merge. ${reason}`,
        createdAt: yield* nowIso,
      });
    }
  });

  /**
   * The Merge button. Live throughout a hold, as the escape hatch. A success clears the hold;
   * a refusal on an ARMED card re-records it with the ladder reset to rung 0. An unarmed card
   * records nothing: the refusal goes back to the waiting human.
   */
  const mergeCardPullRequestByHand = Effect.fn("board-supervisor-mergeCardPullRequestByHand")(
    function* (cardId: BoardCardId) {
      // A human's click buys one more automatic CI fix, and is a
      // fresh decision: an unarmed card's wait on its last fix's checks ends.
      checksFixSpent.delete(String(cardId));
      mergeAwaitingChecks.delete(String(cardId));
      // A pull request readied within the ladder's first rung has CI that may
      // not have registered its checks yet, so the click waits on the ladder
      // just as the arrival and merge-path readies do.
      const readiedAtMs = readiedAt.get(String(cardId));
      const recentlyReadied =
        readiedAtMs !== undefined &&
        (yield* clockNowMs) - readiedAtMs < BOARD_AUTO_MERGE_RETRY_DELAYS_MS[0];
      if (!recentlyReadied) readiedAt.delete(String(cardId));
      const recentPullRequest = recentlyReadied
        ? ((yield* readCard(cardId))?.pullRequest ?? null)
        : null;
      let outcome: BoardMergeAttemptResult;
      if (recentPullRequest !== null && recentPullRequest.state === "open") {
        mergeAwaitingChecks.add(String(cardId));
        outcome = justReadiedRefusal(recentPullRequest.number);
      } else {
        outcome = yield* mergeCardPullRequest(cardId);
      }
      const card = yield* readCard(cardId);
      if (
        card !== null &&
        (card.autoMergeHold !== null ||
          mergeAwaitingChecks.has(String(cardId)) ||
          (yield* cardAutoMergeArmed(card)))
      ) {
        yield* recordAutoMergeOutcome(cardId, outcome, { resetLadder: true });
      }
      return outcome;
    },
  );

  /**
   * Merge a card whose arm was just switched on, if it is sitting at the merge
   * stage with a pull request and nothing else running.
   *
   * Re-reads the card rather than trusting the event's copy: the arm is a
   * human click, and what it does is irreversible.
   */
  const autoMergeArmedCard = Effect.fn("board-supervisor-autoMergeArmedCard")(function* (
    cardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || card.archivedAt !== null) return;
    if (boardStageWithRole(board, "merge")?.stageId !== card.stage) return;
    const liveStep = boardCardStepState(board, card.id);
    if (liveStep !== null && !isBoardTerminalStepStatus(liveStep.status)) return;
    if (hasLiveStageThread(card, card.stage)) return;
    yield* autoMergeCard(card);
  });

  /** A held descendant with no strategy of its own, nor any group between it
      and this one, merged with this card's, so a change here
      releases it the same way a change to its own would: hold cleared, and
      the merge re-attempted now. */
  const releaseInheritingChildHolds = Effect.fn("board-supervisor-releaseInheritingChildHolds")(
    function* (groupId: BoardCardId) {
      const board = yield* readBoard;
      for (const descendant of board.cards) {
        if (descendant.mergeStrategy !== null || descendant.autoMergeHold === null) continue;
        const ancestors = boardCardAncestors(board, descendant);
        const at = ancestors.findIndex((ancestor) => ancestor.id === groupId);
        if (at === -1 || ancestors.slice(0, at).some((between) => between.mergeStrategy !== null)) {
          continue;
        }
        yield* clearAutoMergeHold(descendant);
        if (
          (yield* cardAutoMergeArmed(descendant)) ||
          mergeAwaitingChecks.has(String(descendant.id))
        ) {
          yield* autoMergeArmedCard(descendant.id);
        }
      }
    },
  );

  /**
   * Classify why the forge refused. A probe that failed is soft: an unreadable answer costs a
   * few retries and never produces a hard verdict.
   */
  const probeMergeRefusal = (state: BoardMergeState | null): BoardAutoMergeVerdict =>
    state === null ? UNCLASSIFIED_AUTO_MERGE_VERDICT : classifyBoardAutoMergeRefusal(state);

  // A step succeeded: the stage executor decides what runs next. `complete` advances the card;
  // a `run` plan (the review loop's next step) re-enters select-step, schedule, spawn. A
  // terminal loop outcome leaves the card put with its completions visible.
  const continueStage = Effect.fn("board-supervisor-continueStage")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
  }) {
    const { card, state } = input;
    const board = yield* readBoard;
    const stage = boardStageById(board, card.stage);
    if (stage === null) return;
    // The step in `state` just settled `succeeded`; we do not re-guard on its
    // status (a fresh read may not yet reflect the settle). A genuine live-step
    // race is caught by the decider's select-step invariant, whose reject the
    // dispatch helper swallows.
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(
      settings,
      card.stage,
      boardProjectStageConfig(board, card.projectId),
    );
    const completions = boardCardStepCompletions(board, card.id);
    const model = resolveBoardStageModelSelection(exec.model, yield* fallbackModelSelection);
    const cardOverride = cardStageModelOverride(board, card);
    const completedStepIds = completions
      .filter((completion) => completion.outcome === "succeeded")
      .map((completion) => completion.stepId);
    const plan = stageExecutorFor(stage.role, exec).planNext({
      card,
      config: {
        stepId: card.stage,
        stageLabel: stage.label,
        prompt: exec.prompt,
        model,
        timeoutMs: exec.timeoutMs,
        maxAttempts: exec.maxAttempts,
        runtimeMode: exec.runtimeMode,
        cardOverride,
        execution: exec,
      },
      completions,
      // The step in `state` has just SETTLED, so nothing is in flight; its
      // round is already counted through its recorded completion. Which step
      // it was is the build executor's routing signal.
      runState: {
        round: 1,
        completedStepIds,
        liveStepId: null,
        settledStepId: state.stepId,
        baseStale: yield* resolveBaseStale(card),
        baseRetargetedTo: yield* resolveBaseRetargetTarget(card),
      },
    });
    switch (plan.kind) {
      case "run": {
        // Only auto-execute a stage that opts in. A step that finishes after its card was dragged
        // elsewhere would otherwise plan a spurious `run` in the destination stage. Gating only the
        // `run` arm keeps a manual stage's `complete` auto-advance intact.
        if (!exec.autoExecute) return;
        // A continuation is executor-driven, never a human re-entry: inject the
        // planned prompt and honour the stage's own human-in-the-loop stance.
        const humanInLoop = resolveHumanInLoop(board, settings, card, exec);
        yield* dispatch({
          type: "board.card.select-step",
          commandId: yield* commandId("select-step"),
          cardId: card.id,
          stepId: plan.stepId,
          stepLabel: plan.stepLabel,
          stageLabel: stage.label,
          prompt: plan.prompt,
          providerInstanceId: plan.model.instanceId,
          model: plan.model.model,
          runtimeMode: plan.runtimeMode,
          ...(plan.model.options === undefined ? {} : { modelOptions: plan.model.options }),
          mode: exec.mode,
          humanInLoop,
          maxAttempts: plan.maxAttempts,
          timeoutMs: plan.timeoutMs,
          // Carry the stage entry's recovery total forward: one step-state row per card, so
          // resetting it per phase would multiply the runaway ceiling. `attempt` is not carried.
          priorRecoveries: boardStageEntryRecoveryCount(board, card.id),
          // Measured fresh when this plan starts a review round, carried
          // forward otherwise.
          baseTipAtRoundStart: yield* baseTipForPlan(card, plan.recordBaseTip),
          createdAt: yield* nowIso,
        });
        if (exec.mode === "build") yield* provisionPlacedBuildStep(card.id);
        return;
      }
      case "complete": {
        // Only a SUCCESSFUL stage may auto-advance (for the review loop, a converged round). A
        // broken payload, a stopped loop, or a loop out of rounds with findings open leaves the
        // card put with its findings visible.
        if (plan.outcome === "succeeded") {
          yield* advanceStage({
            card,
            state,
            ...(plan.advanceToRole === undefined ? {} : { toRole: plan.advanceToRole }),
          });
        }
        return;
      }
      // CI: a fix agent reported — re-run every step, or stop
      // for a human.
      case "ci-pass":
      case "ci-stop":
      case "ci-agent-done":
        yield* actOnCiPlan(card, plan, {
          fixThreadId: state.threadId,
          stageLabel: stage.label,
          exec,
        });
        return;
      case "escalate": {
        // The executor wants a human. Leave the card put (there is no live step to gate); the
        // question goes to the server log.
        yield* Effect.logWarning("board supervisor: stage executor escalated to a human", {
          cardId: card.id,
          stepId: state.stepId,
          question: plan.question,
        });
        return;
      }
    }
  });

  /**
   * Ask a SETTLED stage's executor whether an edit gave it more to run (a raised round cap),
   * and start that step. Acts only on a `run` plan: routing `complete` into `advanceStage` would
   * let any edit re-advance a graduated card. `resume` leaves base staleness unmeasured, so a
   * resume never plans a rebase-and-force-push sync the loop did not already owe.
   */
  const replanSettledStage = Effect.fn("board-supervisor-replanSettledStage")(function* (
    card: BoardCard,
    options: { readonly resume?: boolean } = {},
  ) {
    const board = yield* readBoard;
    const stage = boardStageById(board, card.stage);
    if (stage === null) return;
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(
      settings,
      card.stage,
      boardProjectStageConfig(board, card.projectId),
    );
    // Same gate as every other spawn path: a stage the user drives by hand is
    // not started by an edit.
    if (!exec.autoExecute) return;
    // Never trample a manually adopted thread for this stage — the same guard
    // `beginStageRun` applies, and this path needs it for the same reason.
    if (hasLiveStageThread(card, card.stage)) return;
    const completions = boardCardStepCompletions(board, card.id);
    const model = resolveBoardStageModelSelection(exec.model, yield* fallbackModelSelection);
    const cardOverride = cardStageModelOverride(board, card);
    const completedStepIds = completions
      .filter((completion) => completion.outcome === "succeeded")
      .map((completion) => completion.stepId);
    const plan = stageExecutorFor(stage.role, exec).planNext({
      card,
      config: {
        stepId: card.stage,
        stageLabel: stage.label,
        prompt: exec.prompt,
        model,
        timeoutMs: exec.timeoutMs,
        maxAttempts: exec.maxAttempts,
        runtimeMode: exec.runtimeMode,
        cardOverride,
        execution: exec,
      },
      completions,
      // The stage is settled, so nothing of this card's is in flight — and no
      // step is settling right now either: this is a re-plan off a card EDIT,
      // not off a completion, so a card whose submit step succeeded long ago
      // must not be routed again by an unrelated title change.
      runState: {
        round: 1,
        completedStepIds,
        liveStepId: null,
        settledStepId: null,
        baseStale: options.resume === true ? false : yield* resolveBaseStale(card),
        baseRetargetedTo: yield* resolveBaseRetargetTarget(card),
      },
    });
    if (plan.kind !== "run") return;
    yield* dispatch({
      type: "board.card.select-step",
      commandId: yield* commandId("select-step"),
      cardId: card.id,
      stepId: plan.stepId,
      stepLabel: plan.stepLabel,
      stageLabel: stage.label,
      prompt: plan.prompt,
      providerInstanceId: plan.model.instanceId,
      model: plan.model.model,
      runtimeMode: plan.runtimeMode,
      ...(plan.model.options === undefined ? {} : { modelOptions: plan.model.options }),
      mode: exec.mode,
      humanInLoop: resolveHumanInLoop(board, settings, card, exec),
      maxAttempts: plan.maxAttempts,
      timeoutMs: plan.timeoutMs,
      // Carried forward as in an intra-stage continuation, so a resume spends the same stage
      // entry's recovery budget and the ceiling still applies.
      priorRecoveries: boardStageEntryRecoveryCount(board, card.id),
      // Measured fresh when this plan starts a review round, carried forward
      // otherwise.
      baseTipAtRoundStart: yield* baseTipForPlan(card, plan.recordBaseTip),
      createdAt: yield* nowIso,
    });
    if (exec.mode === "build") yield* provisionPlacedBuildStep(card.id);
    yield* schedule();
  });

  // Release the step's slot on settlement — a no-op for a plan-mode step, which
  // never held one. The provider is read off the frozen run row,
  // the worker off the step's thread.
  const releaseSlot = (state: BoardCardStepState) =>
    state.slotHeld
      ? readBoard.pipe(Effect.flatMap((board) => slots.release(slotKeyFor(board, state))))
      : Effect.void;

  /**
   * The one way a step reaches `awaiting-input`, releasing its slot: nothing runs while a card
   * waits on a human. Observed, not fire-and-forget: a refused park (the step moved on) must
   * not release a slot the step still holds.
   */
  const parkStepForInput = Effect.fn("board-supervisor-parkStepForInput")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    readonly reason: BoardCardStepAwaitingReason;
  }) {
    const landed = yield* dispatchOptional({
      type: "board.card.await-step-input",
      commandId: yield* commandId("await-input"),
      cardId: input.card.id,
      stepId: input.state.stepId,
      reason: input.reason,
      createdAt: yield* nowIso,
    });
    if (!landed) return;
    // Gated on the PRE-park `slotHeld`, exactly as escalation is: the decider
    // has already set the persisted flag false, so a re-run releases nothing.
    yield* releaseSlot(input.state);
    // Let the freed slot flow to the queue within a beat rather than at the next
    // step boundary — the whole point of releasing it.
    yield* schedule();
  });

  /**
   * Resume a re-entered planning step on the thread the card kept, without resending the
   * prompt. A running turn ends on its own; an idle thread is handled as a completed turn
   * would be, so the card never shows a running step that nothing is running.
   */
  const resumeKeptPlanningThread = Effect.fn("board-supervisor-resumeKeptPlanningThread")(
    function* (input: {
      readonly card: BoardCard;
      readonly stepId: string;
      readonly threadId: ThreadId;
    }) {
      const { card, stepId, threadId } = input;
      const admitted = yield* dispatchOptional({
        type: "board.card.admit-step",
        commandId: yield* commandId("admit-kept-thread"),
        cardId: card.id,
        stepId,
        admitted: true,
        threadId,
        createdAt: yield* nowIso,
      });
      // Refused (the step moved on under us): the ordinary pass spawns for it.
      if (!admitted) return yield* schedule();
      // Back in Planning with Auto-plan on: the kept thread is
      // steered to finish unattended, never replaced.
      {
        const board = yield* readBoard;
        const current = board.cards.find((candidate) => candidate.id === card.id);
        const state = boardCardStepState(board, card.id);
        if (
          current !== undefined &&
          isBoardCardAutoPlanPending(current) &&
          state !== null &&
          state.threadId === threadId
        ) {
          const failure = yield* steerPlanningThread(
            card.id,
            state,
            boardAutoPlanInstruction(automationIn(board, current).autoBuild.value),
          );
          if (failure !== null) {
            yield* endAutoPlan(
              card.id,
              `Auto-plan could not reach the planning thread, so nothing will be planned automatically: ${failure}`,
            );
          }
          return;
        }
      }
      const shell = yield* liveThread(threadId);
      // A thread holding a structured question is alive but waiting on the
      // human, and no turn.completed comes until they answer: park it now, as
      // handleTurnCompleted would.
      const pendingQuestion =
        shell !== undefined && shell.awaitingUserInput && shell.sessionStatus !== "error";
      if (!pendingQuestion && shell !== undefined && shell.alive) return;
      const state = boardCardStepState(yield* readBoard, card.id);
      if (state === null || state.threadId !== threadId) return;
      if (pendingQuestion) return yield* parkStepForInput({ card, state, reason: "question" });
      if (!state.humanInLoop) return yield* recoverStep({ card, state });
      yield* parkStepForInput({
        card,
        state,
        // Read the thread's last message whenever it was sent: the step row is
        // new, so its own start time would hide every message before it.
        reason: (yield* endedWithQuestion({ threadId, lastNudgeAt: null, startedAt: null }))
          ? "question"
          : "stopped",
      });
    },
  );

  /**
   * Park a live step as `paused`: stop its turn, release its slot, keep its thread and
   * worktree. Shared by a human Stop and a schedule set on a working card. Callers own the
   * status guard: a Stop also accepts `awaiting-input` and `stalled`; a schedule only `running`.
   */
  const pauseStepNow = Effect.fn("board-supervisor-pauseStepNow")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
  }) {
    const landed = yield* dispatchOptional({
      type: "board.card.pause-step",
      commandId: yield* commandId("pause-step"),
      cardId: input.card.id,
      stepId: input.state.stepId,
      createdAt: yield* nowIso,
    });
    if (!landed) return;
    // Gated on the pre-pause `slotHeld`, exactly as escalation is.
    yield* releaseSlot(input.state);
    const threadId = input.state.threadId;
    if (threadId !== null) {
      const shell = yield* liveThread(threadId);
      if (shell?.activeTurnRef != null) {
        yield* logged(
          "thread.interrupt",
          threads.interrupt({ commandId: yield* commandId("interrupt-paused"), threadId }),
        );
      }
    }
    // Let the freed slot flow to the queue within a beat rather than at the next
    // step boundary — the whole point of releasing it.
    yield* schedule();
  });

  /**
   * A human stopped a board-run step: act on the interrupt so the card says `Paused` at once.
   * The board's own interrupts are excluded. `stalled` is accepted because an escalation can win
   * the race with `turn.completed`; the re-interrupt at the end stops a nudge `recoverStep` may
   * already have sent in that race. The interrupt re-enters here, finds `paused`, and stops.
   */
  const pauseStepForHumanStop = Effect.fn("board-supervisor-pauseStepForHumanStop")(function* (
    threadId: ThreadId,
  ) {
    // The board's own interrupts (see `interruptOrphan` / `abandonedThreads`).
    if (
      orphanedThreads.has(String(threadId)) ||
      abandonedThreads.has(String(threadId)) ||
      boardInterruptedRuns.has(String(threadId)) ||
      (yield* stillOnSteeredRun(threadId))
    ) {
      return;
    }
    const board = yield* readBoard;
    const found = stepThreadCard(board, threadId);
    if (found === null || found.card.archivedAt !== null) return;
    if (isBoardTerminalStepStatus(found.state.status)) return;
    // A status with a turn to stop, or the `stalled` the reverse interleaving
    // escalated to a beat before this arrived (see above). `queued`/`pending`
    // hold no slot and have nothing running; `paused` is already there, which is
    // what terminates the re-interrupt below.
    if (
      found.state.status !== "running" &&
      found.state.status !== "awaiting-input" &&
      found.state.status !== "stalled"
    ) {
      return;
    }
    yield* pauseStepNow({ card: found.card, state: found.state });
    // A human stopping an unattended planning run turns Auto-plan off with it:
    // a machine stop leaves the toggle on, a human one does not.
    if (isBoardCardAutoPlanPending(found.card)) {
      const stage = boardStageById(board, found.card.stage);
      if (stage !== null && effectiveBoardStageRole(stage) === "plan") {
        yield* endAutoPlan(
          found.card.id,
          "You stopped the planning run, so Auto-plan is off. Resume to carry on planning with the agent.",
          { turnOff: true },
        );
      }
    }
  });

  const settleStep = Effect.fn("board-supervisor-settleStep")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    readonly outcome: "succeeded" | "failed" | "abandoned";
  }) {
    // A fix that did not succeed must not leave the card armed (the success path consumes
    // the arm itself), or a later merge-stage step would turn it into a merge nobody asked for.
    if (input.outcome !== "succeeded") {
      disarmPendingMerge(input.card.id);
    }
    yield* dispatch({
      type: "board.card.settle-step",
      commandId: yield* commandId("settle-step"),
      cardId: input.card.id,
      stepId: input.state.stepId,
      outcome: input.outcome,
      createdAt: yield* nowIso,
    });
    yield* releaseSlot(input.state);
  });

  // ── Parking to retry ────────────────────────────────

  /**
   * The one way a step reaches `stalled` (except a spawn failure). Observed, like
   * `parkStepForInput`: a refused park must not release a slot the step still holds.
   */
  const parkStepForRetry = Effect.fn("board-supervisor-parkStepForRetry")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    readonly reason: BoardCardStepStalledReason;
    readonly retryAt: string | null;
    /** Whether this park spends the retry budget. A usage-limit park does not. */
    readonly chargeBudget: boolean;
    readonly progressed: boolean;
    readonly lastError?: string | null;
  }) {
    const error = input.lastError ?? null;
    const landed = yield* dispatchOptional({
      type: "board.card.recover-step",
      commandId: yield* commandId("park-retry"),
      cardId: input.card.id,
      stepId: input.state.stepId,
      threadId: input.state.threadId,
      escalateToHuman: true,
      progressed: input.progressed,
      stalledReason: input.reason,
      chargeBudget: input.chargeBudget,
      ...(input.retryAt === null ? {} : { retryAt: input.retryAt }),
      ...(error === null ? {} : { lastError: error }),
      createdAt: yield* nowIso,
    });
    if (!landed) return false;
    // Gated on the PRE-park `slotHeld`, exactly as escalation is: the decider
    // has already set the persisted flag false, so a re-run releases nothing.
    yield* releaseSlot(input.state);
    // Let the freed slot flow to the queue within a beat. A waiting card must
    // not hold a build slot for half an hour on a three-slot board — and
    // `orderBoardQueue` ranks started-and-later-stage first, so it regains its
    // place ahead of fresh work when it wakes rather than going to the back.
    yield* schedule();
    return true;
  });

  /** A delay spread by ±60s, so a fleet of parked cards never hits one
      provider on a precise cadence. The randomness is bound here and the
      arithmetic stays pure. */
  const jittered = (delayMs: number) =>
    Effect.map(Random.next, (random) => applyBoardRetryJitter(delayMs, random));

  const isoAfter = (nowMs: number, delayMs: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(nowMs + delayMs));

  /** The forge's refusal, bounded for the card aggregate. The
      text is persisted on every card-carrying event and rendered in a banner,
      and `gh` will happily print a paragraph. Trimmed to non-empty because the
      schema brands it so — a forge that said nothing still needs a reason. */
  const boundedHoldReason = (reason: string): string => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) return "The forge refused the merge without saying why.";
    return trimmed.length <= MAX_AUTO_MERGE_REASON_LENGTH
      ? trimmed
      : `${trimmed.slice(0, MAX_AUTO_MERGE_REASON_LENGTH - 1).trimEnd()}…`;
  };

  /**
   * Park an unattended step stopped by a provider usage limit, without spending its retry
   * budget. Orchestration resumes the thread (`limit-resumed` un-parks it); `retryAt`, a grace
   * past the reset, is the fallback. Whichever lands first wins. Answers whether it parked: no
   * reset time, or one already past, takes the ordinary recovery ladder.
   */
  const parkForUsageLimit = Effect.fn("board-supervisor-parkForUsageLimit")(function* (found: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
  }) {
    const threadId = found.state.threadId;
    if (threadId === null) return false;
    // A read failure answers "no limit", leaving recovery as it was. A thread
    // on a worker the board can't reach fails instead: unknown
    // is no answer, and reading it as "no limit" would recover a limited turn.
    const thread = yield* threads.threadState(threadId).pipe(Effect.orElseSucceed(() => null));
    if (thread === UNKNOWN_THREAD_STATE) {
      return yield* new ThreadReadError({
        operation: "threadState",
        detail: `Thread ${threadId} is on a worker the board cannot reach.`,
      });
    }
    const limit = thread?.usageLimit ?? null;
    const resetMs = limit?.resetAt == null ? Number.NaN : Date.parse(limit.resetAt);
    if (limit === null || !Number.isFinite(resetMs)) return false;
    // A reset already behind us has nothing to wait for either. Parked, it
    // would be due at once, v2 refuses to arm an expired window, and each wake
    // would hit the same stale limit and re-park free of charge, forever.
    if (resetMs <= (yield* clockNowMs)) return false;
    const message = limit.message?.trim() ?? "";
    const landed = yield* parkStepForRetry({
      card: found.card,
      state: found.state,
      reason: "usage-limit",
      retryAt: isoAfter(resetMs, yield* jittered(USAGE_LIMIT_RESUME_GRACE_MS)),
      chargeBudget: false,
      progressed: false,
      lastError: message.length > 0 ? message : "The provider's usage limit was reached.",
    });
    if (!landed) return true;
    yield* optional(
      "thread.metadata.update",
      threads.armLimitRecovery({ commandId: yield* commandId("limit-arm"), threadId }),
    );
    return true;
  });

  /** Land a step `stalled` for a human: recovery gave up. Shared by the
      ladder (`recoverStep`) and the background-wait check-ins, so a
      wait that exhausts the budget ends exactly the way a stall does. */
  const escalateStep = Effect.fn("board-supervisor-escalateStep")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    readonly progressed: boolean;
  }) {
    // Escalation lands `stalled`, which never reaches `settleStep`'s disarm. The human's next
    // move must be an explicit Merge click, so disarm here.
    disarmPendingMerge(input.card.id);
    yield* dispatch({
      type: "board.card.recover-step",
      commandId: yield* commandId("recover-step"),
      cardId: input.card.id,
      stepId: input.state.stepId,
      threadId: input.state.threadId,
      escalateToHuman: true,
      progressed: input.progressed,
      // The loud reading of `stalled`: recovery gave up, and
      // there is no time at which it will try again.
      stalledReason: "gave-up",
      createdAt: yield* nowIso,
    });
    // Release the held slot exactly once, riding the existing machinery:
    // the pre-escalation state's `slotHeld` gates the release, and the decider
    // has set the persisted `slotHeld` to false, so a re-run releases nothing.
    yield* releaseSlot(input.state);
    yield* schedule();
  });

  const recoverStep = Effect.fn("board-supervisor-recoverStep")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
  }) {
    // Resolve the two things the pure decision needs but must not read itself:
    // the progress signal (git/activity) and the stage-entry recovery
    // total and its ceiling (settings). `recoveryDecision` stays pure.
    const board = yield* readBoard;
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(
      settings,
      input.card.stage,
      boardProjectStageConfig(board, input.card.projectId),
    );
    const progressedSinceLastNudge = yield* resolveProgressedSinceLastNudge(
      input.state,
      input.card,
    );
    const stageEntryRecoveries = boardStageEntryRecoveryCount(board, input.card.id);
    const decision = recoveryDecision({
      stepState: input.state,
      progressedSinceLastNudge,
      stageEntryRecoveries,
      // The settings key keeps its older name; the pure function's
      // parameter says what it actually bounds.
      maxRecoveriesPerStageEntry: exec.maxInvocationsPerStageEntry,
      endedWithQuestion: yield* endedWithQuestion(input.state),
    });

    // Recovery gives up: ask the human, landing the step `stalled` and releasing its slot. Do
    // NOT drive the agent: another turn would re-arm death detection and re-escalate every turn.
    if (decision.kind === "escalate") {
      // The card's `stalled` badge is the human-facing signal; the question goes to the log.
      yield* Effect.logWarning("board supervisor: recovery escalated to a human", {
        cardId: input.card.id,
        stepId: input.state.stepId,
        stallCount: decision.stallCount,
        question: decision.question,
      });
      yield* escalateStep({
        card: input.card,
        state: input.state,
        progressed: progressedSinceLastNudge,
      });
      return;
    }

    // Every nudge is backed off: the ladder is charged here, at the stop, and the step parks
    // `waiting-retry` with a `retryAt` and no slot until the retry sweep requeues it. So the
    // "can this recovery act at all" test (thread gone, no way to respawn) runs first, because
    // the park is what spends the budget.
    const gone = yield* threadGone(input.state.threadId);
    const canRespawn = yield* Effect.gen(function* () {
      if (input.state.mode === "build") return input.card.worktree?.path != null;
      const model = yield* readModel;
      return projectCwd(model, input.card) !== null;
    });
    if (gone && !canRespawn) {
      yield* Effect.logWarning(
        "board supervisor: cannot recover step: no thread and cannot respawn",
        { cardId: input.card.id, stepId: input.state.stepId },
      );
      return;
    }
    const delayMs = yield* jittered(boardRetryDelayMs(decision.stallCount - 1));
    const nowMs = yield* clockNowMs;
    yield* parkStepForRetry({
      card: input.card,
      state: input.state,
      reason: "waiting-retry",
      retryAt: isoAfter(nowMs, delayMs),
      chargeBudget: true,
      progressed: progressedSinceLastNudge,
    });
  });

  /** T3o: `BoardCardPullRequest.closedAt` from a forge answer —
      when it stopped being open, keyed only on a non-open pull request. */
  const boardClosedAtOf = (found: {
    readonly state: BoardCardPullRequest["state"];
    readonly mergedAt?: string | null | undefined;
    readonly closedAt?: string | null | undefined;
  }): { readonly closedAt?: string | null } =>
    found.state === "open" ? {} : { closedAt: found.mergedAt ?? found.closedAt ?? null };

  /** T3o: the card's link, as the refresh RPC reports it. */
  const boardRefreshOutcomeOf = (
    pullRequest: BoardCardPullRequest | null,
  ): BoardRefreshCardPullRequestResult =>
    pullRequest === null ? { outcome: "none" } : { outcome: "linked", number: pullRequest.number };

  /**
   * Re-resolve the card's pull request from the forge and record it if it moved. No periodic
   * sweep: lookup cost grows with branches asked about. A merged PR (once titled) or no branch
   * costs no lookup. A lookup failure records nothing, so a rate limit never blanks the badge.
   */
  const refreshCardPullRequestLink = Effect.fn("board-supervisor-refreshCardPullRequestLink")(
    function* (
      card: BoardCard,
      /** T3o: a human's "Check again" bypasses the lookup cache and
          its failure backoff. Every automatic caller omits it and keeps the
          cheap cached path. */
      options?: { readonly force?: boolean },
    ) {
      const worktree = card.worktree;
      // A reclaimed worktree keeps its branch name (reclaim nulls `path`) and can still be
      // merged, so fall back to the project root rather than freeze the card's link.
      const recorded = card.pullRequest;
      // Linked PRs and merged ones still missing a title (or `closedAt`) are looked up by NUMBER:
      // Done may have deleted the branch, and a link may name another branch's PR. Only a
      // still-merged same-number answer updates a merged link. A merged link adopted from a reused
      // branch that closed before the card existed goes to the branch lookup to be replaced.
      const linked = recorded?.linked === true;
      // The pull request the card holds but never owned, once known.
      let disowned: number | null =
        recorded !== null && !linked && boardPullRequestPredatesCard(recorded, card.createdAt)
          ? recorded.number
          : null;
      if (
        recorded !== null &&
        disowned === null &&
        (linked || isBoardCardPullRequestTerminal(recorded))
      ) {
        if (
          isBoardCardPullRequestTerminal(recorded) &&
          recorded.title !== null &&
          (linked || recorded.closedAt !== undefined)
        ) {
          return boardRefreshOutcomeOf(recorded);
        }
        // Only a human's "Check again" forces past the PR read cache; every
        // automatic trigger takes the cached read, so a burst of triggers
        // costs one forge call per cache window. Failures are not cached, so
        // a forge that keeps failing is asked again on the next trigger.
        const found = yield* (yield* workspaceFor(card))
          .getPullRequest({
            number: recorded.number,
            force: options?.force === true,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logDebug("board supervisor: pull request lookup failed; keeping last known", {
                cardId: card.id,
                number: recorded.number,
                detail: error.detail,
              }).pipe(Effect.as({ failure: error.detail } as const)),
            ),
            Effect.catchCause((cause) =>
              Effect.logDebug("board supervisor: pull request lookup died; keeping last known", {
                cardId: card.id,
                number: recorded.number,
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.as({ failure: "The pull request lookup failed unexpectedly." } as const),
              ),
            ),
          );
        if ("failure" in found) {
          return { outcome: "lookup-failed", detail: found.failure } as const;
        }
        const current = (yield* readCard(card.id)) ?? card;
        const currentLink = current.pullRequest;
        // The answer applies only to the link it was asked about, still held
        // the same way; and a merged link only ever takes a still-merged
        // answer (the backfill), for the reason given above.
        if (
          currentLink === null ||
          found.number !== currentLink.number ||
          (currentLink.linked === true) !== linked ||
          (isBoardCardPullRequestTerminal(currentLink) ? found.state !== "merged" : !linked)
        ) {
          return boardRefreshOutcomeOf(currentLink);
        }
        const next = {
          number: found.number,
          url: found.url,
          state: found.state,
          title: found.title,
          headBranch: found.headRef,
          baseRef: found.baseRef,
          ...(found.isDraft === true ? { isDraft: true } : {}),
          ...(linked ? { linked: true } : {}),
          ...boardClosedAtOf(found),
          checkedAt: yield* nowIso,
        } satisfies BoardCardPullRequest;
        if (!boardCardPullRequestsEqual(currentLink, next)) {
          yield* dispatchOptional({
            type: "board.card.record-pull-request",
            commandId: yield* commandId("record-pr"),
            cardId: card.id,
            pullRequest: next,
            createdAt: yield* nowIso,
          });
        }
        if (linked || !boardPullRequestPredatesCard(next, card.createdAt)) {
          return boardRefreshOutcomeOf(next);
        }
        disowned = next.number;
      }

      if (worktree === null) {
        if (disowned === null) return { outcome: "no-branch" } as const;
        // No branch to find the card's own on, so the earlier card's link is
        // cleared rather than left pointing View PR at it — unless another
        // refresh has replaced it meanwhile.
        const held = (yield* readCard(card.id))?.pullRequest ?? null;
        if (held !== null && held.number === disowned && held.linked !== true) {
          yield* dispatchOptional({
            type: "board.card.record-pull-request",
            commandId: yield* commandId("record-pr"),
            cardId: card.id,
            pullRequest: null,
            createdAt: yield* nowIso,
          });
          return { outcome: "no-branch" } as const;
        }
        return boardRefreshOutcomeOf(held);
      }

      const workspace = yield* workspaceFor(card);
      if (worktree.path === null && workspace.checkoutPath === null) {
        return { outcome: "no-branch" } as const;
      }

      // A failure carries the forge's words out: "there is none" and "could not look" are
      // different answers. Neither branch below records anything.
      const found = yield* workspace
        .pullRequestByBranch({
          branch: worktree.branch,
          worktreePath: worktree.path,
          force: options?.force === true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logDebug("board supervisor: pull request lookup failed; keeping last known", {
              cardId: card.id,
              branch: worktree.branch,
              detail: error.detail,
            }).pipe(Effect.as({ failure: error.detail } as const)),
          ),
          Effect.catchCause((cause) =>
            Effect.logDebug("board supervisor: pull request lookup died; keeping last known", {
              cardId: card.id,
              branch: worktree.branch,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as({ failure: "The pull request lookup failed unexpectedly." } as const),
            ),
          ),
        );
      if (found !== null && "failure" in found) {
        return { outcome: "lookup-failed", detail: found.failure } as const;
      }

      // T3o: a pull request that closed before the card existed is
      // an earlier card's on the same branch name — the lookup falls back to
      // the newest pull request on the branch when none is open — so it is
      // no pull request at all for this card.
      const next =
        found === null ||
        boardPullRequestPredatesCard(
          { state: found.state, ...boardClosedAtOf(found) },
          card.createdAt,
        )
          ? null
          : ({
              number: found.number,
              url: found.url,
              state: found.state,
              title: found.title,
              headBranch: found.headRef,
              baseRef: found.baseRef,
              ...(found.isDraft === true ? { isDraft: true } : {}),
              ...boardClosedAtOf(found),
              checkedAt: yield* nowIso,
            } satisfies BoardCardPullRequest);

      // Re-read after the forge round trip: concurrent triggers may have recorded a newer state,
      // and the guards below compare against what the card holds now.
      const current = (yield* readCard(card.id)) ?? card;

      // A branch lookup never unlinks or demotes a merged link: Done may have deleted the branch,
      // and a same-number open or closed answer may predate the merge. Except a link the card
      // never owned.
      const currentDisowned =
        current.pullRequest !== null &&
        current.pullRequest.linked !== true &&
        (current.pullRequest.number === disowned ||
          boardPullRequestPredatesCard(current.pullRequest, card.createdAt));
      if (
        isBoardCardPullRequestTerminal(current.pullRequest) &&
        current.pullRequest !== null &&
        !currentDisowned &&
        (next === null || next.number !== current.pullRequest.number || next.state !== "merged")
      ) {
        return boardRefreshOutcomeOf(current.pullRequest);
      }

      // A PR at or below the floor belongs to a finished round. The decider refuses it too; this
      // keeps a second-round card from a rejected dispatch on every lookup. `open` and the current
      // link are exempt, as in the decider.
      const isCurrentLink =
        next !== null && current.pullRequest !== null && current.pullRequest.number === next.number;
      if (
        next !== null &&
        !isCurrentLink &&
        next.state !== "open" &&
        current.pullRequestFloor !== null &&
        next.number <= current.pullRequestFloor
      ) {
        // Logged rather than dropped in silence. A card that keeps resolving a
        // retired pull request and never adopting one shows no pull request at
        // all, and without this there is nothing anywhere that says why.
        yield* Effect.logDebug("board supervisor: pull request below the card's round floor", {
          cardId: card.id,
          number: next.number,
          state: next.state,
          floor: current.pullRequestFloor,
        });
        // T3o: the card's OWN link is the answer, not the retired
        // round's number this lookup happened to resolve.
        return boardRefreshOutcomeOf(current.pullRequest);
      }
      // Skip a no-op without a rejected dispatch. Overlapping refreshes can still both pass this,
      // which is why the dispatch below tolerates the refusal.
      if (boardCardPullRequestsEqual(current.pullRequest, next)) return boardRefreshOutcomeOf(next);

      yield* dispatchOptional({
        type: "board.card.record-pull-request",
        commandId: yield* commandId("record-pr"),
        cardId: card.id,
        pullRequest: next,
        createdAt: yield* nowIso,
      });
      return boardRefreshOutcomeOf(next);
    },
  );

  /**
   * Refresh the card's pull request, then settle it if a merged PR sits in Done. Hung off the
   * refresh because "in Done" and "merged" arrive in either order and only the second can act
   * on the pair; every refresh trigger doubles as a settle trigger. Nothing here polls.
   */
  const refreshCardPullRequest = Effect.fn("board-supervisor-refreshCardPullRequest")(function* (
    card: BoardCard,
    /**
     * The post-move stage, passed only by `handleCardMoved` because the read model may lag the
     * move. Every other caller gets the card's re-read stage, which is fresher than anything
     * they read earlier.
     */
    movedToStage?: BoardCard["stage"],
    /**
     * `force` bypasses the lookup cache ("Check again"). `deferSettle` hands the settle to
     * `cardCleanupWorker`: its reclaim fetches from the remote, and the serialised worker must
     * not wait on the network.
     */
    options?: { readonly force?: boolean; readonly deferSettle?: boolean },
  ) {
    const outcome = yield* refreshCardPullRequestLink(card, options);
    // Re-read for the pull request the refresh may have just recorded.
    const refreshed = yield* readCard(card.id);
    if (refreshed === null) return outcome;
    const settling = movedToStage === undefined ? refreshed : { ...refreshed, stage: movedToStage };
    if (options?.deferSettle === true) {
      yield* cardCleanupWorker.enqueue({ kind: "settle", card: settling });
    } else {
      yield* settleCardAtDone(settling);
    }
    return outcome;
  });

  /**
   * Resolve a pull request to link to a card in `projectId`, forced. Refuses one not on the
   * project's repository or unknown to the forge, in words fit to show. Records nothing, so a
   * caller can check it before the card exists.
   */
  const resolvePullRequestLink = Effect.fn("board-supervisor-resolvePullRequestLink")(function* (
    workspace: BoardCardWorkspace,
    target: BoardCardPullRequestTarget,
  ) {
    // T3o: the board's repository — `origin` — not the project
    // identity, which in a fork names upstream.
    const repository = yield* workspace
      .pullRequestRepository({})
      .pipe(Effect.orElseSucceed(() => null));
    const resolved = resolveCardPullRequestTarget(target, repository);
    if ("refused" in resolved) {
      return { outcome: "refused", detail: resolved.refused } as const;
    }
    const found = yield* workspace.getPullRequest({ number: resolved.number, force: true }).pipe(
      Effect.map((summary) => ({ summary }) as const),
      Effect.catch((error) =>
        Effect.succeed({
          failure: `Could not find pull request #${resolved.number}: ${error.detail}`,
        } as const),
      ),
      Effect.catchCause(() =>
        Effect.succeed({
          failure: `Could not find pull request #${resolved.number}: the lookup failed unexpectedly.`,
        } as const),
      ),
    );
    if ("failure" in found) return { outcome: "refused", detail: found.failure } as const;
    const summary = found.summary;
    const pullRequest = {
      number: summary.number,
      url: summary.url,
      state: summary.state,
      title: summary.title,
      headBranch: summary.headRef,
      baseRef: summary.baseRef,
      ...(summary.isDraft === true ? { isDraft: true } : {}),
      linked: true,
      checkedAt: yield* nowIso,
    } satisfies BoardCardPullRequest;
    return { outcome: "resolved", pullRequest } as const;
  });

  /**
   * Link a pull request to a card, or clear the link. `resolved` skips the lookup. The card
   * is then settled like after any refresh.
   */
  const linkPullRequest = Effect.fn("board-supervisor-linkPullRequest")(function* (
    cardId: BoardCardId,
    target: BoardCardPullRequestTarget | null,
    options?: { readonly resolved?: BoardCardPullRequest },
  ) {
    const card = yield* readCard(cardId);
    if (card === null) return { outcome: "unknown-card" } as const;
    if (target === null && card.pullRequest?.linked !== true) return { outcome: "none" } as const;
    let pullRequest: BoardCardPullRequest | null = null;
    if (target !== null) {
      if (options?.resolved !== undefined) {
        pullRequest = options.resolved;
      } else {
        const resolution = yield* resolvePullRequestLink(yield* workspaceFor(card), target);
        if (resolution.outcome === "refused") return resolution;
        pullRequest = resolution.pullRequest;
      }
      // Relinking what the card already holds is success, not a refusal.
      if (boardCardPullRequestsEqual(card.pullRequest, pullRequest)) {
        return { outcome: "linked", number: pullRequest.number } as const;
      }
    }
    const refusal = yield* dispatchRefusal({
      type: "board.card.set-linked-pull-request",
      commandId: yield* commandId("link-pr"),
      cardId,
      pullRequest,
      createdAt: yield* nowIso,
    });
    if (refusal !== null) return { outcome: "refused", detail: refusal } as const;
    const fresh = yield* readCard(cardId);
    if (fresh !== null) yield* settleCardAtDone(fresh);
    return pullRequest === null
      ? ({ outcome: "unlinked" } as const)
      : ({ outcome: "linked", number: pullRequest.number } as const);
  });

  /** The card as the read model currently has it, or null if it is gone. */
  const readCard = Effect.fn("board-supervisor-readCard")(function* (cardId: BoardCardId) {
    const board = yield* readBoard;
    return board.cards.find((candidate) => candidate.id === cardId) ?? null;
  });

  /**
   * Delete a card's branch on arrival at Done when its PR is merged and `deleteBranchOnDone`
   * is on. Runs after a refresh, against what the forge says now. Best-effort: a failure is
   * reported on the card and never blocks the move to Done.
   */
  const cleanupBranchOnDone = Effect.fn("board-supervisor-cleanupBranchOnDone")(function* (
    card: BoardCard,
  ) {
    const worktree = card.worktree;
    if (worktree === null) return;
    if (card.pullRequest === null || card.pullRequest.state !== "merged") return;
    // T3o: an earlier card's merge on a reused branch name.
    if (
      card.pullRequest.linked !== true &&
      boardPullRequestPredatesCard(card.pullRequest, card.createdAt)
    ) {
      return;
    }

    const settings = yield* boardSettings;
    const board = yield* readBoard;
    const mergeStage = boardStageWithRole(board, "merge");
    if (mergeStage === null) return;
    const exec = resolveBoardStageExecution(
      settings,
      mergeStage.stageId,
      boardProjectStageConfig(board, card.projectId),
    );
    if (!isBoardMergeStageExecution(exec) || !exec.deleteBranchOnDone) return;

    const workspace = yield* workspaceFor(card);
    if (workspace.checkoutPath === null) return;

    // A linked pull request can live on another branch (a stack
    // layer). Its merge says nothing about the card's own branch, which may
    // hold pushed commits that exist nowhere else.
    if (card.pullRequest.headBranch !== worktree.branch) {
      yield* dispatch({
        type: "board.card.record-note",
        commandId: yield* commandId("branch-cleanup"),
        cardId: card.id,
        kind: "card-branch-kept",
        detail: `Kept branch ${worktree.branch}: the merged pull request #${card.pullRequest.number} is on ${card.pullRequest.headBranch}, not this branch`,
        createdAt: yield* nowIso,
      });
      return;
    }

    const result = yield* workspace.deleteCardBranch({ branch: worktree.branch }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor: branch cleanup failed", {
          cardId: card.id,
          branch: worktree.branch,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
    if (result === null) return;
    // Report it on the card: deleting a branch is irreversible, and a partial cleanup is a
    // real outcome when `reclaimWorktreeOnDone` is off.
    const deleted = [
      ...(result.remoteDeleted ? ["remote"] : []),
      ...(result.localDeleted ? ["local"] : []),
    ];
    const detail =
      deleted.length === 0
        ? `Kept branch ${worktree.branch}${result.skippedReason === null ? "" : `: ${result.skippedReason}`}`
        : `Deleted ${deleted.join(" and ")} branch ${worktree.branch}${
            result.skippedReason === null ? "" : `: ${result.skippedReason}`
          }`;
    yield* dispatch({
      type: "board.card.record-note",
      commandId: yield* commandId("branch-cleanup"),
      cardId: card.id,
      kind: "card-branch-deleted",
      detail,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Cards whose reclaim is running now, so concurrent reclaims never race to remove the same
   * checkout. The test and the add are synchronous, so no yield separates them.
   */
  const reclaimingCards = new Set<string>();

  /**
   * Whether `card` is still finished with the checkout at `path`, read fresh: same checkout
   * still `ready`, and archived or in the same round with no live step. Not the stage: the
   * read model can lag a move. A failed read answers no; keeping a worktree is the safe side.
   */
  const cardStillFinished = Effect.fn("board-supervisor-cardStillFinished")(
    function* (card: BoardCard, path: string) {
      const board = yield* readBoard;
      const current = board.cards.find((candidate) => candidate.id === card.id);
      if (current === undefined || current.worktree?.status !== "ready") return false;
      if (current.worktree.path !== path) return false;
      if (current.archivedAt !== null) return true;
      if (boardCardRound(current) !== boardCardRound(card)) return false;
      const state = boardCardStepState(board, current.id);
      return state === null || isBoardTerminalStepStatus(state.status);
    },
    Effect.orElseSucceed(() => false),
  );

  /**
   * Remove a card's worktree when its work is durable, else keep it and record why. Never
   * deletes uncommitted or unpushed work. Idempotent: a repeated refusal dispatches nothing.
   * The card is re-read before removal, since the probe's fetches leave time for a human to
   * bring it back into use.
   */
  const reclaimCardWorktree = Effect.fn("board-supervisor-reclaimCardWorktree")(function* (
    card: BoardCard,
    fetchedBases?: Set<string>,
  ) {
    const worktree = card.worktree;
    if (worktree === null || worktree.status !== "ready" || worktree.path === null) return null;
    const workspace = yield* workspaceFor(card);
    if (workspace.checkoutPath === null) {
      // A failure, not a quiet skip: the card IS finished, and Check again
      // must not answer that it isn't.
      yield* Effect.logWarning("board supervisor: worktree reclaim has no project checkout", {
        cardId: card.id,
      });
      return { outcome: "failed" } satisfies BoardCardReclaimAttempt;
    }
    const key = String(card.id);
    if (reclaimingCards.has(key)) return { outcome: "busy" } satisfies BoardCardReclaimAttempt;
    reclaimingCards.add(key);
    const pullRequests = [
      ...card.pullRequestHistory,
      ...(card.pullRequest === null ? [] : [card.pullRequest]),
    ];
    // An unreachable worker reads as "failed" here, which records nothing:
    // the next sweep asks again.
    const reclaimed = yield* workspace
      .reclaimWorktree(
        {
          worktreePath: worktree.path,
          baseRefName: worktree.baseRefName,
          branch: worktree.branch,
          mergedPullRequestNumbers: pullRequests
            .filter(
              (pullRequest) =>
                pullRequest.state === "merged" &&
                // T3o: an earlier card's merge on a reused branch name
                // proves nothing about this card's work.
                (pullRequest.linked === true ||
                  !boardPullRequestPredatesCard(pullRequest, card.createdAt)),
            )
            .map((pullRequest) => pullRequest.number),
          openPullRequestNumber:
            card.pullRequest?.state === "open" ? card.pullRequest.number : null,
          fetchedBases,
        },
        cardStillFinished(card, worktree.path),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: worktree reclaim failed", {
            cardId: card.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as("failed" as const)),
        ),
        Effect.ensuring(Effect.sync(() => reclaimingCards.delete(key))),
      );
    if (reclaimed === "failed") return { outcome: "failed" } satisfies BoardCardReclaimAttempt;
    // Abandoned: the card was no longer finished by the time the probe ended.
    if (reclaimed === null) return null;
    const { outcome, reason } = reclaimed;
    const hookWarning = reclaimed.outcome === "removed" ? (reclaimed.hookWarning ?? null) : null;
    const attempt: BoardCardReclaimAttempt =
      outcome === "removed" ? { outcome: "removed" } : { outcome: "kept", reason };
    if (outcome === "blocked" && reason === worktree.reclaimBlockedReason) return attempt;
    // Optional: a concurrent path (card delete, a forced removal) may have
    // settled the worktree while this probed, and the decider's refusal is
    // then the right answer rather than a fault.
    yield* dispatchOptional({
      type: "board.card.reclaim-worktree",
      commandId: yield* commandId("reclaim-worktree"),
      cardId: card.id,
      outcome,
      ...(reason === null ? {} : { reason }),
      ...(hookWarning === null ? {} : { hookWarning }),
      createdAt: yield* nowIso,
    });
    return attempt;
  });

  /**
   * The round each card's branch cleanup last ran in (`pullRequestHistory.length`), cleared
   * only by archive. Keyed by round, not a flag cleared on leaving Done, so a late settle from
   * round one cannot mask round two. Guards the branch half only; the worktree half is
   * idempotent and retried freely.
   */
  const settledAtDone = new Map<string, number>();
  const boardCardRound = (card: BoardCard): number => card.pullRequestHistory.length;

  /**
   * Cards whose branch cleanup is running now. `settledAtDone` is marked on completion so a
   * failed cleanup can retry, and the RPC path is not serialised, so this closes the window.
   * The test and the add are synchronous.
   */
  const settlingAtDone = new Set<string>();

  /**
   * Reclaim the worktree (any archived card, or in Done with `reclaimWorktreeOnDone`), then
   * delete the branches (merged PR only, once per round). Order matters: a local branch held by
   * a worktree cannot be deleted. `"after-reclaim"` (the sweep) cleans branches only when this
   * call removed the worktree. Best-effort throughout.
   */
  const settleCardAtDone = Effect.fn("board-supervisor-settleCardAtDone")(function* (
    card: BoardCard,
    options?: {
      readonly branchCleanup?: "always" | "after-reclaim";
      readonly fetchedBases?: Set<string>;
    },
  ) {
    const board = yield* readBoard;
    const stage = boardStageById(board, card.stage);
    const inDone = stage !== null && effectiveBoardStageRole(stage) === "done";
    const archived = card.archivedAt !== null;
    if (!inDone && !archived) return null;
    const round = boardCardRound(card);

    const settings = yield* boardSettings;
    let removedHere = false;
    let attempt: BoardCardReclaimAttempt | null = null;
    if (archived || settings.lifecycle.reclaimWorktreeOnDone) {
      // Re-assert on the round before removing: the yields above let a human drag the card back out
      // of Done and start work in this checkout. Not on the stage, which the read model can lag;
      // the round only advances, and advances on exactly that move.
      const current = yield* readCard(card.id);
      if (current !== null && boardCardRound(current) === round) {
        const wasReady = current.worktree?.status === "ready";
        attempt = yield* reclaimCardWorktree(current, options?.fetchedBases);
        const after = yield* readCard(card.id);
        removedHere = wasReady && after?.worktree?.status === "reclaimed";
      }
    }

    if (!inDone) return attempt;
    if (card.pullRequest === null || card.pullRequest.state !== "merged") return attempt;
    // T3o: a pull request that merged before the card existed is an
    // earlier card's on a reused branch name; it says nothing about this
    // card's work, which may be sitting unmerged on that very branch.
    if (
      card.pullRequest.linked !== true &&
      boardPullRequestPredatesCard(card.pullRequest, card.createdAt)
    ) {
      return attempt;
    }
    if (options?.branchCleanup === "after-reclaim" && !removedHere) return attempt;
    // Branch cleanup hangs off the pull-request refresh, which fires on every card open, so this
    // guard stops a Done card re-deleting its branch and re-noting it each time. In memory: after a
    // restart one idempotent cleanup may run again.
    if (settledAtDone.get(String(card.id)) === round) return attempt;
    // Both checks and the add are synchronous — nothing yields between them —
    // so a concurrent caller cannot slip through into the same cleanup.
    if (settlingAtDone.has(String(card.id))) return attempt;
    settlingAtDone.add(String(card.id));
    // `ensuring`, so a failure anywhere below releases the in-flight marker.
    // Leaking it would wedge the card out of ever settling again in this
    // process — the opposite of what marking on completion is FOR.
    yield* Effect.gen(function* () {
      // Re-read: the reclaim just changed the card's worktree state, and branch
      // cleanup asks whether a worktree still holds the branch.
      const reclaimed = yield* readCard(card.id);
      yield* cleanupBranchOnDone(reclaimed ?? card);
    }).pipe(Effect.ensuring(Effect.sync(() => settlingAtDone.delete(String(card.id)))));
    // Settled means this round has had its attempt, not that it succeeded: a failed delete already
    // says so on the rail, and the next round out of Done gets its own attempt.
    settledAtDone.set(String(card.id), round);
    return attempt;
  });

  /**
   * Whether no card owns a registered `board/*` checkout. Owners are looked up
   * across EVERY project: two board projects can share one repository, and the
   * other project's live card is not an orphan just because this project does
   * not know it.
   */
  const isOrphanWorktree = (
    board: BoardState,
    registered: { readonly path: string; readonly branch: string },
  ): boolean => {
    const owner = board.cards.find((card) => card.worktree?.branch === registered.branch);
    const ownerWorktree = owner?.worktree ?? null;
    return (
      ownerWorktree === null ||
      ownerWorktree.status === "reclaimed" ||
      (ownerWorktree.status === "ready" &&
        ownerWorktree.path !== null &&
        pathService.resolve(ownerWorktree.path) !== pathService.resolve(registered.path))
    );
  };

  /**
   * Remove durable `board/*` worktrees no card owns any more; anything else is only logged. Judged
   * per workspace against the cards placed there, listing only that workspace's own worktrees
   * directory: another T3 environment on the same repository has its own board and checkouts.
   */
  const sweepOrphanWorktrees = Effect.fn("board-supervisor-sweepOrphanWorktrees")(function* (
    board: BoardState,
    fetchedBases: Set<string>,
  ) {
    const groups = yield* workspaces.groupByWorkspace(board.cards);
    // Ownership is judged per WORKER, across its projects: two board projects
    // can share one repository, and one's live checkout is no orphan of the
    // other's.
    const idsOnWorker = new Map<string, Set<string>>();
    for (const { workspace, cards } of groups) {
      const ids = idsOnWorker.get(workspace.workerId) ?? new Set<string>();
      for (const card of cards) ids.add(card.id);
      idsOnWorker.set(workspace.workerId, ids);
    }
    for (const { workspace } of groups) {
      const ids = idsOnWorker.get(workspace.workerId) ?? new Set<string>();
      const placedHere = (fresh: BoardState): BoardState => ({
        ...fresh,
        cards: fresh.cards.filter((card) => ids.has(card.id)),
      });
      const listed = yield* workspace
        .listBoardWorktrees({})
        .pipe(Effect.catchCause(() => Effect.succeed({ worktrees: [] })));
      for (const registered of listed.worktrees) {
        const candidate = { path: registered.path, branch: registered.branch };
        if (!isOrphanWorktree(placedHere(board), candidate)) continue;
        const owner = placedHere(board).cards.find(
          (card) => card.worktree?.branch === registered.branch,
        );
        const baseRefName =
          owner?.worktree?.baseRefName ??
          (yield* workspace.remoteDefaultBranch({}).pipe(
            Effect.map((result) => result.branch),
            Effect.orElseSucceed(() => "main"),
          ));
        const outcome = yield* workspace
          .reclaimWorktree(
            {
              worktreePath: registered.path,
              baseRefName,
              branch: registered.branch,
              mergedPullRequestNumbers: [],
              fetchedBases,
            },
            // Ownership is re-judged on a FRESH board right before removal. The
            // pass's snapshot is minutes old by now, and a card that started
            // provisioning in between owns a checkout cut at the base tip —
            // clean and durable, and anything but an orphan.
            readBoard.pipe(
              Effect.map((fresh) => isOrphanWorktree(placedHere(fresh), candidate)),
              Effect.orElseSucceed(() => false),
            ),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("board supervisor: orphan worktree check failed", {
                path: registered.path,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(null)),
            ),
          );
        if (outcome === null) continue;
        if (outcome.outcome === "removed") {
          yield* Effect.logInfo("board supervisor: removed orphan worktree", {
            path: registered.path,
            branch: registered.branch,
          });
        } else {
          yield* Effect.logWarning("board supervisor: kept orphan worktree", {
            path: registered.path,
            branch: registered.branch,
            reason: outcome.reason,
          });
        }
      }
    }
  });

  /**
   * One worktree-cleanup pass over Done-role cards (when `reclaimWorktreeOnDone` is on), archived
   * cards (always), and orphans. `refreshOpenPullRequests` (boot) re-reads Done cards still cached
   * `open`, which may have merged since; that tiny set is the only forge call here.
   */
  // Pending group-archive discards the sweep has already retried this process.
  const sweptDiscards = new Set<BoardCardId>();
  const sweepWorktrees = Effect.fn("board-supervisor-sweepWorktrees")(function* (options: {
    readonly refreshOpenPullRequests: boolean;
  }) {
    const settings = yield* boardSettings;
    const board = yield* readBoard;
    forgetSettledProvisions(board);
    const fetchedBases = new Set<string>();
    for (const card of board.cards) {
      // T3o: a linked pull request settles its card whether or not
      // the card holds a worktree — it may never have had one — so its boot
      // refresh is not gated on the worktree or the reclaim setting.
      const cardStage = boardStageById(board, card.stage);
      if (
        options.refreshOpenPullRequests &&
        card.archivedAt === null &&
        card.pullRequest?.linked === true &&
        card.pullRequest.state === "open" &&
        cardStage !== null &&
        effectiveBoardStageRole(cardStage) === "done"
      ) {
        yield* refreshCardPullRequest(card);
        continue;
      }
      // A confirmed group archive whose branch deletion has not finished:
      // retried here, as the one queued at archive may have failed or been
      // lost to a restart. Once per process: some remote refusals never clear,
      // and each attempt is a push of up to 30s.
      if (card.archivedAt !== null && card.worktree?.discardPending === true) {
        if (!sweptDiscards.has(card.id)) {
          sweptDiscards.add(card.id);
          yield* discardCardBranchWork(card.id);
        }
        continue;
      }
      if (card.worktree === null || card.worktree.status !== "ready") continue;
      if (card.archivedAt !== null) {
        yield* reclaimCardWorktree(card, fetchedBases);
        continue;
      }
      // Retried here, since the one reclaim on cancel may have kept it.
      if (holdsCancelledWork(card)) {
        yield* reclaimCancelledCardWorktree(card.id);
        continue;
      }
      if (!settings.lifecycle.reclaimWorktreeOnDone) continue;
      const stage = boardStageById(board, card.stage);
      if (stage === null || effectiveBoardStageRole(stage) !== "done") continue;
      if (options.refreshOpenPullRequests && card.pullRequest?.state === "open") {
        // Refresh-then-settle, like every other refresh trigger.
        yield* refreshCardPullRequest(card);
        continue;
      }
      yield* settleCardAtDone(card, { branchCleanup: "after-reclaim", fetchedBases });
    }
    yield* sweepOrphanWorktrees(board, fetchedBases);
  });

  /**
   * Retire a deleted card's checkout (forced: the human confirmed the delete), then delete its
   * branch, which git refuses while a worktree has it checked out. Queued because remove scripts
   * can take minutes; with the card gone a failure can only be logged.
   */
  const retireDeletedCardWorktree = Effect.fn("board-supervisor-retireDeletedCardWorktree")(
    function* (request: {
      readonly cardId: BoardCardId;
      /** Resolved when the card was deleted: the card is gone by now. */
      readonly workspace: BoardCardWorkspace;
      readonly worktreePath: string | null;
      readonly branch: string;
    }) {
      if (request.worktreePath !== null) {
        const hookWarning = yield* forceRemoveWorktree(
          request.workspace,
          request.worktreePath,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("board supervisor: worktree removal on card delete failed", {
              cardId: request.cardId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
          ),
        );
        if (hookWarning !== null) {
          yield* Effect.logWarning("board supervisor: remove script failed on card delete", {
            cardId: request.cardId,
            hookWarning,
          });
        }
      }
      // Attempted whatever the worktree's state — a card can carry a branch
      // whose worktree was already reclaimed (at an earlier archive, or at
      // Done), and that branch is exactly the one nothing else will collect.
      yield* request.workspace.deleteCardBranch({ branch: request.branch }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: branch cleanup on card delete failed", {
            cardId: request.cardId,
            branch: request.branch,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  /**
   * Remove a worktree whatever it holds (`forceRemoveBoardCardWorktree`), in
   * the card's workspace: forced, so survivors are killed rather than holding
   * it back. Answers any remove-script failure.
   */
  const forceRemoveWorktree = (workspace: BoardCardWorkspace, worktreePath: string) =>
    workspace
      .retireWorktree({ worktreePath, kind: "forced", verifiedClean: false })
      .pipe(Effect.map((retired) => (retired?.outcome === "removed" ? retired.hookWarning : null)));

  /**
   * Per-card cleanup (settle on Done, reclaim on archive) off the reactor's worker, because both
   * probe the remote and a slow remote must never hold up step handling. FIFO keeps a card's
   * requests in event order; per-card guards cover a concurrent sweep.
   */
  const cardCleanupWorker = yield* makeDrainableWorker(
    (
      request:
        | { readonly kind: "settle"; readonly card: BoardCard }
        | { readonly kind: "reclaim"; readonly cardId: BoardCardId }
        | { readonly kind: "discard"; readonly cardId: BoardCardId }
        | { readonly kind: "cancelled"; readonly cardId: BoardCardId },
    ) =>
      Effect.gen(function* () {
        if (request.kind === "settle") {
          yield* settleCardAtDone(request.card);
          return;
        }
        if (request.kind === "discard") {
          yield* discardCardBranchWork(request.cardId);
          return;
        }
        if (request.kind === "cancelled") {
          yield* reclaimCancelledCardWorktree(request.cardId);
          return;
        }
        const card = yield* readCard(request.cardId);
        if (card !== null) yield* reclaimCardWorktree(card);
        if (card !== null) yield* reclaimArchivedIntegrationBranch(card);
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("board supervisor: card worktree cleanup failed", {
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  /**
   * Deleted cards' retirements, on a worker of their own: each runs
   * the remove scripts, minutes apiece at worst, and a Done settle or archive
   * reclaim queued behind one would wait that long for no reason.
   */
  const cardRetireWorker = yield* makeDrainableWorker(
    (request: Parameters<typeof retireDeletedCardWorktree>[0]) =>
      retireDeletedCardWorktree(request).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("board supervisor: card worktree cleanup failed", {
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  // Single-flight: triggers during a pass coalesce into one follow-up. `sweepQueued` is cleared as
  // a pass starts, so a trigger landing mid-pass queues a follow-up that sees its effect.
  let sweepQueued = false;
  let sweepRefreshQueued = false;
  const worktreeSweepWorker = yield* makeDrainableWorker(() =>
    Effect.suspend(() => {
      const refreshOpenPullRequests = sweepRefreshQueued;
      sweepQueued = false;
      sweepRefreshQueued = false;
      return sweepWorktrees({ refreshOpenPullRequests });
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("board supervisor: worktree sweep failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );
  const requestWorktreeSweep = (options?: { readonly refreshOpenPullRequests?: boolean }) =>
    Effect.suspend(() => {
      if (options?.refreshOpenPullRequests === true) sweepRefreshQueued = true;
      if (sweepQueued) return Effect.void;
      sweepQueued = true;
      return worktreeSweepWorker.enqueue(undefined);
    });

  /**
   * A human's "Remove worktree": removes a kept worktree past the safety rule but keeps the branch.
   * Refused unless the card is archived or in the done-role stage, since an active card's checkout
   * is where its agent writes.
   */
  const forceRemoveCardWorktree = Effect.fn("board-supervisor-forceRemoveCardWorktree")(function* (
    cardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined) return { outcome: "unknown-card" } as const;
    const worktree = card.worktree;
    if (worktree === null || worktree.status !== "ready" || worktree.path === null) {
      return { outcome: "no-worktree" } as const;
    }
    const stage = boardStageById(board, card.stage);
    const finished =
      card.archivedAt !== null || (stage !== null && effectiveBoardStageRole(stage) === "done");
    const cancelled = holdsCancelledWork(card);
    if (!finished && !cancelled) return { outcome: "not-finished" } as const;
    const workspace = yield* workspaceFor(card);
    if (workspace.checkoutPath === null) {
      // The card does hold a worktree; it is the project that cannot be found.
      yield* Effect.logWarning("board supervisor: forced removal has no project checkout", {
        cardId: card.id,
      });
      return { outcome: "failed" } as const;
    }
    const removed = yield* forceRemoveWorktree(workspace, worktree.path).pipe(
      Effect.map((hookWarning) => ({ hookWarning })),
      Effect.catchTags({ WorkerUnavailable: () => Effect.succeed(null) }),
    );
    // The worker is out of reach: nothing was removed, and saying so beats
    // recording a removal that did not happen.
    if (removed === null) return { outcome: "failed" } as const;
    const { hookWarning } = removed;
    yield* dispatchOptional({
      type: "board.card.reclaim-worktree",
      commandId: yield* commandId("force-reclaim-worktree"),
      cardId: card.id,
      outcome: "removed",
      forced: true,
      ...(hookWarning === null ? {} : { hookWarning }),
      createdAt: yield* nowIso,
    });
    if (cancelled) yield* deleteCancelledCardBranch(card.id);
    return { outcome: "removed" } as const;
  });

  const checkCardWorktree = Effect.fn("board-supervisor-checkCardWorktree")(function* (
    cardId: BoardCardId,
  ) {
    const card = yield* readCard(cardId);
    if (card === null) return { outcome: "unknown-card" } as const;
    // Forced, so a pull request merged since the last lookup counts. A lookup
    // that fails still leaves git's own proofs to the reclaim.
    yield* refreshCardPullRequestLink(card, { force: true }).pipe(Effect.ignore);
    const refreshed = yield* readCard(cardId);
    if (refreshed === null) return { outcome: "unknown-card" } as const;
    if (refreshed.worktree?.status !== "ready") return { outcome: "no-worktree" } as const;
    const attempt = holdsCancelledWork(refreshed)
      ? yield* reclaimCancelledCardWorktree(refreshed.id)
      : yield* settleCardAtDone(refreshed);
    if (attempt === null) {
      // Ready a moment ago: either it went meanwhile, or the card is not one
      // the cleanup reclaims (left Done, or the setting is off).
      const after = yield* readCard(cardId);
      return after?.worktree?.status === "ready"
        ? ({ outcome: "not-finished" } as const)
        : ({ outcome: "no-worktree" } as const);
    }
    return attempt;
  });

  /**
   * Cards whose human-initiated merge waits on a conflict fix. Without it, a hand-started thread in
   * the merge stage reporting success would merge unasked. In memory on purpose: after a restart
   * the human clicks Merge again, never a merge nobody initiated.
   */
  //
  // Keyed by WHICH fix was armed: a conflict runs the stage's own
  // prompt, a failed-checks refusal runs `DEFAULT_BOARD_CHECKS_FIX_PROMPT`.
  // One map rather than two sets, so the two arms can never both be live.
  const mergeAwaitingConflictFix = new Map<string, BoardMergeFixKind>();

  /**
   * Cards that have had their one automatic CI fix. Unlike a conflict fix it cannot be bounded by
   * `viaConflictFix`: its push re-runs CI, so the failure arrives later via a fresh merge call.
   * Cleared by a Merge click or a fresh merge-stage arrival; a restart grants one more fix.
   */
  const checksFixSpent = new Set<string>();

  /**
   * Unarmed cards whose merge waits on the checks their own CI fix re-ran: the human asked for that
   * merge, so it rides the retry ladder for this one wait instead of refusing on pending CI.
   * Dropped on leaving the merge stage or a new Merge click; in memory, so a restart waits a click.
   */
  const mergeAwaitingChecks = new Set<string>();

  /** When the board last readied each card's draft, so a Merge click
      inside the ladder's first rung waits for the CI that readying started.
      In-memory: after a restart the window has long passed anyway. */
  const readiedAt = new Map<string, number>();

  /** Drop a card's pending merge. Called from every path that ends a conflict
      fix WITHOUT the success that would complete the merge — settlement,
      recovery escalation and spawn failure — because each of those hands the
      card back to a human, and only a human may start a merge. */
  const disarmPendingMerge = (cardId: BoardCardId): void => {
    mergeAwaitingConflictFix.delete(String(cardId));
  };

  /**
   * Ready a draft pull request, only when the forge says live it is an open draft (so retries ready
   * once). On arrival it also needs `draftPullRequests` on; a merge attempt skips that. A failure
   * writes a note, never throws. True when readied now: the caller must not merge yet, since the CI
   * readying started has not registered its checks.
   */
  const markCardPullRequestReady = Effect.fn("board-supervisor-markCardPullRequestReady")(
    function* (card: BoardCard, options: { readonly forMerge: boolean }) {
      const pullRequest = card.pullRequest;
      if (pullRequest === null || pullRequest.state !== "open") return false;
      if (!options.forMerge && !(yield* draftPullRequestsOn(card))) return false;
      const result = yield* (yield* workspaceFor(card))
        .markPullRequestReady({ number: pullRequest.number })
        .pipe(Effect.catch((error) => Effect.succeed({ failure: error.detail } as const)));
      if (result === "not-draft") return false;
      if (result === "readied") {
        // Bypass the lookup cache: it would otherwise keep the Draft tag up
        // for as long as the cached answer lives.
        yield* refreshCardPullRequestLink(card, { force: true });
        readiedAt.set(String(card.id), yield* clockNowMs);
      } else if (card.autoMergeHold?.retryAt != null) {
        return false;
      }
      yield* dispatch({
        type: "board.card.record-note",
        commandId: yield* commandId("pull-request-ready"),
        cardId: card.id,
        // A failure is a merge refusal only on the merge path. On arrival no
        // merge was attempted and the next one retries, so it stays neutral.
        kind:
          result === "readied" || !options.forMerge
            ? "card-pull-request-ready"
            : "card-merge-refused",
        detail:
          result === "readied"
            ? `PR #${pullRequest.number} marked ready; CI started.`
            : `Could not mark PR #${pullRequest.number} ready for review: ${result.failure} The next merge attempt tries again.`,
        createdAt: yield* nowIso,
      });
      return result === "readied";
    },
  );

  /** The merge outcome for a pull request readied a moment ago: a
      soft refusal, so the merge waits a rung for the CI it just started. */
  const justReadiedRefusal = (
    number: number,
  ): Extract<BoardMergeAttemptResult, { readonly outcome: "refused" }> => ({
    outcome: "refused",
    detail: `PR #${number} was a draft, so it was marked ready for review just now and its CI has only started. Merging once those checks pass.`,
    mergeState: null,
  });

  /**
   * Ask the forge once, from structured mergeability rather than refusal prose, why a merge was
   * refused. Mistaking a policy block for a conflict spawns an agent to "fix" a healthy branch, so
   * a conflict must be proven. The result also feeds `recordAutoMergeOutcome`.
   */
  const probeMergeState = Effect.fn("board-supervisor-probeMergeState")(function* (
    card: BoardCard,
  ) {
    const pullRequest = card.pullRequest;
    if (pullRequest === null) return { state: null, failure: undefined };
    return yield* (yield* workspaceFor(card))
      .pullRequestMergeState({ number: pullRequest.number })
      .pipe(
        Effect.map((state) => ({ state, failure: undefined })),
        // The probe's own words go on the card: a probe that failed is
        // not a forge that gave no reason, and the failure usually names its fix.
        Effect.catch((error) => Effect.succeed({ state: null, failure: error.detail })),
      );
  });

  /**
   * Merge a card's pull request, then advance it. Always human-initiated. A conflict refusal starts
   * the merge stage's conflict step, whose success finishes this merge; any other refusal reports
   * the forge's reason and stops, with no automatic retry.
   */
  const mergeCardPullRequest = Effect.fn("board-supervisor-mergeCardPullRequest")(function* (
    cardId: BoardCardId,
    /** True when this call is the completion of a conflict fix rather than a
        fresh Merge click. Bounds the conflict→merge cycle (see below). */
    viaConflictFix = false,
  ) {
    const card = yield* readCard(cardId);
    if (card === null) return { outcome: "unknown-card" } as const;

    // A cached re-check (2-minute TTL): it narrows the staleness window, not closes it. Acting on a
    // stale `open` costs a refused merge, never a wrong one, because the forge decides.
    yield* refreshCardPullRequest(card);
    const fresh = (yield* readCard(cardId)) ?? card;

    const pullRequest = fresh.pullRequest;
    if (pullRequest === null) return { outcome: "no-pull-request" } as const;
    if (pullRequest.state !== "open") {
      return { outcome: "not-open" as const, state: pullRequest.state };
    }

    // The stage gate, enforced HERE and not only on the button. The client
    // renders Merge only in the merge-role stage, but an RPC is reachable
    // without that button, and merging a card still mid-review would merge a
    // branch the review agent is actively posting on.
    const stages = yield* readBoard;
    const mergeStage = boardStageWithRole(stages, "merge");
    if (mergeStage === null || fresh.stage !== mergeStage.stageId) {
      return { outcome: "wrong-stage" as const };
    }

    // The merge-click staleness gate: a sibling may have merged while the card sat here, so a stale
    // card goes back to the review-role stage instead of merging an unreviewed diff. Skipped when
    // there is no review-role stage. `resolveBaseStale` owns the sub-board scope rules.
    if (yield* resolveBaseStale(fresh)) {
      const reviewStage = boardStageWithRole(stages, "review");
      if (reviewStage !== null) {
        // A conflict-fix completion re-entering here must not leave the merge
        // armed while the card walks back through review.
        disarmPendingMerge(fresh.id);
        yield* dispatch({
          type: "board.card.record-note",
          commandId: yield* commandId("stale-base-note"),
          cardId: fresh.id,
          kind: "card-base-stale",
          detail: `Held the merge: base branch '${
            fresh.worktree?.baseRefName ?? "?"
          }' moved since the last review round started. Rebasing onto it, then one more review round.`,
          createdAt: yield* nowIso,
        });
        yield* dispatch({
          type: "board.card.move",
          commandId: yield* commandId("stale-base-return"),
          cardId: fresh.id,
          toStage: reviewStage.stageId,
          override: true,
          createdAt: yield* nowIso,
        });
        return { outcome: "stale-base" } as const;
      }
    }

    // Ready a draft arrival did not, keyed on the recorded link so ordinary merges spend no forge
    // read. Readying starts CI, so this attempt stops and the merge waits on the retry ladder, an
    // unarmed card too, since a human asked for it.
    if (
      pullRequest.isDraft === true &&
      (yield* markCardPullRequestReady(fresh, { forMerge: true }))
    ) {
      mergeAwaitingChecks.add(String(fresh.id));
      return justReadiedRefusal(pullRequest.number);
    }

    // An open pull request keeps the base it was created against, so after a retarget merging it
    // would land these commits on a branch the card is no longer based on. Refused, not retargeted:
    // the board has no forge operation that moves a base. Compared against the recorded base.
    const recordedBase = fresh.worktree?.baseRefName ?? null;
    if (recordedBase !== null && pullRequest.baseRef !== recordedBase) {
      return {
        outcome: "refused" as const,
        detail: `Its pull request still merges into '${pullRequest.baseRef}', but this card is based on '${recordedBase}'. Retarget the pull request at '${recordedBase}' before merging.`,
      };
    }

    // The project's checkout, not the card's worktree: the merge runs the host CLI in the project
    // root, so only its absence makes a card unmergeable.
    const workspace = yield* workspaceFor(fresh);
    if (workspace.checkoutPath === null) return { outcome: "no-workspace" } as const;

    const settings = yield* boardSettings;
    // Resolved from the merge-role stage, not `fresh.stage`, so the configured strategy is the one
    // that runs even if the two ever differ. The card's own override, then its nearest ancestor
    // group's, wins over it.
    const boardNow = yield* readBoard;
    const exec = resolveBoardStageExecution(
      settings,
      mergeStage.stageId,
      boardProjectStageConfig(boardNow, fresh.projectId),
    );
    const { strategy } = resolveBoardCardMergeStrategy({
      card: fresh,
      ancestors: boardCardAncestors(boardNow, fresh),
      stageStrategy: isBoardMergeStageExecution(exec) ? exec.strategy : null,
    });

    const failure = yield* workspace
      .mergePullRequest({ number: pullRequest.number, method: strategy })
      .pipe(
        Effect.as(null),
        Effect.catch((error) => Effect.succeed(error)),
      );

    if (failure !== null) {
      // Only the host's own refusal is worth a probe. Other refusals (unsupported strategy, missing
      // permission or CLI, rate limit) carry words that name the fix; probing would describe a
      // healthy pull request instead. No conflict route, and the ladder stops.
      if (failure.refusal !== undefined && failure.refusal !== "host") {
        return {
          outcome: "refused" as const,
          detail: failure.detail,
          mergeState: null,
          permanent: failure.refusal === "blocked",
        };
      }
      // One probe answers both questions: is this a conflict, and what does the
      // card say about it.
      const probe = yield* probeMergeState(fresh);
      // When the forge cannot say why, git can still prove a conflict, so only `conflict` changes
      // anything. An unread refusal is never guessed to be a conflict: starting a fix agent is the
      // expensive mistake.
      const state =
        probe.state === null &&
        (yield* workspace
          .probeLocalMergeConflict({
            headBranch: pullRequest.headBranch,
            baseBranch: pullRequest.baseRef,
          })
          .pipe(
            Effect.map((probe) => probe.result),
            Effect.orElseSucceed(() => "unknown" as const),
          )) === "conflict"
          ? LOCAL_CONFLICT_MERGE_STATE
          : probe.state;
      // The host's own words ride along. Without them a clean pull
      // request's refusal had no explanation at all.
      const detail = boardHostMergeRefusalReason(state, probe.failure, failure.detail);
      // Both automatic fixes run in the card's OWN worktree. A linked
      // pull request on another branch (a stack layer, a card with no
      // worktree) would have that agent fix the wrong branch, so the refusal
      // goes to a human instead, naming the branch to fix.
      if (
        pullRequest.linked === true &&
        pullRequest.headBranch !== fresh.worktree?.branch &&
        (state?.blockedReason === "conflict" ||
          (state !== null &&
            state.blockedReason === null &&
            !state.checksUnread &&
            state.checks.failed > 0))
      ) {
        return {
          outcome: "refused" as const,
          detail: `${detail} The pull request is on ${pullRequest.headBranch}, not this card's branch; fix it there.`,
          mergeState: state,
        };
      }
      if (state?.blockedReason === "conflict" && !viaConflictFix) {
        // `viaConflictFix` bounds this to one automatic fix per click; re-conflicting falls through
        // to `refused`. Report `conflict` (which disables Merge) only when a fix will run:
        // pre-check the silent guards `beginStageRun` applies after the command lands, and use
        // `dispatchLanded`. Otherwise disarm and refuse, leaving the button live.
        const liveStep = boardCardStepState(stages, fresh.id);
        const stageBusy =
          hasLiveStageThread(fresh, fresh.stage) ||
          (liveStep !== null && !isBoardTerminalStepStatus(liveStep.status));
        if (stageBusy) {
          return {
            outcome: "refused" as const,
            detail: `${detail} A thread is already open on this stage; close it before merging.`,
          };
        }
        mergeAwaitingConflictFix.set(String(fresh.id), "conflict");
        const started = yield* dispatchLanded({
          type: "board.card.start-stage-thread",
          commandId: yield* commandId("merge-conflict"),
          cardId: fresh.id,
          createdAt: yield* nowIso,
        });
        if (!started) {
          disarmPendingMerge(fresh.id);
          return { outcome: "refused" as const, detail };
        }
        return { outcome: "conflict" as const, detail };
      }
      // Failing CI gets one automatic fix until the next Merge click (`checksFixSpent`); conflicts
      // outrank it. Unread checks and refusals the forge pinned on something else (a draft, a
      // branch behind its base) are never fixed: a push cannot clear them.
      if (
        state !== null &&
        state.blockedReason === null &&
        !state.checksUnread &&
        state.checks.failed > 0 &&
        !checksFixSpent.has(String(fresh.id))
      ) {
        const liveStep = boardCardStepState(stages, fresh.id);
        const stageBusy =
          hasLiveStageThread(fresh, fresh.stage) ||
          (liveStep !== null && !isBoardTerminalStepStatus(liveStep.status));
        if (stageBusy) {
          return {
            outcome: "refused" as const,
            detail: `${detail} A thread is already open on this stage; close it before merging.`,
            mergeState: state,
          };
        }
        checksFixSpent.add(String(fresh.id));
        mergeAwaitingConflictFix.set(String(fresh.id), "checks");
        const started = yield* dispatchLanded({
          type: "board.card.start-stage-thread",
          commandId: yield* commandId("merge-checks-fix"),
          cardId: fresh.id,
          createdAt: yield* nowIso,
        });
        if (!started) {
          disarmPendingMerge(fresh.id);
          return { outcome: "refused" as const, detail, mergeState: state };
        }
        return { outcome: "checks-fix" as const, detail };
      }
      return { outcome: "refused" as const, detail, mergeState: state };
    }

    // Record the merged state before moving, so a card arriving at Done is
    // already known to be merged — which is what the branch cleanup gates on.
    yield* refreshCardPullRequest(fresh);
    const merged = (yield* readCard(cardId)) ?? fresh;

    // Fast-forward the project root's local base branch, never a card worktree, so new worktrees
    // fork from post-merge history. Best-effort: a failure here never fails a landed merge.
    const baseBranch = merged.pullRequest?.baseRef ?? null;
    if (baseBranch !== null) {
      // Only on this card's worker: every other worker sees the merge
      // through the fetch `measureBaseTip` makes.
      yield* workspace.pullMergedBaseBranch({ baseBranch }).pipe(
        Effect.flatMap((sync) =>
          sync.updated || sync.skippedReason === null
            ? Effect.void
            : Effect.logWarning(
                `board merge: local base branch ${baseBranch} not updated: ${sync.skippedReason}`,
              ),
        ),
        // Truly best-effort: the merge has already landed on the forge, so
        // nothing this fast-forward does — down to an unexpected defect from the
        // git driver — may change the card's merged outcome. The whole block is
        // swallowed to a log so it can never reach the outer merge catch.
        Effect.catchCause((cause) =>
          Effect.logWarning("board merge: base branch sync failed", { cause: Cause.pretty(cause) }),
        ),
      );
    }

    const board = yield* readBoard;
    const nextStage = boardNextStageId(board, merged.stage, merged.projectId);
    if (nextStage !== null) {
      yield* dispatch({
        type: "board.card.move",
        commandId: yield* commandId("merge-advance"),
        cardId: merged.id,
        toStage: nextStage,
        // No key: an advance names no position, so the card keeps its own —
        // except into the done-role stage, where the decider lands it on top.
        createdAt: yield* nowIso,
      });
    }
    return { outcome: "merged" as const, number: pullRequest.number };
  });

  /**
   * "Submit for merge, no review": selects a short unattended step that pushes the branch and
   * ensures an open pull request; the card moves only when it succeeds, since Merge needs an open
   * one. Request-scoped and total: every refusal is a value the card can show.
   */
  const submitCardForMerge = Effect.fn("board-supervisor-submitCardForMerge")(function* (
    cardId: BoardCardId,
  ) {
    const card = yield* readCard(cardId);
    if (card === null || card.archivedAt !== null) return { outcome: "unknown-card" } as const;
    const board = yield* readBoard;
    const stage = boardStageById(board, card.stage);
    // The stage gate, enforced here and not only on the caret: the RPC is
    // reachable without the button, and submitting a card that is still
    // planning would push a branch nobody built.
    if (stage === null || effectiveBoardStageRole(stage) !== "build") {
      return { outcome: "wrong-stage" } as const;
    }
    // Nowhere to route to. Refused up front rather than after the step has
    // run, so the user is not charged an agent run for a board that cannot
    // use its result.
    if (boardStageWithRole(board, "merge") === null) return { outcome: "no-merge-stage" } as const;
    // The dependency gate is not overridable, and the directed move
    // would be refused by the decider anyway — say so instead of teaching the
    // rule by refusal after an agent has already pushed.
    if (card.blocked) return { outcome: "blocked" } as const;
    // Pre-check the decider's other forward gates: they bite only at the advance after the step has
    // pushed and opened a pull request, leaving the card stuck in Building with no explanation.
    // `advanceStage` still notes a gate closing mid-step.
    const unfinished = boardCardUnfinishedChildren(board, card.id);
    if (unfinished.length > 0) {
      return {
        outcome: "refused",
        detail: `This card advances through its ${unfinished.length} plan card${
          unfinished.length === 1 ? "" : "s"
        } (${unfinished
          .map((child) => child.key)
          .join(", ")}); it cannot pass '${stage.label}' until those finish.`,
      } as const;
    }
    if (boardCardPendingSplit(board, card.id)) {
      return {
        outcome: "refused",
        detail: `This card has ${boardCardPlans(board, card.id).length} unapproved plans; approve the split (or re-propose a single plan) before advancing it.`,
      } as const;
    }
    // Nothing to push.
    if (card.worktree === null) return { outcome: "no-branch" } as const;
    // One step at a time. The caret only shows on a HELD card, so this is
    // a stale client or a race.
    const live = boardCardStepState(board, card.id);
    if (live !== null && !isBoardTerminalStepStatus(live.status)) {
      return { outcome: "step-running" } as const;
    }

    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(
      settings,
      card.stage,
      boardProjectStageConfig(board, card.projectId),
    );
    // Read off the stage's own config, symmetrically with `mergeCardPullRequest`
    // reading the merge member's `strategy`. A build-role stage always resolves
    // to the build member, so the fallback is unreachable in practice and is
    // here so a hand-edited settings file cannot make the button do nothing.
    const submit = isBoardBuildStageExecution(exec)
      ? exec.submit
      : DEFAULT_BOARD_BUILD_STAGE_EXECUTION.submit;
    // The step's own model, else the stage's. The card's per-stage override is not applied: this is
    // machinery, and the model a card is built on says nothing about who writes its description.
    const model =
      submit.model ?? resolveBoardStageModelSelection(exec.model, yield* fallbackModelSelection);
    const landed = yield* dispatchLanded({
      type: "board.card.select-step",
      commandId: yield* commandId("submit-step"),
      cardId: card.id,
      stepId: BOARD_SUBMIT_STEP_ID,
      stepLabel: BOARD_SUBMIT_STEP_LABEL,
      stageLabel: stage.label,
      prompt: submit.prompt,
      providerInstanceId: model.instanceId,
      model: model.model,
      runtimeMode: effectiveBoardRuntimeMode(submit.runtimeMode, "build"),
      ...(model.options === undefined ? {} : { modelOptions: model.options }),
      mode: "build",
      // Unattended whatever the card's human-in-the-loop stance: there is
      // no conversation to have about pushing a branch, and the prompt tells it
      // to complete `failed` rather than guess.
      humanInLoop: false,
      maxAttempts: submit.maxAttempts,
      timeoutMs: submit.timeoutMs,
      // Starts no review round: carry the recorded tip forward.
      baseTipAtRoundStart: yield* baseTipForPlan(card, false),
      createdAt: yield* nowIso,
    });
    // The only invariant that can refuse this command after the guards above is
    // the decider's live-step one, which means another step won the race.
    if (!landed) return { outcome: "step-running" } as const;
    yield* schedule();
    return { outcome: "started" } as const;
  });

  /**
   * Open review round `round`: the one write behind a human's request or ruling and CI's send-back.
   * One awaited `set-review-carry` (clearing a stop, waiving a stuck round), so a caller's stage
   * move can never land before it.
   */
  const openReviewRound = Effect.fn("board-supervisor-openReviewRound")(function* (input: {
    readonly cardId: BoardCardId;
    readonly round: number;
    readonly reason: string;
    readonly stuckRound?: number;
    readonly carry?: BoardReviewCarry;
  }) {
    return yield* dispatchLanded({
      type: "board.card.set-review-carry",
      commandId: yield* commandId(input.reason),
      cardId: input.cardId,
      runThroughRound: input.round,
      clearStopAfterRound: true,
      ...(input.stuckRound === undefined ? {} : { stuckWaivedThrough: input.stuckRound }),
      ...(input.carry === undefined ? {} : { carry: { round: input.round, entry: input.carry } }),
      createdAt: yield* nowIso,
    });
  });

  /**
   * "Another review round" / "Request review" from every entry point. The override is written
   * first, server-side: moving first would re-plan a converged loop and bounce the card back or
   * open an empty conversation. Request-scoped and total: every refusal is a sentence the card
   * shows. With no review completions it resolves to round 1.
   */
  const requestReviewRound = Effect.fn("board-supervisor-requestReviewRound")(function* (
    cardId: BoardCardId,
    carry?: BoardRequestReviewRoundInput["carry"] | undefined,
  ) {
    const card = yield* readCard(cardId);
    if (card === null || card.archivedAt !== null) return { outcome: "unknown-card" } as const;
    const board = yield* readBoard;
    const reviewStage = boardStageWithRole(board, "review");
    // No loop to run. Refused up front rather than after a move nothing can
    // execute.
    if (reviewStage === null) return { outcome: "no-review-stage" } as const;
    const stage = boardStageById(board, card.stage);
    const role = stage === null ? null : effectiveBoardStageRole(stage);
    // Done is excluded: leaving the done-role stage retires the pull request into history, so
    // pulling a merged card back would orphan it.
    if (role !== "review" && role !== "merge") return { outcome: "wrong-stage" } as const;
    // Nothing to review.
    if (card.worktree === null) return { outcome: "no-branch" } as const;
    // One step at a time, the decider's own invariant. This is also what
    // keeps an armed merge-conflict fix from being superseded mid-rebase: a
    // conflict fix IS a live step, so the button is disabled rather than
    // killing a rebase someone is halfway through.
    const live = boardCardStepState(board, card.id);
    if (live !== null && !isBoardTerminalStepStatus(live.status)) {
      return { outcome: "step-running" } as const;
    }

    // A stuck loop takes a ruling, never a plain request: a fresh
    // round would only re-raise the same dispute. A ruling on a loop that is
    // not stuck is a stale client.
    const completions = boardCardStepCompletions(board, card.id);
    const stuck = boardReviewStuckState({ completions, overrides: card.reviewOverrides });
    if (carry === undefined && stuck !== null) return { outcome: "stuck" } as const;
    if (carry !== undefined && stuck === null) return { outcome: "not-stuck" } as const;

    // One past the highest round the loop has entered — the same number the
    // decider clamps to, so the write it validates is the write it was sent.
    const round = boardReviewRoundsStarted({ completions, liveStepId: null }) + 1;

    // A Merge click that hit a conflict leaves the merge ARMED, and a card must
    // not walk back through review still armed — the stale-base return disarms
    // for exactly this reason, and this is the same trip for a different cause.
    disarmPendingMerge(card.id);

    const landed = yield* openReviewRound({
      cardId: card.id,
      round,
      reason: "request-review-round",
      ...(carry === undefined || stuck === null
        ? {}
        : {
            stuckRound: stuck.round,
            carry: boardReviewCarryFromStuck({
              round: stuck.round,
              findings: stuck.findings,
              ruling: carry.ruling,
              note: carry.note,
            }),
          }),
    });
    if (!landed) return { outcome: "failed" } as const;

    // The only record of WHY. `card-moved` says where, never why, and a
    // card jumping from Ready for merge back to Code review with no account of
    // itself reads as a drag that silently snapped back.
    yield* dispatch({
      type: "board.card.record-note",
      commandId: yield* commandId("request-review-round-note"),
      cardId: card.id,
      kind: "card-review-round-requested",
      detail:
        carry?.ruling === "fix"
          ? `Asked for the stuck findings to be fixed in review round ${round}.`
          : carry?.ruling === "dismiss"
            ? `Ruled the stuck findings not issues and requested review round ${round}.`
            : round === 1
              ? "Requested a first review round on this branch."
              : `Requested review round ${round} on this branch.`,
      createdAt: yield* nowIso,
    });

    // Skipped when the card is already there, which is what makes the
    // converged-in-place case the same call: the update above is enough, and a
    // move to the stage the card is on would be refused anyway.
    if (card.stage !== reviewStage.stageId) {
      yield* dispatch({
        type: "board.card.move",
        commandId: yield* commandId("request-review-round-move"),
        cardId: card.id,
        toStage: reviewStage.stageId,
        override: true,
        createdAt: yield* nowIso,
      });
    }
    yield* schedule();
    return { outcome: "started" as const, round };
  });

  const handleTurnCompleted = Effect.fn("board-supervisor-handleTurnCompleted")(function* (
    /** Read by the caller, which needs the same board to decide whether this is
        even a board thread — see `handleTurnEnded`. */
    board: BoardState,
    threadId: ThreadId,
    /** The turn that just ENDED, off the runtime event. Optional because the
        base event schema makes it optional and not every adapter stamps it. */
    completedTurnId: string | undefined,
  ) {
    const found = stepThreadCard(board, threadId);
    if (found === null) return;
    if (found.state.status !== "running" && found.state.status !== "awaiting-input") return;
    // Only a SUCCEEDED completion hands the step to the completion handler for
    // good. A `failed`/`blocked` completion must not disarm death detection —
    // after a failure + recovery nudge, a retry thread that dies silently
    // still needs to be recovered here.
    const completed = boardCardStepCompletions(board, found.card.id).some(
      (entry) => entry.stepId === found.state.stepId && entry.outcome === "succeeded",
    );
    if (completed) return; // the completion handler owns this step
    const shell = yield* liveThread(threadId);
    // Another turn is live, typically a recovery nudge; its own completion re-runs this. Compared
    // by identity, because the projection usually still names the just-ended turn as live. Without
    // a `turnId`, presence is the conservative test. A nudge racing past this is bounded by the
    // recovery ceiling.
    const liveTurnId = shell?.activeTurnRef ?? null;
    const namedByAnotherTurn =
      liveTurnId !== null && (completedTurnId === undefined || liveTurnId !== completedTurnId);
    // A human's message sent while the previous turn was finishing has no turn id yet, so the
    // identity test misses it; `supersededByPendingTurn` reads the requested-but-unstarted turn.
    // Checked second (it costs a query) and independently of the possibly stale shell.
    if (
      (namedByAnotherTurn || (yield* supersededByPendingTurn(found.state))) &&
      !(shell?.awaitingUserInput ?? false)
    ) {
      return;
    }
    if (shell !== undefined && shell.awaitingUserInput) {
      // Triage and adjudication never wait on a human. An attempt
      // already answered is resuming: the projection may still show the
      // question.
      if (found.state.status === "running" && isReviewDecidingStep(found.state)) {
        if (!answeredReviewQuestion(found.state)) {
          yield* handleReviewStepQuestion(found.card, found.state);
        }
        return;
      }
      // A proper structured question — "Input needed", not a failure, no retry
      // consumed. Move (or keep) the step on the human gate. A no-op when
      // it is already awaiting-input.
      if (found.state.status === "running") {
        yield* parkStepForInput({ card: found.card, state: found.state, reason: "question" });
      }
      return;
    }
    // Ended to wait on its own background work: a wait, not a stop, supervised by the timeout
    // sweep's check-ins rather than recovery. A usage limit is checked first. A parked unattended
    // step goes back to running, since the sweep only checks in on running steps. A
    // human-in-the-loop run still parks on a monitor.
    const backgroundLiveness = shell?.backgroundWork ?? null;
    if (
      backgroundLiveness !== null &&
      (backgroundLiveness === "working" || !found.state.humanInLoop)
    ) {
      if (!found.state.humanInLoop) {
        if (yield* parkForUsageLimit(found)) {
          backgroundWaits.delete(String(threadId));
          return;
        }
        if (found.state.status !== "running" && !(yield* resumeParkedStep(threadId))) return;
        yield* noteBackgroundTurnEnd(found, threadId);
      }
      return;
    }
    backgroundWaits.delete(String(threadId));
    // The one free turn-ending a human's turn bought: spent here only, since the timeout sweep also
    // reaches `recoverStep` and must still catch a hung agent. One ending, then supervision
    // resumes; an open-ended suppression could never be cleared.
    if (found.state.humanTurnAt !== null) {
      yield* dispatchOptional({
        type: "board.card.note-human-turn",
        commandId: yield* commandId("consume-human-turn"),
        cardId: found.card.id,
        stepId: found.state.stepId,
        at: null,
        createdAt: yield* nowIso,
      });
      return;
    }
    // A human-in-the-loop run that ends a turn is waiting on the human, not dead: no recovery, no
    // attempt spent. Park it so the card stops showing as worked on, recording whether it ended on
    // a prose question, since agents ask in prose despite the envelope.
    if (found.state.humanInLoop) {
      // Already parked and still parked: re-deciding the reason would churn a
      // delta per turn.completed for no change.
      if (found.state.status === "awaiting-input") return;
      yield* parkStepForInput({
        card: found.card,
        state: found.state,
        reason: (yield* endedWithQuestion(found.state)) ? "question" : "stopped",
      });
      return;
    }
    // The usage-limit park, only for unattended steps: a human-in-the-loop stop is waiting on a
    // person, and waking it could push an unanswered question back into work. Fires only on a limit
    // with a reset time; otherwise falls through to recovery.
    if (yield* parkForUsageLimit(found)) return;
    // Unattended, running with no question → died mid-work. Awaiting-input with
    // no pending question → the human answered and the agent ran another turn
    // without completing (or died); either way death detection is re-armed.
    yield* recoverStep(found);
  });

  /**
   * A turn ending, for every thread on the machine. One board read serves the step handler and the
   * release sweep, which runs only for a thread the board owns (any live link or an abandoned
   * thread): a turn ending is what unblocks a release, and foreign threads would make it costly.
   */
  const handleTurnEnded = Effect.fn("board-supervisor-handleTurnEnded")(function* (
    threadId: ThreadId,
    completedTurnId: string | undefined,
  ) {
    const board = yield* readBoard;
    // The interrupted interview run's end is the steer's to follow, not an
    // ending. Any turn end clears the marker: the projection that named the run
    // may have been stale, and the steer turn's own end must be read.
    const steeredRun = steeredThreads.get(String(threadId));
    steeredThreads.delete(String(threadId));
    boardInterruptedRuns.delete(String(threadId));
    if (steeredRun === undefined || completedTurnId !== steeredRun) {
      yield* handleTurnCompleted(board, threadId, completedTurnId);
    }
    // Retired links count: their thread still has to be settled.
    const owned =
      board.cards.some((card) =>
        card.threadLinks.some((link) => link.threadId === threadId && link.tombstonedAt === null),
      ) || abandonedThreads.has(String(threadId));
    if (!owned) return;
    yield* releaseFinishedThreads;
  });

  /** A rail row for something auto-planning did, or could not do. */
  const autoPlanNote = Effect.fn("board-supervisor-autoPlanNote")(function* (
    cardId: BoardCardId,
    detail: string,
  ) {
    yield* dispatch({
      type: "board.card.record-note",
      commandId: yield* commandId("auto-plan-note"),
      cardId,
      kind: "card-auto-planned",
      detail,
      createdAt: yield* nowIso,
    });
  });

  /**
   * End a pending auto-plan request without approving anything. The
   * card goes back to ordinary planning: later runs are human-in-the-loop
   * again, their plan waits on the gate, and the Auto-plan button is back.
   */
  const endAutoPlan = Effect.fn("board-supervisor-endAutoPlan")(function* (
    cardId: BoardCardId,
    detail: string,
    /** A human caused the stop: Auto-plan goes off with the run. */
    options: { readonly turnOff?: boolean } = {},
  ) {
    const ended = yield* dispatchOptional({
      type: "board.card.end-auto-plan",
      commandId: yield* commandId("end-auto-plan"),
      cardId,
      ...(options.turnOff === true ? { turnOff: true } : {}),
      createdAt: yield* nowIso,
    });
    if (ended) yield* autoPlanNote(cardId, detail);
  });

  /**
   * End the auto-plan request when the board stopped driving the run: a step parked on a human or
   * settled `failed`. Reads the live step, so one already back at work keeps its request.
   */
  const endAutoPlanIfUndriven = Effect.fn("board-supervisor-endAutoPlanIfUndriven")(function* (
    cardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || !isBoardCardAutoPlanPending(card)) return;
    const stage = boardStageById(board, card.stage);
    if (stage === null || effectiveBoardStageRole(stage) !== "plan") return;
    const state = boardCardStepState(board, card.id);
    if (state === null || state.stepId !== card.stage) return;
    const undriven =
      state.status === "awaiting-input" ||
      state.status === "paused" ||
      state.status === "failed" ||
      (state.status === "stalled" && state.retryAt === null);
    if (!undriven) return;
    yield* endAutoPlan(
      card.id,
      "Auto-plan stopped: the planning run stopped or is waiting on you, so nothing will be approved automatically. Finish planning by hand, or click Auto-plan again.",
    );
  });

  /**
   * Approve an unattended planning run's plan only when the card's Auto-build authorises it;
   * otherwise it waits at the human gate with the run record pending. A split's new group starts
   * only when the card's own Auto-build is on. A refused approval ends the run record.
   */
  const approveAutoPlannedCard = Effect.fn("board-supervisor-approveAutoPlannedCard")(function* (
    card: BoardCard,
    state: BoardCardStepState,
  ) {
    const board = yield* readBoard;
    const resolved = automationIn(board, card);
    const plans = boardCardPlans(board, card.id).toSorted(
      (left, right) => left.ordinal - right.ordinal,
    );
    if (plans.length === 0) {
      yield* endAutoPlan(
        card.id,
        "Auto-plan finished without proposing a plan, so nothing was approved. Plan the card by hand, or turn Auto-plan off and on again.",
      );
      return;
    }
    const buildStage = boardStageWithRole(board, "build");
    const split = plans.length >= 2;
    const authorised =
      resolved.autoBuild.value || (split && resolved.autoBuild.waitingForGroupStart);
    if (!authorised) {
      yield* autoPlanNote(
        card.id,
        resolved.autoBuild.waitingForGroupStart
          ? `Auto-plan finished. The plan waits for your approval, or is approved when ${resolved.autoBuild.inheritedFrom?.key ?? "its group"} starts.`
          : "Auto-plan finished. The plan waits for your approval.",
      );
      return;
    }
    if (split) {
      const refusal = yield* dispatchRefusal({
        type: "board.plans.approve",
        commandId: yield* commandId("auto-plan-approve-split"),
        cardId: card.id,
        autoBuild: true,
        autoPlan: resolved.autoPlan.value,
        autoMerge: resolved.autoMerge.value,
        createdAt: yield* nowIso,
      });
      if (refusal !== null) {
        yield* endAutoPlan(card.id, `Auto-plan could not approve the split: ${refusal}`);
        return;
      }
      const titles = plans.map((plan) => plan.title).join("; ");
      yield* dispatch({
        type: "board.card.record-decisions",
        commandId: yield* commandId("auto-plan-split-decision"),
        cardId: card.id,
        decisions: [
          {
            question: "Build this card as one plan, or split it?",
            decision: clip(
              `Split into ${plans.length} cards: ${titles}`,
              BOARD_DECISION_TEXT_MAX_LENGTH,
            ),
            reason: clip(
              card.splitRationale ?? "The agent proposed a split.",
              BOARD_DECISION_REASON_MAX_LENGTH,
            ),
            flag: "important",
            decidedBy: "agent",
          },
        ],
        stepId: state.stepId,
        threadId: state.threadId,
        createdAt: yield* nowIso,
      });
      if (!resolved.autoBuild.value || buildStage === null) {
        yield* autoPlanNote(
          card.id,
          `Auto-plan approved the split into ${plans.length} cards. Nothing starts until ${resolved.autoBuild.inheritedFrom?.key ?? "the group"} starts.`,
        );
        return;
      }
      const started = yield* dispatchRefusal({
        type: "board.card.move",
        commandId: yield* commandId("auto-plan-start-group"),
        cardId: card.id,
        toStage: buildStage.stageId,
        override: true,
        createdAt: yield* nowIso,
      });
      yield* autoPlanNote(
        card.id,
        started === null
          ? `Auto-plan approved the split into ${plans.length} cards and started the group.`
          : `Auto-plan approved the split into ${plans.length} cards; the group did not start: ${started}`,
      );
      return;
    }
    const next = boardNextStageId(board, card.stage, card.projectId);
    if (next === null) return;
    const toReady = yield* dispatchRefusal({
      type: "board.card.move",
      commandId: yield* commandId("auto-plan-approve"),
      cardId: card.id,
      toStage: next,
      createdAt: yield* nowIso,
    });
    if (toReady !== null) {
      yield* endAutoPlan(card.id, `Auto-plan could not approve the plan: ${toReady}`);
      return;
    }
    if (buildStage === null || next === buildStage.stageId) return;
    yield* startAutoBuildCard(card.id, "Auto-plan approved the plan");
  });

  /**
   * Start a card waiting before build because Auto-build is on: its own, as an `auto-build` move,
   * or a begun group's, as the cascade's move. Unmet dependencies leave it waiting.
   */
  const startAutoBuildCard = Effect.fn("board-supervisor-startAutoBuildCard")(function* (
    cardId: BoardCardId,
    lead: string,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    const buildStage = boardStageWithRole(board, "build");
    const before = boardStageBeforeBuild(board);
    if (card === undefined || buildStage === null || before === null) return;
    if (card.stage !== before.stageId || card.archivedAt !== null) return;
    const resolved = automationIn(board, card);
    if (!resolved.autoBuild.value) return;
    const unmet = unmetBoardCardDependencies({
      board,
      dependsOn: boardCardInheritedDependsOn(board, card),
      cards: board.cards,
    });
    if (unmet.length > 0) {
      yield* autoPlanNote(
        card.id,
        `${lead}; it waits in Ready and builds itself once its dependencies are done.`,
      );
      return;
    }
    const refusal = yield* dispatchRefusal({
      type: "board.card.move",
      commandId: yield* commandId("auto-build"),
      cardId: card.id,
      toStage: buildStage.stageId,
      ...(resolved.autoBuild.source === "own" ? { cause: "auto-build" as const } : {}),
      createdAt: yield* nowIso,
    });
    if (refusal !== null)
      yield* autoPlanNote(card.id, `${lead}; the build did not start: ${refusal}`);
  });

  /**
   * Stamp an unattended planning run: a leaf arriving in, or starting
   * a run in, planning with its Auto-plan on — its own, or its group's. Returns
   * the card the kickoff should use.
   */
  const markAutoPlanIfOn = Effect.fn("board-supervisor-markAutoPlanIfOn")(function* (
    card: BoardCard,
  ) {
    const board = yield* readBoard;
    const planStage = boardStageWithRole(board, "plan");
    if (planStage === null || card.stage !== planStage.stageId) return card;
    if (isBoardCardAutoPlanPending(card) || boardCardGroupOf(board, card) !== null) return card;
    if (boardCardPendingSplit(board, card.id)) return card;
    if (!automationIn(board, card).autoPlan.value) return card;
    const marked = yield* dispatchOptional({
      type: "board.card.mark-auto-plan",
      commandId: yield* commandId("auto-plan-mark"),
      cardId: card.id,
      createdAt: yield* nowIso,
    });
    if (!marked) return card;
    const after = yield* readCard(card.id);
    return after?.autoPlan === undefined ? card : { ...card, autoPlan: after.autoPlan };
  });

  /**
   * Put a live planning thread on an unattended footing: retuned first, so an in-flight question
   * does not park it behind the steer. Null when the steer landed or is held for a usage limit,
   * else the reason, with the previous stance restored.
   */
  const steerPlanningThread = Effect.fn("board-supervisor-steerPlanningThread")(function* (
    cardId: BoardCardId,
    state: BoardCardStepState,
    text: string,
  ) {
    const threadId = state.threadId;
    if (threadId === null) return "the planning step has no thread";
    const wasHumanInLoop = state.humanInLoop;
    if (wasHumanInLoop) {
      yield* dispatch({
        type: "board.card.retune-step",
        commandId: yield* commandId("auto-plan-retune"),
        cardId,
        stepId: state.stepId,
        humanInLoop: false,
        createdAt: yield* nowIso,
      });
    }
    if (state.status === "stalled" && state.stalledReason === "usage-limit") {
      deferredSteers.set(String(threadId), text);
      yield* autoPlanNote(
        cardId,
        "Auto-plan is on. The planning thread is waiting for a usage limit to lift; it gets the instruction then.",
      );
      return null;
    }
    const answered = yield* threads
      .answerPendingInput({
        commandId: yield* commandId("auto-plan-answer"),
        threadId,
        text,
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("board supervisor: answerPendingInput failed", error),
        ),
        Effect.orElseSucceed(() => false),
      );
    let failure: string | null = null;
    if (!answered) {
      const shell = yield* liveThread(threadId);
      if (shell?.activeTurnRef != null) {
        steeredThreads.set(String(threadId), shell.activeTurnRef);
        const interrupted = yield* optional(
          "thread.interrupt",
          threads.interrupt({ commandId: yield* commandId("auto-plan-interrupt"), threadId }),
        );
        if (!interrupted) steeredThreads.delete(String(threadId));
      }
      failure = yield* threads
        .send({
          commandId: yield* commandId("auto-plan-steer"),
          threadId,
          text,
          attachments: [],
          runtimeMode: state.runtimeMode,
          interactionMode: "default",
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error.detail)),
        );
    }
    if (failure !== null) {
      steeredThreads.delete(String(threadId));
      if (wasHumanInLoop) {
        yield* dispatchOptional({
          type: "board.card.retune-step",
          commandId: yield* commandId("auto-plan-restore"),
          cardId,
          stepId: state.stepId,
          humanInLoop: true,
          createdAt: yield* nowIso,
        });
      }
      return failure;
    }
    // Idempotent: the board's own send may already have resumed it.
    yield* resumeParkedStep(threadId);
    return null;
  });

  /**
   * Auto-plan turned on in Planning: steer the current non-terminal planning thread, never replace
   * it; start a fresh run only when there is none. A steer that fails ends the run record.
   */
  const startOrSteerAutoPlan = Effect.fn("board-supervisor-startOrSteerAutoPlan")(function* (
    card: BoardCard,
  ) {
    const refusal = yield* dispatchRefusal({
      type: "board.card.mark-auto-plan",
      commandId: yield* commandId("auto-plan"),
      cardId: card.id,
      createdAt: yield* nowIso,
    });
    if (refusal !== null) return { outcome: "refused", detail: refusal } as const;
    const board = yield* readBoard;
    const autoBuild = automationIn(board, card).autoBuild.value;
    const state = boardCardStepState(board, card.id);
    if (
      state !== null &&
      state.threadId !== null &&
      state.stepId === card.stage &&
      !isBoardTerminalStepStatus(state.status)
    ) {
      yield* autoPlanNote(
        card.id,
        autoBuild
          ? "Auto-plan is on: the agent decides what is left, and its plan is approved and built when it arrives."
          : "Auto-plan is on: the agent decides what is left, and its plan waits for your approval.",
      );
      const steered = yield* steerPlanningThread(
        card.id,
        state,
        boardAutoPlanInstruction(autoBuild),
      );
      if (steered === null) return { outcome: "steered" } as const;
      yield* endAutoPlan(
        card.id,
        `Auto-plan could not reach the planning thread, so nothing will be planned automatically: ${steered}`,
      );
      return { outcome: "refused", detail: steered } as const;
    }
    const started = yield* dispatchRefusal({
      type: "board.card.start-stage-thread",
      commandId: yield* commandId("auto-plan-start"),
      cardId: card.id,
      createdAt: yield* nowIso,
    });
    if (started === null) {
      yield* autoPlanNote(card.id, "Auto-plan is on: an unattended planning run started.");
      return { outcome: "started" } as const;
    }
    // Nothing will run, so the record must not outlive the toggle.
    yield* endAutoPlan(card.id, `Auto-plan could not start a planning run: ${started}`);
    return { outcome: "refused", detail: started } as const;
  });

  /**
   * Auto-plan turned off for a card mid-planning: the step goes back
   * to the stage's own stance, the run record ends, and a running interview is
   * told the user is back. A paused step is not sent anything — a turn would
   * resume it against the human's Stop.
   */
  const stopAutoPlanRun = Effect.fn("board-supervisor-stopAutoPlanRun")(function* (
    card: BoardCard,
  ) {
    const board = yield* readBoard;
    const state = boardCardStepState(board, card.id);
    if (state !== null && state.stepId === card.stage && !isBoardTerminalStepStatus(state.status)) {
      const desired = resolveBoardStageExecution(
        yield* boardSettings,
        card.stage,
        boardProjectStageConfig(board, card.projectId),
      ).humanInLoop;
      if (desired !== state.humanInLoop) {
        yield* dispatchOptional({
          type: "board.card.retune-step",
          commandId: yield* commandId("auto-plan-off-retune"),
          cardId: card.id,
          stepId: state.stepId,
          humanInLoop: desired,
          createdAt: yield* nowIso,
        });
      }
      if (state.status === "running" && state.threadId !== null && desired) {
        yield* sendTurn({
          threadId: state.threadId,
          text: BOARD_AUTO_PLAN_OFF_INSTRUCTION,
          runtimeMode: state.runtimeMode,
        });
      }
    }
    yield* endAutoPlan(
      card.id,
      "Auto-plan is off: planning continues with you, and the plan waits for your approval.",
    );
  });

  /**
   * Bring one card in line with its resolved Automation toggles. Idempotent per branch. Enforces "a
   * pending run record in the plan stage means Auto-plan is on".
   */
  const reevaluateCardAutomation = Effect.fn("board-supervisor-reevaluateCardAutomation")(
    function* (cardId: BoardCardId, changed: BoardAutomationChanged) {
      const board = yield* readBoard;
      const card = board.cards.find((candidate) => candidate.id === cardId);
      if (card === undefined || card.archivedAt !== null) return null;
      if (boardCardGroupOf(board, card) !== null) {
        if (changed.autoMerge === true && (yield* cardAutoMergeArmed(card))) {
          yield* autoMergeArmedCard(card.id);
        }
        return null;
      }
      const resolved = automationIn(board, card);
      const stage = boardStageById(board, card.stage);
      const role = stage === null ? null : effectiveBoardStageRole(stage);
      const pending = isBoardCardAutoPlanPending(card);
      if (role === "plan") {
        const finished = boardCardPlanningFinished(board, card);
        if (resolved.autoPlan.value && !pending && !finished) {
          if (boardCardPendingSplit(board, card.id)) return null;
          const result = yield* startOrSteerAutoPlan(card);
          return result.outcome === "refused" ? null : result.outcome;
        }
        if (!resolved.autoPlan.value && pending) {
          yield* stopAutoPlanRun(card);
          return "stopped" as const;
        }
        if (pending && finished) {
          const state = boardCardStepState(board, card.id);
          const split = boardCardPlans(board, card.id).length >= 2;
          if (
            state !== null &&
            (resolved.autoBuild.value || (split && resolved.autoBuild.waitingForGroupStart))
          ) {
            yield* approveAutoPlannedCard(card, state);
            const after = yield* readCard(card.id);
            const approved = after !== null && (after.stage !== card.stage || after.group !== null);
            return approved ? ("approved" as const) : null;
          }
        }
        return null;
      }
      const before = boardStageBeforeBuild(board);
      if (before !== null && card.stage === before.stageId) {
        if (!resolved.autoBuild.value) return null;
        yield* startAutoBuildCard(card.id, "Auto-build is on");
        const after = yield* readCard(card.id);
        return after !== null && after.stage !== card.stage ? ("built" as const) : null;
      }
      if (
        (changed.autoMerge === true || changed.group === true) &&
        boardStageWithRole(board, "merge")?.stageId === card.stage &&
        (yield* cardAutoMergeArmed(card))
      ) {
        yield* autoMergeArmedCard(card.id);
        return "merged" as const;
      }
      return null;
    },
  );

  /**
   * A group's Automation settings changed, or it began: every child
   * that inherits is re-evaluated, best-effort and one by one, and the group's
   * rail gets one summary line. Children with their own value are untouched.
   */
  const reevaluateGroupChildren = Effect.fn("board-supervisor-reevaluateGroupChildren")(function* (
    groupId: BoardCardId,
    options: { readonly quiet?: boolean } = {},
  ) {
    const board = yield* readBoard;
    const group = board.cards.find((candidate) => candidate.id === groupId);
    if (group === undefined || group.archivedAt !== null) return;
    if (boardCardGroupOf(board, group) === null) return;
    const counts = new Map<string, number>();
    for (const child of boardCardActiveChildren(board, groupId)) {
      const outcome = yield* reevaluateCardAutomation(child.id, { group: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: group automation for a child failed", {
            cardId: child.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (outcome !== null) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    yield* cascadeUnblockedChildren(groupId);
    if (options.quiet === true || counts.size === 0) return;
    const words: Record<string, string> = {
      steered: "told to finish planning unattended",
      started: "started planning unattended",
      stopped: "back to planning with you",
      approved: "had their plan approved",
      built: "started building",
      merged: "merging",
    };
    const parts = [...counts.entries()].map(
      ([outcome, count]) =>
        `${count} ${count === 1 ? "card" : "cards"} ${words[outcome] ?? outcome}`,
    );
    yield* autoPlanNote(groupId, `Automation changed: ${parts.join("; ")}.`);
  });

  /**
   * A human answered the planning agent's question themselves: they
   * are planning with it, so the card's own Auto-plan goes off. The board's
   * own answer — the steer — carries `byBoard` and never reaches here.
   */
  const humanAnsweredPlanning = Effect.fn("board-supervisor-humanAnsweredPlanning")(function* (
    threadId: ThreadId,
  ) {
    const board = yield* readBoard;
    const found = stepThreadCard(board, threadId);
    if (found === null || found.card.archivedAt !== null) return;
    const stage = boardStageById(board, found.card.stage);
    if (stage === null || effectiveBoardStageRole(stage) !== "plan") return;
    if (!automationIn(board, found.card).autoPlan.value) return;
    const off = yield* dispatchOptional({
      type: "board.card.set-automation",
      commandId: yield* commandId("auto-plan-answered"),
      cardId: found.card.id,
      autoPlan: false,
      createdAt: yield* nowIso,
    });
    if (off) {
      yield* autoPlanNote(
        found.card.id,
        "You answered the planning agent, so Auto-plan is off and planning continues with you.",
      );
    }
  });

  /** The auto-plan instruction a usage-limited planning thread was waiting for. */
  const deliverDeferredSteer = Effect.fn("board-supervisor-deliverDeferredSteer")(function* (
    threadId: ThreadId,
  ) {
    const text = deferredSteers.get(String(threadId));
    if (text === undefined) return;
    deferredSteers.delete(String(threadId));
    const found = stepThreadCard(yield* readBoard, threadId);
    if (found === null || isBoardTerminalStepStatus(found.state.status)) return;
    yield* optional(
      "thread.send",
      threads.send({
        commandId: yield* commandId("auto-plan-steer-deferred"),
        threadId,
        text,
        attachments: [],
        runtimeMode: found.state.runtimeMode,
        interactionMode: "default",
      }),
    );
  });

  const handleStepCompleted = Effect.fn("board-supervisor-handleStepCompleted")(function* (
    event: Extract<BoardEvent, { type: "board.card-step-completed" }>,
  ) {
    const completion = event.payload.completion;
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === completion.cardId);
    const state = boardCardStepState(board, completion.cardId);
    if (card === undefined || state === null || state.stepId !== completion.stepId) return;
    if (isBoardTerminalStepStatus(state.status)) {
      // An already-settled step is normally an idempotent retry. A repaired completion changed the
      // ledger row the executor reads, so re-plan; `replanSettledStage` acts only on a `run` plan.
      if (event.payload.repaired === true) {
        // The phase that recorded the broken result is finished with its
        // thread, exactly as an intra-stage continuation is. Best-effort: a
        // thread still mid-turn (the agent repairing its own completion) is
        // refused by the settle guard and simply skipped.
        if (state.threadId !== null) {
          yield* optional(
            "thread.settle",
            threads.settle({
              commandId: yield* commandId("settle-repaired-phase"),
              threadId: state.threadId,
              auto: false,
            }),
          );
        }
        yield* replanSettledStage(card);
        return;
      }
      // A repeated review-phase success is the agent retrying after the continuation failed to
      // dispatch; re-plan, which is a no-op when nothing is left to run.
      if (completion.outcome === "succeeded" && settledReviewPhase(board, card, state)) {
        yield* replanSettledStage(card, { resume: true });
      }
      return;
    }
    // Refresh trigger: a step boundary in the review stage. The review loop
    // needs the PR open to post on, so this is both the moment the link most
    // likely first appears and a natural heartbeat that catches a PR merged or
    // closed out from under a running review.
    const stageRole = effectiveBoardStageRole(
      boardStageById(board, card.stage) ?? { stageId: card.stage, role: null },
    );
    if (stageRole === "review") {
      yield* refreshCardPullRequest(card);
    }

    switch (completion.outcome) {
      case "succeeded":
        yield* settleStep({ card, state, outcome: "succeeded" });
        // A succeeded retarget sync rebased the branch, so move the recorded base before
        // `continueStage` so the next round plans against it. A failed one leaves the base, so the
        // next round syncs again.
        if (parseReviewStepId(state.stepId)?.phase === "sync") {
          const retargetedTo = yield* resolveBaseRetargetTarget(card);
          if (retargetedTo !== null) {
            yield* dispatch({
              type: "board.card.record-base-ref",
              commandId: yield* commandId("record-base-ref"),
              cardId: card.id,
              baseRefName: retargetedTo,
              createdAt: yield* nowIso,
            });
          }
        }
        // A conflict fix's success finishes the merge a human asked for, gated on the pending-merge
        // arm (or an armed card), never just the stage. `get` reads which fix finished before
        // `delete` consumes it, and `delete` comes first so a stale arm can never cause an unasked
        // merge later.
        const finishedFix =
          stageRole === "merge" ? (mergeAwaitingConflictFix.get(String(card.id)) ?? null) : null;
        if (
          stageRole === "merge" &&
          (mergeAwaitingConflictFix.delete(String(card.id)) || (yield* cardAutoMergeArmed(card)))
        ) {
          // Release the fix's thread first: left live, `hasLiveStageThread` would make the next
          // Merge click on a re-conflict open nothing while the card claims to be resolving.
          if (state.threadId !== null) {
            // Retired: the fix stays on the card as a past thread.
            yield* dispatch({
              type: "board.card.retire-thread",
              commandId: yield* commandId("retire-conflict-fix"),
              cardId: card.id,
              threadId: state.threadId,
              createdAt: yield* nowIso,
            });
          }
          yield* schedule();
          // Only a conflict fix passes the `viaConflictFix` bound (a CI fix's re-attempt may still
          // need a conflict fix; its own bound is `checksFixSpent`). An unarmed card's CI fix hands
          // its merge to the ladder to wait out the re-run checks.
          if (finishedFix === "checks") mergeAwaitingChecks.add(String(card.id));
          const outcome = yield* mergeCardPullRequest(card.id, finishedFix !== "checks");
          // Record on the ladder only for armed cards. A re-conflict comes back `refused` (via
          // `viaConflictFix`), a hard stop: the fix already had its one attempt.
          const armed =
            mergeAwaitingChecks.has(String(card.id)) || (yield* cardAutoMergeArmed(card));
          if (armed) {
            yield* recordAutoMergeOutcome(card.id, outcome, { resetLadder: false });
          }
          // Nothing to report yet when another fix took over, when a CI fix's re-attempt went to
          // the ladder (pending checks by design), or when a readied draft waits on its CI.
          if (
            outcome.outcome !== "merged" &&
            outcome.outcome !== "conflict" &&
            outcome.outcome !== "checks-fix" &&
            !mergeAwaitingChecks.has(String(card.id))
          ) {
            yield* dispatch({
              type: "board.card.record-note",
              commandId: yield* commandId("merge-refused"),
              cardId: card.id,
              kind: "card-merge-refused",
              // `conflict` is unreachable here: this call passes
              // `viaConflictFix`, which is exactly what suppresses starting
              // another conflict step, so a second conflict comes back as
              // `refused` carrying the forge's text.
              detail:
                outcome.outcome === "refused"
                  ? `Conflicts resolved, but the merge was refused: ${outcome.detail}`
                  : "Conflicts resolved, but the pull request could no longer be merged.",
              createdAt: yield* nowIso,
            });
          }
          return;
        }
        // An auto-planned card's plan is approved by the board: the
        // click or the group's setting authorised it, so the plan never waits
        // on the gate — and the stage's own auto-advance must not move it too.
        if (stageRole === "plan") {
          const planned = yield* readCard(card.id);
          if (planned !== null && isBoardCardAutoPlanPending(planned)) {
            yield* approveAutoPlannedCard(planned, state);
            yield* releaseFinishedThreads;
            yield* schedule();
            return;
          }
        }
        // Ask the stage executor what runs next: complete (auto-advance) or the loop's next step.
        yield* continueStage({ card, state });
        // Ask for the threads left behind. Usually refused: the agent completes from inside its
        // turn, so its session is still running; the sweep on its `turn.completed` lands it.
        yield* releaseFinishedThreads;
        yield* schedule();
        return;
      case "failed":
        // A clean failure report still enters recovery: retry or escalate.
        yield* recoverStep({ card, state });
        return;
      case "blocked":
        // The agent needs a human: park the step on the gate. An agent
        // that reported `blocked` asked for a human by name.
        yield* parkStepForInput({ card, state, reason: "question" });
        return;
    }
  });

  /**
   * A step's thread asked a human a question: `awaiting-input` stops the card counting as stalled.
   * Driven by the runtime `user-input.requested` event, so it fires for every input request.
   */
  const handleInputRequested = Effect.fn("board-supervisor-handleInputRequested")(function* (
    threadId: ThreadId,
  ) {
    if (yield* stillOnSteeredRun(threadId)) return;
    if (boardInterruptedRuns.has(String(threadId))) return;
    const board = yield* readBoard;
    const watched = stepThreadCard(board, threadId);
    if (watched === null || watched.state.status !== "running") return;
    if (isReviewDecidingStep(watched.state)) {
      yield* handleReviewStepQuestion(watched.card, watched.state);
      return;
    }
    yield* parkStepForInput({ card: watched.card, state: watched.state, reason: "question" });
  });

  /**
   * Nobody answers a triage or adjudication question: the board replies "decide it yourself" once
   * per attempt. If that cannot land or the agent asks again, interrupt and recover the step, which
   * charges the stall ladder, so a persistent asker ends `stalled`, never parked.
   */
  const handleReviewStepQuestion = Effect.fn("board-supervisor-handleReviewStepQuestion")(
    function* (card: BoardCard, state: BoardCardStepState) {
      const threadId = state.threadId;
      const answer = boardReviewQuestionAnswer(state.stepId);
      if (threadId === null || answer === null) return;
      if (!answeredReviewQuestion(state)) {
        answeredReviewQuestions.set(state.cardId, `${state.stepId} ${state.attempt}`);
        const answered = yield* threads
          .answerPendingInput({
            commandId: yield* commandId("review-answer"),
            threadId,
            text: answer,
          })
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning("board supervisor: answerPendingInput failed", error),
            ),
            Effect.orElseSucceed(() => false),
          );
        if (answered) return;
      }
      const shell = yield* liveThread(threadId);
      if (shell?.activeTurnRef != null) {
        boardInterruptedRuns.add(String(threadId));
        const interrupted = yield* optional(
          "thread.interrupt",
          threads.interrupt({ commandId: yield* commandId("review-interrupt"), threadId }),
        );
        if (!interrupted) boardInterruptedRuns.delete(String(threadId));
      }
      yield* recoverStep({ card, state });
    },
  );

  /**
   * Clear a card's scheduled start through `board.card.update`; the resulting `board.card-updated`
   * is what acts on it, so clear-before-act is structural. A crash between leaves a cleared,
   * unstarted card the next pass starts, not a stale time that re-gates the next stage.
   */
  const clearCardSchedule = Effect.fn("board-supervisor-clearCardSchedule")(function* (
    card: BoardCard,
  ) {
    if (card.scheduledStartAt === null) return true;
    // OBSERVED, not fire-and-forget: a refused clear must not be followed by
    // the act. The only way this is refused is the card being archived or gone,
    // and neither should start — while acting anyway would leave the stale time
    // that this ordering exists to prevent.
    return yield* dispatchOptional({
      type: "board.card.update",
      commandId: yield* commandId("clear-schedule"),
      cardId: card.id,
      scheduledStartAt: null,
      createdAt: yield* nowIso,
    });
  });

  /** `clearCardSchedule` from a card id, for the event paths that carry one
      (a step recovery). A no-op on an unscheduled card, so it costs a board
      read and nothing else on the overwhelming majority of recoveries. */
  const clearScheduleForCard = Effect.fn("board-supervisor-clearScheduleForCard")(function* (
    cardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined) return;
    yield* clearCardSchedule(card);
  });

  /**
   * Make the move the supervisor would otherwise make now. A parked step is requeued keeping its
   * thread, so admission nudges the existing conversation; anything else is a step the gate
   * withheld, and one pass admits it.
   */
  const startOrResumeCard = Effect.fn("board-supervisor-startOrResumeCard")(function* (
    cardId: BoardCardId,
    /** The board's OWN timed resumes keep the retry budget, so a
        genuinely dead card still climbs its ladder to a human across any number
        of backoff rungs and quota waits. A human's Resume, and a
        scheduled start, reset it — a person intervening IS progress. */
    options?: { readonly preserveBudget?: boolean },
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || card.archivedAt !== null) return;
    const state = boardCardStepState(board, cardId);
    if (state !== null && isBoardParkedStepStatus(state.status)) {
      yield* dispatchOptional({
        type: "board.card.requeue-step",
        commandId: yield* commandId("schedule-requeue"),
        cardId,
        ...(options?.preserveBudget === true ? { preserveBudget: true } : {}),
        createdAt: yield* nowIso,
      });
    }
    // Unconditional: the requeue was dispatched from inside this reactor, and relying on its own
    // event to schedule it is one hop from sitting `queued` forever. A second pass is a no-op.
    yield* schedule();
  });

  /**
   * Fire one card's scheduled start: clear the field, then act. A crash between leaves a cleared,
   * unstarted card the next pass starts; acting first would leave a stale time re-gating the next
   * stage.
   */
  const fireCardSchedule = Effect.fn("board-supervisor-fireCardSchedule")(function* (
    card: BoardCard,
  ) {
    if (!(yield* clearCardSchedule(card))) return;
    yield* startOrResumeCard(card.id);
  });

  /**
   * React to an edit that TOUCHED the card's scheduled start.
   *
   * One rule, in both directions: if the time has arrived (or was cleared),
   * make the move the supervisor would otherwise make now; if it has not, hold
   * the card still, stopping a step that is running right now.
   */
  const applyScheduleEdit = Effect.fn("board-supervisor-applyScheduleEdit")(function* (
    cardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || card.archivedAt !== null) return;
    if (!isBoardCardScheduleDue(card.scheduledStartAt, Date.parse(yield* nowIso))) {
      // Only a running step is stopped now and picked up at the scheduled time. Other parked
      // statuses hold no slot and keep their reason; pending or queued steps are withheld by
      // `schedule()`.
      const state = boardCardStepState(board, cardId);
      if (state !== null && state.status === "running") {
        yield* pauseStepNow({ card, state });
      }
      return;
    }
    // A time set in the PAST means "now", so it fires here rather than
    // waiting up to 30s for the tick — and the card never wears a pill for a
    // moment that has already gone.
    if (card.scheduledStartAt !== null) return yield* fireCardSchedule(card);
    yield* startOrResumeCard(cardId);
  });

  /**
   * Fire every card whose scheduled start has arrived.
   *
   * Rides the existing 30s sweep tick rather than a timer of its own: ±30s
   * granularity on a control whose finest input is one minute, and no new
   * fiber, no polling loop.
   */
  const fireDueSchedules = Effect.fn("board-supervisor-fireDueSchedules")(function* () {
    const board = yield* readBoard;
    const nowMs = Date.parse(yield* nowIso);
    for (const card of board.cards) {
      if (card.scheduledStartAt === null || card.archivedAt !== null) continue;
      if (!isBoardCardScheduleDue(card.scheduledStartAt, nowMs)) continue;
      yield* fireCardSchedule(card);
    }
  });

  /** The scheduled-start pass as the tick and the test hook consume it: TOTAL,
      like the timeout sweep beside it. A read-model hiccup must cost one 30s
      window, never take the sweep fiber down. */
  const sweepSchedules = fireDueSchedules().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: scheduled-start sweep failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  /**
   * Archive cards untouched in Done for the configured days, as an ordinary system-actor archive so
   * settle, reclaim and cascades run. A refusal that still lands (a raced edit) is expected.
   */
  const fireDueAutoArchives = Effect.fn("board-supervisor-fireDueAutoArchives")(function* () {
    const { lifecycle } = yield* boardSettings;
    if (!lifecycle.autoArchiveDone) return;
    const board = yield* readBoard;
    const nowMs = Date.parse(yield* nowIso);
    for (const card of board.cards) {
      if (!boardCardAutoArchiveDue({ board, card, lifecycle, nowMs })) continue;
      yield* dispatchOptional({
        type: "board.card.archive",
        commandId: yield* commandId("auto-archive"),
        cardId: card.id,
        createdAt: yield* nowIso,
      });
    }
  });

  /** Total, like `sweepSchedules`: a failed pass costs one tick. */
  const sweepAutoArchives = fireDueAutoArchives().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: auto-archive sweep failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  /**
   * Start armed cards whose last dependency landed, via an ordinary forward move into the
   * build-role stage. The decider's dependency gate stays the authority; re-entrant because the
   * move clears the arm. Reads the board itself: callers' copies are stale.
   */
  const startArmedCards = Effect.fn("board-supervisor-startArmedCards")(function* (
    /** Which cards to consider. The targeted paths narrow to the one card that
        could have changed; the sweep and boot reconciliation pass everything. */
    select: (card: BoardCard, board: BoardState) => boolean,
  ) {
    const board = yield* readBoard;
    const buildStage = boardStageWithRole(board, "build");
    if (buildStage === null) return;
    for (const card of board.cards) {
      if (!select(card, board)) continue;
      if (!boardCardAutoBuildDue({ board, card })) continue;
      // A non-dependency refusal: the card stays armed and fires once the gate clears; clearing the
      // arm here would spend it on a move that never happened.
      if (boardCardPendingSplit(board, card.id)) continue;
      yield* dispatch({
        type: "board.card.move",
        commandId: yield* commandId("auto-start"),
        cardId: card.id,
        toStage: buildStage.stageId,
        // An own Auto-build start begins no group, so it never starts
        // the card's siblings.
        cause: "auto-build",
        createdAt: yield* nowIso,
      });
    }
  });

  /** The targeted narrowing: only a card that DEPENDS on the one
      that just finished or was archived can have become due, so a done arrival
      on an ordinary board costs one board read and a filter rather than a
      whole-board dependency resolution. */
  const startArmedDependents = (dependencyId: BoardCardId) =>
    startArmedCards((card, board) =>
      boardCardInheritedDependsOn(board, card).includes(dependencyId),
    );

  /**
   * Requeue every step whose backoff rung arrived, on the 30s sweep tick. `preserveBudget` keeps a
   * dead card climbing toward a human. Usage-limit parks are swept too, as a safety net under the
   * engine's own `limit-resumed`.
   */
  const fireDueRetries = Effect.fn("board-supervisor-fireDueRetries")(function* () {
    const board = yield* readBoard;
    const nowMs = yield* clockNowMs;
    for (const state of board.stepStates ?? []) {
      if (state.status !== "stalled") continue;
      if (state.stalledReason !== "waiting-retry" && state.stalledReason !== "usage-limit") {
        continue;
      }
      if (state.retryAt === null) continue;
      const dueMs = Date.parse(state.retryAt);
      if (!Number.isFinite(dueMs) || nowMs < dueMs) continue;
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined || card.archivedAt !== null) continue;
      yield* startOrResumeCard(state.cardId, { preserveBudget: true });
    }
  });

  const sweepRetries = fireDueRetries().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: retry sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  /**
   * Attempt every armed card whose retry rung has arrived, on the 30s sweep tick. Total, so a
   * hold that survived a restart is picked up at boot. A hard hold (null `retryAt`) never comes
   * due. Also re-checks a card deferred as blocked, and clears the hold of a card no longer
   * armed: the board-wide setting disarms cards without touching them, so nothing else would.
   */
  const fireDueAutoMerges = Effect.fn("board-supervisor-fireDueAutoMerges")(function* () {
    const board = yield* readBoard;
    const mergeStage = boardStageWithRole(board, "merge");
    if (mergeStage === null) return;
    // Read once for the whole pass rather than per card: the arm is the same
    // question for every card here, and the sweep runs every 30s.
    const settings = yield* boardSettings;
    const nowMs = yield* clockNowMs;
    for (const card of board.cards) {
      const exec = resolveBoardStageExecution(
        settings,
        mergeStage.stageId,
        boardProjectStageConfig(board, card.projectId),
      );
      const boardWide = isBoardMergeStageExecution(exec) ? exec.autoMerge : false;
      const deferred = autoMergeDeferredUntilUnblocked.has(String(card.id));
      const hold = card.autoMergeHold;
      if (hold === null && !deferred) continue;
      if (card.archivedAt !== null || card.stage !== mergeStage.stageId) {
        autoMergeDeferredUntilUnblocked.delete(String(card.id));
        mergeAwaitingChecks.delete(String(card.id));
        continue;
      }
      // A hold on a card no longer armed claims a retry that will not happen. The board-wide
      // setting is not a card command, so its clear lands here; checked before the rung is due so
      // the stale pill does not linger. An unarmed card waiting on its CI fix's checks still rides.
      if (
        !boardCardAutoMergeArmed({ board, card, boardWide }) &&
        !mergeAwaitingChecks.has(String(card.id))
      ) {
        autoMergeDeferredUntilUnblocked.delete(String(card.id));
        yield* clearAutoMergeHold(card);
        continue;
      }
      // A HARD hold is never polled: its `retryAt` is null, so it simply
      // never comes due. A deferred card with no hold has no rung to wait for
      // — its wait is the dependency, and `autoMergeCard` re-checks that.
      const dueMs = hold?.retryAt == null ? null : Date.parse(hold.retryAt);
      const rungDue = dueMs !== null && Number.isFinite(dueMs) && nowMs >= dueMs;
      if (!rungDue && !(deferred && hold === null)) continue;
      // A live conflict fix owns the merge; a second attempt would race the branch it rewrites. The
      // pull request is not pre-checked: `mergeCardPullRequest` re-resolves it, so a missing link
      // records a hard hold rather than retrying silently.
      const liveStep = boardCardStepState(board, card.id);
      if (liveStep !== null && !isBoardTerminalStepStatus(liveStep.status)) continue;
      if (hasLiveStageThread(card, card.stage)) continue;
      yield* autoMergeCard(card);
    }
  });

  const sweepAutoMergeHolds = fireDueAutoMerges().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: auto-merge sweep failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  /** The auto-start pass as the tick and the test hook consume it: TOTAL, for
      the same reason `sweepSchedules` is. Missing a targeted trigger costs one
      30s window; a dependency that lands while the server is down is caught by
      boot reconciliation running the same pass. */
  const sweepArmedCards = startArmedCards(() => true).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: auto-start sweep failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  /**
   * The stance a live step should hold over the one it froze at entry, or null. An unattended
   * planning run, or a build with Auto-build on, stays unattended whatever the card's toggle
   * says; otherwise the card's explicit override applies.
   */
  const stanceOverride = (
    board: BoardState,
    card: BoardCard,
    state: BoardCardStepState,
  ): boolean | null => {
    if (state.stepId !== card.stage) return card.humanInLoop;
    const stage = boardStageById(board, card.stage);
    const role = stage === null ? null : effectiveBoardStageRole(stage);
    if (role === "plan" && isBoardCardAutoPlanPending(card)) return false;
    if (role === "build" && automationIn(board, card).autoBuild.value) return false;
    return card.humanInLoop;
  };

  // Mid-run human-in-the-loop toggle: retune the run row, and send a stance turn when the step
  // has a live thread (a queued or pending step only needs the frozen stance updated). Only an
  // explicit toggle differing from the frozen stance reacts, so unrelated edits never flip a run.
  const handleCardUpdated = Effect.fn("board-supervisor-handleCardUpdated")(function* (
    event: Extract<BoardEvent, { type: "board.card-updated" }>,
  ) {
    yield* applyRegroup(event.payload.card, {
      becameGroup: event.payload.becameGroup === true,
      regrouped: event.payload.regrouped === true,
    });
    // A schedule edit acts first: it must reach a card with no live step row, and a step the arms
    // below would return past. Keyed on the payload naming the field, so an unrelated edit never
    // resumes a card parked for another reason.
    if (event.payload.scheduledStartAt !== undefined) {
      yield* applyScheduleEdit(event.payload.cardId);
    }
    // Keyed on the card's state, not the payload marker: a card also becomes due when an edit drops
    // its last blocking edge or a dependency is deleted, or when its last dependency finished
    // between the modal rendering and the arm. Unarmed cards, the majority, pay nothing.
    if (event.payload.card.autoBuildSetting === true) {
      yield* startArmedCards((candidate) => candidate.id === event.payload.cardId);
    }
    // A toggle change owns the step's stance and its one message, so the generic stance arm below
    // stands aside. Arming a card already parked at merge merges it now: only an edit that touched
    // the arm may, and it bypasses the adjacency guard. A group change reaches inheriting children.
    const automationChanged = event.payload.automationChanged;
    if (automationChanged !== undefined) {
      if (automationChanged.group === true) {
        yield* reevaluateGroupChildren(event.payload.cardId);
      }
      if (
        automationChanged.autoPlan === true ||
        automationChanged.autoBuild === true ||
        automationChanged.autoMerge === true
      ) {
        yield* reevaluateCardAutomation(event.payload.cardId, automationChanged);
      }
      return;
    }
    // A strategy change cleared the hold that WAS the retry, so the
    // card re-attempts now, under the new strategy, rather than sitting with
    // no hold for the sweep to find. Only an armed card, or one whose CI fix
    // is still riding the ladder, merges by itself.
    if (
      event.payload.autoMergeHoldReleased === true &&
      ((yield* cardAutoMergeArmed(event.payload.card)) ||
        mergeAwaitingChecks.has(String(event.payload.cardId)))
    ) {
      yield* autoMergeArmedCard(event.payload.cardId);
    }
    if (event.payload.mergeStrategyEdited === true) {
      yield* releaseInheritingChildHolds(event.payload.cardId);
    }
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
    const state = boardCardStepState(board, event.payload.cardId);
    if (card === undefined || state === null) return;
    // A step stalled for a provider missing on its worker froze its model at entry, so a model
    // change only lands if the stage restarts. Only a model-overrides edit restarts it; a restart
    // the decider refuses leaves the stall for a human.
    if (
      event.payload.modelOverridesEdited === true &&
      state.status === "stalled" &&
      state.stalledReason === "provider-not-on-worker"
    ) {
      yield* dispatchOptional({
        type: "board.card.start-stage-thread",
        commandId: yield* commandId("restart-for-model"),
        cardId: card.id,
        createdAt: yield* nowIso,
      });
      return;
    }
    // A settled stage may have more to run after an edit (raising a held review loop's budget).
    // Role-agnostic: asks the stage's executor and acts only on a `run` plan; `complete` stays a
    // no-op to avoid a double advance. Only a succeeded settle re-plans: an abandoned step at an
    // auto stage would otherwise plan a fresh run on a title edit.
    if (isBoardTerminalStepStatus(state.status)) {
      if (state.status !== "succeeded") return;
      return yield* replanSettledStage(card);
    }
    // The card's explicit override wins at every stage, or a toggle on a review or planning step
    // changes the card while the step stays supervised the old way.
    const desired = stanceOverride(board, card, state) ?? state.humanInLoop;
    if (desired === state.humanInLoop) return;
    // A paused step is not told: the turn would resume it through `resumeParkedStep` and overturn
    // the human's Stop. The stance still lands on the row below. Awaiting-input and stalled steps
    // are told, and resuming them is intended.
    if (state.threadId !== null && state.status !== "paused") {
      const text = desired
        ? `Switching to human-in-the-loop: ask me anything you need directly, and it is fine to end a turn waiting on my answer. Call board_complete_step when the work is done.`
        : isReviewDecidingStep(state)
          ? `Switching to unattended: do not stop to ask permission: make every reasonable decision yourself and proceed. Call board_complete_step when the step is finished. ${boardBlockedInstruction(state.stepId)}`
          : `Switching to unattended: do not stop to ask permission: make every reasonable decision yourself and proceed. Call board_complete_step when the step is finished; if you are truly blocked, ${BOARD_ENVELOPE_QUESTION_MECHANISM}, and never end a turn with an unanswered question in prose.`;
      yield* sendTurn({ threadId: state.threadId, text, runtimeMode: state.runtimeMode });
    }
    yield* dispatch({
      type: "board.card.retune-step",
      commandId: yield* commandId("retune-step"),
      cardId: card.id,
      stepId: state.stepId,
      humanInLoop: desired,
      createdAt: yield* nowIso,
    });
  });

  /** Interrupt every live turn on a card's threads. The release
      sweep settles them once their turns have ended. */
  const stopCardThreads = Effect.fn("board-supervisor-stopCardThreads")(function* (
    card: BoardCard,
  ) {
    for (const link of card.threadLinks) {
      if (link.tombstonedAt !== null) continue;
      const shell = yield* liveThread(link.threadId).pipe(
        Effect.catchCause(() => Effect.undefined),
      );
      if (shell?.activeTurnRef == null) continue;
      yield* logged(
        "thread.interrupt",
        threads.interrupt({
          commandId: yield* commandId("interrupt-discarded"),
          threadId: link.threadId,
        }),
      );
    }
  });

  /** Close a card's open pull request on the forge. Best-effort: a
      refusal is logged, and the branch deletion that follows a discard closes
      it on most hosts anyway. */
  const closeCardPullRequest = Effect.fn("board-supervisor-closeCardPullRequest")(function* (
    card: BoardCard,
    pullRequest: BoardCard["pullRequest"],
  ) {
    if (pullRequest === null || pullRequest.state !== "open") return;
    const workspace = yield* workspaceFor(card);
    yield* workspace.closePullRequest({ number: pullRequest.number }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor: closing a discarded pull request failed", {
          cardId: card.id,
          number: pullRequest.number,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  /** Report a branch deletion onto the card's rail, as Done's cleanup does. */
  const recordBranchDeletion = Effect.fn("board-supervisor-recordBranchDeletion")(function* (
    card: BoardCard,
    branch: string,
    result: {
      readonly remoteDeleted: boolean;
      readonly localDeleted: boolean;
      readonly skippedReason: string | null;
    },
  ) {
    const deleted = [
      ...(result.remoteDeleted ? ["remote"] : []),
      ...(result.localDeleted ? ["local"] : []),
    ];
    const skipped = result.skippedReason === null ? "" : `: ${result.skippedReason}`;
    yield* dispatchOptional({
      type: "board.card.record-note",
      commandId: yield* commandId("branch-cleanup"),
      cardId: card.id,
      kind: "card-branch-deleted",
      detail:
        deleted.length === 0
          ? `Kept branch ${branch}${skipped}`
          : `Deleted ${deleted.join(" and ")} branch ${branch}${skipped}`,
      createdAt: yield* nowIso,
    });
  });

  /**
   * A confirmed group archive's git half (decision 14): the card's
   * worktree goes, forced, then its branch — local and remote — including a
   * group's `branch-only` integration branch. No further work, ever.
   */
  const discardCardBranchWork = Effect.fn("board-supervisor-discardCardBranchWork")(function* (
    cardId: BoardCardId,
  ) {
    const card = yield* readCard(cardId);
    if (card === null || card.archivedAt === null) return;
    const worktree = card.worktree;
    // A reclaimed slice still names its branch: the archive's own reclaim
    // may have removed the checkout first, and the branch outlives it.
    if (worktree === null) return;
    if (worktree.status === "ready" && worktree.path !== null) {
      yield* forceRemoveCardWorktree(card.id);
    }
    const workspace = yield* workspaceFor(card);
    if (workspace.checkoutPath === null) return;
    const result = yield* workspace.deleteCardBranch({ branch: worktree.branch }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor: branch cleanup on group archive failed", {
          cardId: card.id,
          branch: worktree.branch,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
    if (result === null) return;
    yield* recordBranchDeletion(card, worktree.branch, result);
    // Settled only once both copies are gone: until then the pending discard
    // stays on the card for the sweep to retry, so a failed remote delete is
    // never forgotten.
    if (!result.localDeleted || !(result.remoteDeleted || result.remoteAbsent)) {
      // The rail refuses notes on archived cards, so the log is the record.
      yield* Effect.logWarning("board supervisor: group archive's branch discard still pending", {
        cardId: card.id,
        branch: worktree.branch,
        reason: result.skippedReason,
      });
      return;
    }
    const after = yield* readCard(card.id);
    if (after?.worktree == null) return;
    if (after.worktree.status === "reclaimed" && after.worktree.discardPending !== true) return;
    yield* dispatchOptional({
      type: "board.card.reclaim-worktree",
      commandId: yield* commandId("discard-reclaim-worktree"),
      cardId: card.id,
      outcome: "removed",
      forced: true,
      discardSettled: true,
      createdAt: yield* nowIso,
    });
  });

  /**
   * An archived group's `branch-only` integration branch: it has no
   * checkout for the reclaim to remove, so without this it outlives its card.
   * A plain archive is reversible, so the branch goes only once its merge made
   * the work durable; a confirmed group archive deletes it regardless.
   */
  const reclaimArchivedIntegrationBranch = Effect.fn(
    "board-supervisor-reclaimArchivedIntegrationBranch",
  )(function* (card: BoardCard) {
    if (card.archivedAt === null || card.worktree?.status !== "branch-only") return;
    if (boardCardDisplayPullRequest(card)?.state !== "merged") return;
    yield* discardCardBranchWork(card.id);
  });

  /**
   * A cancelled card's worktree (decision 12): reclaimed by the usual
   * safety rule, so work that exists nowhere else is kept and said so. The
   * branch is kept until that reclaim removes the checkout, and goes with it.
   */
  const reclaimCancelledCardWorktree = Effect.fn("board-supervisor-reclaimCancelledCardWorktree")(
    function* (cardId: BoardCardId) {
      const card = yield* readCard(cardId);
      if (card === null) return null;
      const attempt = yield* reclaimCardWorktree(card);
      if (attempt?.outcome === "removed") yield* deleteCancelledCardBranch(cardId);
      return attempt;
    },
  );

  const deleteCancelledCardBranch = Effect.fn("board-supervisor-deleteCancelledCardBranch")(
    function* (cardId: BoardCardId) {
      const after = yield* readCard(cardId);
      const branch = after?.worktree?.branch ?? null;
      if (after === null || branch === null) return;
      const workspace = yield* workspaceFor(after);
      if (workspace.checkoutPath === null) return;
      const result = yield* workspace.deleteCardBranch({ branch }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: cancelled card's branch cleanup failed", {
            cardId,
            branch,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (result !== null) yield* recordBranchDeletion(after, branch, result);
    },
  );

  /**
   * A started leaf's work was cancelled to make it a parent: its
   * step is abandoned, its threads stop, its pull request closes, and
   * its worktree is reclaimed — the card is already a group.
   */
  const handleWorkCancelled = Effect.fn("board-supervisor-handleWorkCancelled")(function* (
    cancelled: BoardCard,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cancelled.id) ?? cancelled;
    const state = boardCardStepState(board, card.id);
    if (state !== null && !isBoardTerminalStepStatus(state.status)) {
      yield* settleStep({ card, state, outcome: "abandoned" });
      yield* schedule();
    }
    yield* stopCardThreads(card);
    yield* closeCardPullRequest(card, card.pullRequestHistory.at(-1) ?? null);
    yield* cardCleanupWorker.enqueue({ kind: "cancelled", cardId: card.id });
    yield* releaseFinishedThreads;
  });

  const handleArchived = Effect.fn("board-supervisor-handleArchived")(function* (
    event: Extract<BoardEvent, { type: "board.card-archived" }>,
  ) {
    const board = yield* readBoard;
    // Reap the settle marker whether or not the card is still readable: an
    // archived card is done being settled, and an entry that outlives its card
    // is a leak the process never gets back.
    settledAtDone.delete(String(event.payload.cardId));
    transientProvisionFailures.delete(event.payload.cardId);
    const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
    if (card === undefined) return;
    const state = boardCardStepState(board, event.payload.cardId);
    if (state !== null && !isBoardTerminalStepStatus(state.status)) {
      yield* settleStep({ card, state, outcome: "abandoned" });
      // The abandoned step released its slot — offer it to whatever is queued.
      yield* schedule();
    }
    // Before the reclaim below pulls the worktree out from under its steps.
    yield* stopCiOnArchive(card);
    // Archive is the guaranteed cleanup point, so the reclaim reads no setting:
    // `reclaimWorktreeOnDone` only chooses whether it happens earlier. A worktree may not outlive
    // its card.
    if (event.payload.discard === true) {
      // A confirmed group archive: nothing here is coming back.
      yield* stopCardThreads(card);
      yield* closeCardPullRequest(card, card.pullRequest);
      yield* cardCleanupWorker.enqueue({ kind: "discard", cardId: card.id });
      // Children archived before this one were left out of the subtree's
      // events, but their branches are just as dead now.
      for (const earlier of earlierArchivedSubtrees(board.cards, card)) {
        yield* closeCardPullRequest(earlier, earlier.pullRequest);
        yield* cardCleanupWorker.enqueue({ kind: "discard", cardId: earlier.id });
      }
    } else {
      // Off this worker: the reclaim fetches from the remote first.
      yield* cardCleanupWorker.enqueue({ kind: "reclaim", cardId: card.id });
    }
    // An archived card is done with every thread it holds.
    yield* releaseFinishedThreads;
    // An archived child counts as finished, so this may have
    // been the parent's last unfinished one — or the one whose finishing
    // unblocks a sibling still waiting on the floor.
    if (card.parentCardId !== null) {
      yield* cascadeUnblockedChildren(card.parentCardId);
      yield* syncAncestorGroups(card.parentCardId);
    }
    // An ARCHIVED dependency stops gating, so archiving a blocker
    // frees its dependents exactly as finishing it would — in
    // any group.
    yield* startArmedDependents(card.id);
    yield* cascadeDependentGroups(card.id);
  });

  /**
   * A card was deleted. The card comes from the payload (its rows are gone); the board read is only
   * for the project's cwd. Order: threads stop first, then the worktree is removed FORCED (the
   * human confirmed), then branches, since `deleteCardBranch` refuses one a worktree holds.
   * Each step is best-effort and logs only: there is no card left to report on or retry.
   */
  const handleCardDeleted = Effect.fn("board-supervisor-handleCardDeleted")(function* (
    event: Extract<BoardEvent, { type: "board.card-deleted" }>,
  ) {
    const card = event.payload.card;
    // Per-card in-memory bookkeeping outlives the card unless it is reaped
    // here — each entry is a leak the process never gets back.
    settledAtDone.delete(String(card.id));
    autoMergeDeferredUntilUnblocked.delete(String(card.id));
    transientProvisionFailures.delete(card.id);
    disarmPendingMerge(card.id);
    // Not `board.card.settle-step`: that needs the card to exist. The slot count is in-memory, so
    // without this release the board would run one step short of its ceiling until restart.
    const stepState = event.payload.stepState;
    if (stepState !== null) yield* releaseSlot(stepState);
    // Its CI pass, running or queued, dies with it; the pass rows
    // left with the card's other rows.
    if ((yield* ciPasses.cancel(card.id)) !== null) yield* schedule();

    for (const threadId of event.payload.threadIds) {
      yield* logged(
        "thread.delete",
        threads.delete({ commandId: yield* commandId("delete-card-thread"), threadId }),
      );
    }

    // The brief's files go with the card (K1): board-owned storage,
    // so nothing else will ever reclaim it.
    yield* Option.match(serverConfig, {
      onNone: () => Effect.void,
      onSome: (config) =>
        withFileServices(
          removeBoardCardAttachmentsDir({ stateDir: config.stateDir, cardId: card.id }),
        ),
    });

    const worktree = card.worktree;
    if (worktree !== null) {
      const workspace = yield* workspaceFor(card);
      if (workspace.checkoutPath !== null) {
        // Retiring runs the remove scripts, which can take minutes, so
        // it goes to its own worker and the delete handler moves on. The queue
        // is in memory: a restart before it runs leaves the branch behind, so
        // the log names it for whoever finds it.
        yield* Effect.logInfo("board: deleted card's worktree and branch queued for cleanup", {
          cardId: card.id,
          branch: worktree.branch,
          worktreePath: worktree.path,
        });
        yield* cardRetireWorker.enqueue({
          cardId: card.id,
          workspace,
          worktreePath: worktree.status === "ready" ? worktree.path : null,
          branch: worktree.branch,
        });
      }
    }

    // The released slot is capacity the board can hand to whatever is queued.
    yield* schedule();

    // Deleting a child removes it from the parent's unfinished set, which may release a sibling
    // that depended on it, and if it was the last one standing, advances the parent (the helper
    // itself refuses when NO children remain: an emptied split waits for the human).
    if (card.parentCardId !== null) {
      yield* cascadeUnblockedChildren(card.parentCardId);
      yield* syncAncestorGroups(card.parentCardId);
    }
  });

  // Create and push the split's integration branch (branch only), then record it. A failed push
  // is a note: local-only projects still work. Idempotent: approval and any child finding no
  // parent branch call it; a live slice is left alone, `failed`/`reclaimed` proceed. Returns why
  // the branch could not be cut, or null; nested groups are ensured outermost first.
  const ensureIntegrationBranch = Effect.fn("board-supervisor-ensureIntegrationBranch")(function* (
    card: BoardCard,
  ) {
    const board = yield* readBoard;
    const chain: Array<BoardCard> = [];
    let outer = boardCardIntegrationAncestor(board, card);
    while (outer !== null && !chain.some((seen) => seen.id === outer!.id)) {
      chain.unshift(outer);
      outer = boardCardIntegrationAncestor(board, outer);
    }
    for (const ancestor of chain) {
      if (boardCardHasLiveBranch(ancestor)) continue;
      const failure = yield* ensureOneIntegrationBranch(ancestor);
      if (failure !== null) return failure;
    }
    return yield* ensureOneIntegrationBranch(card);
  });

  const ensureOneIntegrationBranch = Effect.fn("board-supervisor-ensureOneIntegrationBranch")(
    function* (card: BoardCard) {
      if (
        card.worktree !== null &&
        card.worktree.status !== "failed" &&
        card.worktree.status !== "reclaimed"
      ) {
        return null;
      }
      type Failure = {
        readonly reason: string;
        readonly transient: boolean;
        /** The parent's worker is out of reach: nothing was recorded,
          and the child retries on its next pass. */
        readonly unavailable?: boolean;
      } | null;
      const fail = (reason: string, transient = false) =>
        failWorktree(card, reason).pipe(Effect.as<Failure>({ reason, transient }));
      const unreachable: Failure = {
        reason: "The card's worker is unreachable.",
        transient: true,
        unavailable: true,
      };
      // An inherit group has no branch of its own, and grouping alone
      // never touches git.
      if (boardCardGroupOf(yield* readBoard, card)?.target === "inherit") return null;
      // Cut on the PARENT's worker and pushed: a child placed elsewhere
      // cuts its own branch from the remote copy.
      const workspace = yield* workspaceFor(card);
      const cwd = workspace.checkoutPath;
      if (cwd === null) {
        return yield* fail(noWorkspaceFolderReason(workspace));
      }
      const branch = boardCardWorktreeBranchName(card);
      const resolved = yield* resolveDefaultBranch(workspace);
      if (resolved.unavailable) return unreachable;
      const { defaultBranch } = resolved;
      if (defaultBranch === "") {
        return yield* fail(noDefaultBranchReason(cwd, resolved, "the integration branch"));
      }
      // Cut from the parent's effective base, not the project default, or every child of a parent
      // pinned to another branch would inherit the wrong base.
      const integrationBase =
        resolveBoardCardEffectiveBase({
          card,
          cards: (yield* readBoard).cards,
          defaultBranch,
        }) ?? defaultBranch;
      const baseExists = yield* ensureLocalBaseBranch(workspace, integrationBase);
      if (baseExists === "unavailable") return unreachable;
      if (!baseExists) {
        return yield* fail(
          `The card's base branch '${integrationBase}' does not exist in ${cwd}, locally or on a remote, so there is nothing to cut the integration branch from.`,
        );
      }
      // Idempotent on retry: an existing branch is the desired state, not an
      // error (an earlier attempt may have created it and died before the
      // record landed, or a raced sibling created it a moment ago).
      type Cut = BoardWorkspaceIntegrationBranch | "unavailable";
      const cut = yield* workspace.createIntegrationBranch({ branch, base: integrationBase }).pipe(
        Effect.map((result): Cut => result),
        Effect.catch((error): Effect.Effect<Cut> =>
          error._tag === "WorkerUnavailable"
            ? Effect.succeed("unavailable" as const)
            : Effect.logWarning("board supervisor: integration branch creation failed", {
                cardId: card.id,
                detail: error.detail,
              }).pipe(Effect.as({ outcome: "create-failed" } as const)),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: integration branch creation failed", {
            cardId: card.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ outcome: "create-failed" } as const)),
        ),
      );
      if (cut === "unavailable") return unreachable;
      if (cut.outcome === "create-failed") {
        return yield* fail(
          `Could not create the integration branch '${branch}' from '${integrationBase}'.`,
          true,
        );
      }
      const pushed = cut.pushed;
      if (!pushed) {
        yield* dispatch({
          type: "board.card.record-note",
          commandId: yield* commandId("push-skipped"),
          cardId: card.id,
          kind: "card-branch-push-skipped",
          detail: `Created '${branch}' locally but could not push it; child pull requests will have no remote base until it is pushed.`,
          createdAt: yield* nowIso,
        });
      }
      yield* dispatch({
        type: "board.card.record-integration-branch",
        commandId: yield* commandId("record-integration-branch"),
        cardId: card.id,
        branch,
        baseRefName: integrationBase,
        createdAt: yield* nowIso,
      });
      return null;
    },
  );

  const handlePlansApproved = Effect.fn("board-supervisor-handlePlansApproved")(function* (
    event: Extract<BoardEvent, { type: "board.plans-approved" }>,
  ) {
    yield* ensureIntegrationBranch(event.payload.card);
    // Approving a split on a parent already at build emits no move, so the cascade's usual trigger
    // never comes. The helper no-ops unless the parent is at build.
    yield* cascadeUnblockedChildren(event.payload.card.id);
  });

  // A card was created: if it landed in an auto-executing stage, kick off
  // exactly as a drag would. The created payload is flat, so re-read the card.
  const handleCardCreated = Effect.fn("board-supervisor-handleCardCreated")(function* (
    event: Extract<BoardEvent, { type: "board.card-created" }>,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
    if (card === undefined) return;
    // A sub-board child created by plan approval must not auto-start: one approval cannot fan out
    // into N running agents, and the decider has no settings to enforce it. Any other card created
    // in an auto stage kicks off here, including one created inside a group.
    if (card.sourcePlanId !== null) return;
    yield* beginStageRun({ card: yield* markAutoPlanIfOn(card), onDemand: false });
    if (card.parentCardId !== null) yield* cascadeUnblockedChildren(card.parentCardId);
  });

  /**
   * A card moved to another project: anything live is editing the wrong checkout, so abandon it,
   * clear the stage's threads (records kept) and let the stage restart if it auto-executes.
   * Mirrors `beginStageRun`'s on-demand arm: an earlier run's link would trip the live-thread
   * guard. Adopted (`linked`) threads are left alone.
   */
  const handleCardProjectChanged = Effect.fn("board-supervisor-handleCardProjectChanged")(
    function* (event: Extract<BoardEvent, { type: "board.card-project-changed" }>) {
      const card = event.payload.card;
      const board = yield* readBoard;
      const existing = boardCardStepState(board, card.id);
      const live = existing !== null && !isBoardTerminalStepStatus(existing.status);
      if (live) {
        yield* settleStep({ card, state: existing, outcome: "abandoned" });
      }
      const cleared = new Set<string>();
      for (const link of card.threadLinks) {
        if (!isLiveBoardCardThreadLink(link)) continue;
        if (link.role !== card.stage && link.threadId !== existing?.threadId) continue;
        yield* dispatch({
          type: "board.card.unlink-thread",
          commandId: yield* commandId("unlink-project-changed"),
          cardId: card.id,
          threadId: link.threadId,
          createdAt: yield* nowIso,
        });
        cleared.add(String(link.threadId));
        // Unlinking a LIVE thread removes the link outright, so `threadRelease`
        // can no longer derive it from any card and it would sit unsettled in
        // the inbox forever. The card is finished with it — name it.
        abandonedThreads.add(String(link.threadId));
      }
      // A stalled or paused step has no turn running; anything else may still be writing the old
      // project's checkout. Best-effort.
      if (
        live &&
        existing.threadId !== null &&
        existing.status !== "stalled" &&
        existing.status !== "paused"
      ) {
        yield* interruptOrphan(existing.threadId);
      }
      // The abandoned step may have held a slot — offer it to the queue.
      if (live) yield* schedule();
      // Reflect the unlinks onto the card handed to the kickoff, so the guard
      // does not see the very links we just tombstoned.
      const kickoffCard: BoardCard = {
        ...card,
        threadLinks: card.threadLinks.map((link) =>
          isLiveBoardCardThreadLink(link) && cleared.has(String(link.threadId))
            ? { ...link, tombstonedAt: card.updatedAt }
            : link,
        ),
      };
      // `onDemand: false` on purpose: the stage's own `autoExecute` decides
      // whether the card restarts, so Planning picks itself back up and Backlog
      // stays put, with no branching of our own.
      yield* beginStageRun({ card: kickoffCard, onDemand: false });
      yield* releaseFinishedThreads;
    },
  );

  // A non-terminal step left on the card's one step row belongs to the stage it left (auto-advance
  // settles first), and would block the destination's kickoff. Abandon it, then kick off the
  // destination on a fresh read.
  const handleCardMoved = Effect.fn("board-supervisor-handleCardMoved")(function* (
    event: Extract<BoardEvent, { type: "board.card-moved" }>,
  ) {
    // The destination stage and the current link set both come from the event
    // payload, not a board re-read: the card carries its post-move stage here,
    // which is the one authority every other move path already trusts.
    const card = event.payload.card;
    // A card leaving or re-entering a stage starts a fresh run of provisioning
    // retries: a count from an earlier visit would park it early.
    transientProvisionFailures.delete(card.id);
    const board = yield* readBoard;
    // A forward arrival at merge with a stale round-start tip goes straight back to review, where
    // the plan enqueues sync-base and the gate round. The early return leaves the live step alone.
    {
      const toStage = boardStageById(board, event.payload.toStage);
      const reviewStage = boardStageWithRole(board, "review");
      const fromIndex = boardStageIndex(board, event.payload.fromStage);
      const toIndex = boardStageIndex(board, event.payload.toStage);
      if (
        toStage !== null &&
        effectiveBoardStageRole(toStage) === "merge" &&
        reviewStage !== null &&
        fromIndex >= 0 &&
        toIndex > fromIndex &&
        // Scope lives in `resolveBaseStale`, not here: tip-moved
        // stays children-only, a retarget applies at any level.
        (yield* resolveBaseStale(card))
      ) {
        yield* dispatch({
          type: "board.card.record-note",
          commandId: yield* commandId("stale-base-note"),
          cardId: card.id,
          kind: "card-base-stale",
          detail: `Held the merge crossing: base branch '${
            card.worktree?.baseRefName ?? "?"
          }' moved since the last review round started. Rebasing onto it, then one more review round.`,
          createdAt: yield* nowIso,
        });
        yield* dispatch({
          type: "board.card.move",
          commandId: yield* commandId("stale-base-return"),
          cardId: card.id,
          toStage: reviewStage.stageId,
          override: true,
          createdAt: yield* nowIso,
        });
        return;
      }
    }
    // A card leaving CI stops its pass; the move cleared its CI state.
    if (
      event.payload.fromStage === BOARD_SEED_STAGE_IDS.ci &&
      event.payload.toStage !== BOARD_SEED_STAGE_IDS.ci
    ) {
      yield* stopCiOnLeave(card);
    }
    const existing = boardCardStepState(board, card.id);
    let kickoffCard = card;
    if (existing !== null && !isBoardTerminalStepStatus(existing.status)) {
      yield* settleStep({ card, state: existing, outcome: "abandoned" });
      if (
        existing.threadId !== null &&
        keepsPlanningThreadOnExit(board, existing, event.payload.toStage)
      ) {
        // An unfinished planning interview keeps its thread and its running turn, so a plan it is
        // still writing lands and `beginStageRun` resumes on the same thread back in Planning.
      } else if (existing.threadId !== null) {
        // Retired: the abandoned step's thread stays on the card.
        yield* dispatch({
          type: "board.card.retire-thread",
          commandId: yield* commandId("retire-moved"),
          cardId: card.id,
          threadId: existing.threadId,
          createdAt: yield* nowIso,
        });
        // Settling the row does not stop the agent: a leftover can still be mid-flight, burning
        // capacity and writing the worktree beside the destination's thread. Best-effort.
        yield* interruptOrphan(existing.threadId);
        // Named so the interrupt above is not read as a human Stop.
        abandonedThreads.add(String(existing.threadId));
        // `beginStageRun` checks the links for a live stage thread, and the link just retired would
        // otherwise trip that guard against the thread being abandoned.
        kickoffCard = {
          ...card,
          threadLinks: card.threadLinks.map((link) =>
            link.threadId === existing.threadId && isLiveBoardCardThreadLink(link)
              ? { ...link, retiredAt: event.payload.card.updatedAt }
              : link,
          ),
        };
      }
      // The abandoned step may have held a slot — offer it to the queue.
      yield* schedule();
    }
    const fromIndex = boardStageIndex(board, event.payload.fromStage);
    const toIndex = boardStageIndex(board, event.payload.toStage);
    // A stage change may need a current PR state (merge stage) or settle at Done;
    // `refreshCardPullRequest` settles a Done card with a merged PR itself.
    yield* refreshCardPullRequest(card, card.stage, { deferSettle: true });

    // Arrival at merge readies a draft PR and starts CI however the card got here, before the
    // kickoff and auto-merge so the merge never meets a draft. It also resets the CI fix budget.
    let readiedOnArrival = false;
    if (
      boardStageWithRole(board, "merge")?.stageId === event.payload.toStage &&
      event.payload.fromStage !== event.payload.toStage
    ) {
      checksFixSpent.delete(String(card.id));
      mergeAwaitingChecks.delete(String(card.id));
      readiedOnArrival = yield* markCardPullRequestReady((yield* readCard(card.id)) ?? card, {
        forMerge: false,
      });
    }

    kickoffCard = yield* markAutoPlanIfOn(kickoffCard);
    yield* beginStageRun({ card: kickoffCard, onDemand: false });
    // The card changed stage, so the threads it left behind are finished work.
    // Run AFTER the kickoff, so the destination's own freshly linked
    // thread is already the card's current work and is left alone.
    yield* releaseFinishedThreads;

    // An armed card arriving at merge merges before the cascade below, so one arrival resolves the
    // chain. Only an adjacent forward step: a backward move is an undo and a jump is a human
    // override, and merging is irreversible. Adjacency, not "came from review", so boards without
    // a review stage still auto-merge. Arming a card already here bypasses this.
    if (
      boardStageWithRole(board, "merge")?.stageId === event.payload.toStage &&
      fromIndex >= 0 &&
      toIndex > fromIndex &&
      // Adjacent in the card's own pipeline: the CI seed sits
      // between review and merge globally, but only in a CI project's list.
      areBoardStagesAdjacent(
        board,
        event.payload.fromStage,
        event.payload.toStage,
        card.projectId,
      ) &&
      (yield* cardAutoMergeArmed(card))
    ) {
      // A pull request readied a moment ago has CI that has not registered
      // its checks yet: start the card on the ladder's first rung
      // rather than merging into checks that only look green.
      if (readiedOnArrival && card.pullRequest !== null) {
        yield* recordAutoMergeOutcome(card.id, justReadiedRefusal(card.pullRequest.number), {
          resetLadder: false,
        });
      } else {
        yield* autoMergeCard(card);
      }
    }
    // A card that left the merge stage drops its hold, or it would show "Merge held" elsewhere.
    // Read off the moved card, since the merge above may have taken it to Done.
    if (
      card.autoMergeHold !== null &&
      boardStageWithRole(board, "merge")?.stageId !== event.payload.toStage
    ) {
      // Gated on the payload card ALREADY carrying a hold, so an ordinary
      // card's every move costs nothing. Re-read before clearing, because the
      // merge above may have cleared it a moment ago.
      const moved = (yield* readCard(card.id)) ?? card;
      yield* clearAutoMergeHold(moved);
    }

    // A child changing stage may free a sibling to start; the
    // decider already re-derived its groups in the same decision, so
    // the sync is a cheap check that heals an event it did not shape.
    if (card.parentCardId !== null) {
      yield* cascadeUnblockedChildren(card.parentCardId);
      yield* syncAncestorGroups(card.parentCardId);
    }
    // A group reaching build begins its unblocked children; a child group cascades further. Only
    // groups with live children pay the helper's board read.
    if (boardCardChildren(board, card.id).some((child) => child.archivedAt === null)) {
      yield* cascadeUnblockedChildren(card.id);
    }
    // Dependencies cross groups: a card reaching Done may free a
    // card waiting in another group.
    if (boardStageWithRole(board, "done")?.stageId === event.payload.toStage) {
      yield* cascadeDependentGroups(card.id);
    }
    // Arriving in the done-role stage is what SATISFIES this card as a
    // dependency, so it is the moment an armed dependent can
    // become due. The targeted trigger, for latency: the 30s sweep would find
    // the same cards, up to half a minute later.
    if (boardStageWithRole(board, "done")?.stageId === event.payload.toStage) {
      yield* startArmedDependents(card.id);
    }
    // Arriving in the stage before build with its own Auto-build on starts the
    // card once its dependencies are met.
    if (boardStageBeforeBuild(board)?.stageId === event.payload.toStage) {
      yield* startArmedCards((candidate) => candidate.id === card.id);
    }
    // A move into build begins the group it sits in, or the group itself:
    // children waiting on its inherited Auto-build go on now.
    if (boardStageWithRole(board, "build")?.stageId === event.payload.toStage) {
      if (card.parentCardId !== null) {
        yield* reevaluateGroupChildren(card.parentCardId, { quiet: true });
      }
      if (boardCardChildren(board, card.id).some((child) => child.archivedAt === null)) {
        yield* reevaluateGroupChildren(card.id, { quiet: true });
      }
    }
    // Dragged back, so the toggle that would relaunch it is off.
    const disarmed = event.payload.automationChanged;
    if (disarmed !== undefined) {
      const which = [
        ...(disarmed.autoPlan === true ? ["Auto-plan"] : []),
        ...(disarmed.autoBuild === true ? ["Auto-build"] : []),
      ];
      if (which.length > 0) {
        yield* autoPlanNote(
          card.id,
          `Moved back, so ${which.join(" and ")} ${which.length === 1 ? "is" : "are"} off for this card. Turn ${which.length === 1 ? "it" : "them"} on again in Automation.`,
        );
      }
    }
  });

  // On-demand kickoff request: start a thread for the card's current stage.
  const handleStageThreadRequested = Effect.fn("board-supervisor-handleStageThreadRequested")(
    function* (event: Extract<BoardEvent, { type: "board.card-stage-thread-requested" }>) {
      const board = yield* readBoard;
      const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
      if (card === undefined) return;
      yield* beginStageRun({ card, onDemand: true });
    },
  );

  /**
   * A step whose turn never started (`provider.turn.start.failed`): no agent to nudge, so the
   * ladder would only waste time while the card shows a lying spinner. Land it `stalled` with the
   * provider's error and release the slot; Restart supersedes it. Never retried on another
   * model: the stage names its model.
   */
  const failStepAtSpawn = Effect.fn("board-supervisor-failStepAtSpawn")(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
  }) {
    const board = yield* readBoard;
    const state = (board.stepStates ?? []).find(
      (candidate) => candidate.threadId === input.threadId,
    );
    // Not a board step's thread, or a step that has already settled — a human's
    // own thread failing to start is theirs to see in the thread itself.
    if (state === undefined || isBoardTerminalStepStatus(state.status)) return;
    // The activity can repeat for one dead session, and re-landing would inflate `attempt` and
    // double-release the slot. A paused step is parked by a human, not failed.
    if (state.status === "stalled" || state.status === "paused") return;
    const card = board.cards.find((candidate) => candidate.id === state.cardId);
    if (card === undefined || card.archivedAt !== null) return;

    const summary = boardStepErrorSummary(input.detail);
    yield* Effect.logWarning("board supervisor: step provider failed to start", {
      cardId: card.id,
      stepId: state.stepId,
      providerInstanceId: state.providerInstanceId,
      model: state.model,
      detail: input.detail,
    });
    // Same reason escalation disarms (see `recoverStep`): a conflict fix that
    // never ran must not leave the card armed, or some later merge-stage step
    // succeeding turns into a merge nobody asked for.
    disarmPendingMerge(card.id);
    yield* dispatch({
      type: "board.card.recover-step",
      commandId: yield* commandId("fail-step-at-spawn"),
      cardId: card.id,
      stepId: state.stepId,
      threadId: state.threadId,
      escalateToHuman: true,
      // No turn ran, so nothing progressed. This also increments `stallCount`,
      // which is right: a stage pointed at a provider that cannot start is
      // exactly the state the ceiling exists to stop cards cycling through.
      progressed: false,
      // Absent when the provider gave us nothing renderable — the key is
      // optional, and the decider reads "absent" as "no reason".
      ...(summary === null ? {} : { lastError: summary }),
      createdAt: yield* nowIso,
    });
    // Release exactly once, riding the same machinery as escalation: the
    // pre-stall state's `slotHeld` gates it, and the decider has already set the
    // persisted flag false.
    yield* releaseSlot(state);
    yield* schedule();
  });

  /**
   * A parked step goes back to work on `thread.turn-start-requested` (a turn was asked for) or
   * an answered `user-input.resolved` (answers mid-turn start no turn). Not on runtime
   * `turn.started`: adapters synthesise it without a human, and it would un-escalate a stall.
   * Un-parks `paused` too, and takes a slot; the later of the two signals finds it running.
   */
  const resumeParkedStep = Effect.fn("board-supervisor-resumeParkedStep")(function* (
    threadId: ThreadId,
    options: { readonly usageLimitOnly?: boolean } = {},
  ) {
    const board = yield* readBoard;
    const found = stepThreadCard(board, threadId);
    if (found === null) return false;
    if (!isBoardParkedStepStatus(found.state.status)) return false;
    // The engine's limit resume speaks only for the limit it was holding: a
    // step a human paused, or one waiting on a question, stays parked.
    if (
      options.usageLimitOnly === true &&
      !(found.state.status === "stalled" && found.state.stalledReason === "usage-limit")
    ) {
      return false;
    }
    if (found.card.archivedAt !== null) return false;
    // OBSERVED, not fire-and-forget: a refused resume must never restore a slot
    // that nothing will release — the same discipline `admitBuildCandidate`
    // applies around `admit-step`.
    const landed = yield* dispatchOptional({
      type: "board.card.resume-step",
      commandId: yield* commandId("resume-step"),
      cardId: found.card.id,
      stepId: found.state.stepId,
      createdAt: yield* nowIso,
    });
    if (!landed) return false;
    // A human put this step back to work themselves, so a schedule that would
    // stop it again later has been overtaken. Cleared here rather
    // than only on the `board.card-step-recovered` this dispatch produces,
    // because that event is raised from inside this reactor.
    yield* clearScheduleForCard(found.card.id);
    // The decider wrote `slotHeld: true`; `restore`, not `acquire`, since the agent is already
    // working. The count may exceed the ceiling until the step releases it once.
    if (found.state.mode === "build") yield* slots.restore(slotKeyFor(board, found.state));
    return true;
  });

  /**
   * A human started a turn on a running unattended step's thread: steering, not ending autonomy.
   * Recording the instant buys that turn one free ending, so the board does not nudge over the
   * human once the turn id is claimed. Only for running unattended steps: a parked step was not
   * resumed by this turn, and a human-in-the-loop step never recovers on a turn end.
   */
  const noteHumanTurn = Effect.fn("board-supervisor-noteHumanTurn")(function* (
    signal: Extract<ThreadSignal, { type: "turn-requested" }>,
  ) {
    // The board mints `server:board-…`; a client mints a bare UUID. A
    // nudge of our own must not buy itself a free ending, or the escalation
    // ceiling would never be reached.
    if (signal.byBoard) return;
    const board = yield* readBoard;
    const found = stepThreadCard(board, signal.threadId);
    if (found === null || found.card.archivedAt !== null) return;
    if (found.state.status !== "running" || found.state.humanInLoop) return;
    yield* dispatchOptional({
      type: "board.card.note-human-turn",
      commandId: yield* commandId("note-human-turn"),
      cardId: found.card.id,
      stepId: found.state.stepId,
      at: signal.at,
      createdAt: yield* nowIso,
    });
  });

  const handleTurnStartRequested = Effect.fn("board-supervisor-handleTurnStartRequested")(
    function* (signal: Extract<ThreadSignal, { type: "turn-requested" }>) {
      yield* resumeParkedStep(signal.threadId);
      // After the resume: a turn typed into a paused step both resumes and steers it.
      yield* noteHumanTurn(signal);
    },
  );

  /** Carry a card's explicit human-in-the-loop override onto its live step row
      when the two have diverged — the crash-recovery half of
      `handleCardUpdated`'s stance arm. A no-op when they agree, which is every
      card on an ordinary boot. */
  const reconcileStanceOverride = Effect.fn("board-supervisor-reconcileStanceOverride")(function* (
    card: BoardCard,
    state: BoardCardStepState,
  ) {
    const desired = stanceOverride(yield* readBoard, card, state);
    if (desired === null || desired === state.humanInLoop) return;
    yield* dispatchOptional({
      type: "board.card.retune-step",
      commandId: yield* commandId("reconcile-stance"),
      cardId: card.id,
      stepId: state.stepId,
      humanInLoop: desired,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Reconcile one live step against its thread, at boot or when its worker returns.
   * `restoreSlot` is boot's (in-memory counts start empty); a returning worker still holds its
   * slots. Returns the decision so the caller re-derives an advanced card's kickoff.
   */
  const reconcileStep = Effect.fn("board-supervisor-reconcileStep")(function* (input: {
    readonly board: BoardState;
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    readonly restoreSlot: boolean;
  }) {
    const { board, card, state } = input;
    // Re-settle a stance a lost `board.card-updated` never carried: domain events are a live
    // PubSub, not a durable replay, so an edit committed just before a kill is never redelivered.
    // A field comparison per step, dispatching only on disagreement; idempotent, and sends no turn.
    yield* reconcileStanceOverride(card, state);
    const hasSucceeded = boardCardStepCompletions(board, card.id).some(
      (entry) => entry.stepId === state.stepId && entry.outcome === "succeeded",
    );
    const shell = state.threadId === null ? undefined : yield* liveThread(state.threadId);
    const threadAlive = shell !== undefined && shell.alive;
    const decision = reconcileStepDecision({
      status: state.status,
      threadAlive,
      // Present but idle is the state a step parked on a human rests in: no
      // turn, no pending question, and a thread the human can still answer in.
      threadPresent: shell !== undefined,
      humanInLoop: state.humanInLoop,
      hasSucceeded,
    });
    // Slot counts are empty after a restart, so a step that holds a slot restores it whether
    // watched or recovered. Never capped, and before `schedule`, so restored steps count against
    // the ceiling.
    if (input.restoreSlot && state.slotHeld && decision.kind !== "advance") {
      yield* slots.restore(slotKeyFor(yield* readBoard, state));
    }
    switch (decision.kind) {
      case "advance":
        yield* settleStep({ card, state, outcome: "succeeded" });
        // Ask the executor what runs next: advance a finished single-step
        // stage, or resume the next round-scoped step of a multi-step loop
        // whose phase settled during downtime.
        yield* continueStage({ card, state });
        break;
      case "recover":
        yield* recoverStep({ card, state });
        break;
      case "park":
        // Boot twin of the human-in-the-loop arm of `handleTurnCompleted`: name the kind of stop.
        // The slot restored above is given back, since a parked step holds none; `resumeParkedStep`
        // re-takes it.
        yield* parkStepForInput({
          card,
          state,
          reason: (yield* endedWithQuestion(state)) ? "question" : "stopped",
        });
        break;
      case "reschedule":
        // Pending/queued and slotless — placed by the final schedule pass
        // below, once every restored running step is counted.
        break;
      case "resume-watch":
        // Still running with a live thread — the slot was restored above; let
        // the live turn-completion path catch its settlement. A triage or
        // adjudication question pending across the restart has nobody to
        // answer it but the board.
        if (state.status === "running" && shell?.awaitingUserInput === true) {
          if (isReviewDecidingStep(state)) yield* handleReviewStepQuestion(card, state);
        }
        break;
    }
    return decision.kind;
  });

  /**
   * Kickoff for cards a reconcile advanced: their card-moved events may have had no subscriber,
   * so it is re-derived from state. `bootPass` limits it to first entries and executor-driven
   * continuations; `beginStageRun`'s guards make it idempotent.
   */
  const kickoffAdvanced = Effect.fn("board-supervisor-kickoffAdvanced")(function* (
    advanced: ReadonlyArray<BoardCard["id"]>,
  ) {
    if (advanced.length === 0) return;
    const settled = yield* readBoard;
    for (const cardId of advanced) {
      const card = settled.cards.find((candidate) => candidate.id === cardId);
      if (card === undefined || card.archivedAt !== null) continue;
      const state = boardCardStepState(settled, card.id);
      if (state !== null && !isBoardTerminalStepStatus(state.status)) continue;
      yield* beginStageRun({ card, onDemand: false, bootPass: true });
    }
  });

  /**
   * Reconcile one returning worker's steps before any of its held signals. Threads match by id,
   * so a live one is watched, not respawned. False when a thread could not be read, so the
   * caller retries. Threads it decided on are added to `decidedThreads` either way.
   */
  const reconcileWorker = Effect.fn("board-supervisor-reconcileWorker")(function* (
    workerId: BoardWorkerId,
  ) {
    const board = yield* readBoard;
    let whole = true;
    const advanced: BoardCard["id"][] = [];
    const decided = decidedThreads.get(workerId) ?? new Set<string>();
    decidedThreads.set(workerId, decided);
    for (const state of boardNonTerminalStepStates(board)) {
      if (slotKeyFor(board, state).workerId !== workerId) continue;
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined) continue;
      const result = yield* reconcileStep({ board, card, state, restoreSlot: false }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: a worker's step could not be reconciled", {
            workerId,
            cardId: card.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (result === null) {
        whole = false;
        continue;
      }
      if (result === "advance") advanced.push(card.id);
      // What the reconcile read is newer than anything held for that thread.
      if (
        state.threadId !== null &&
        (result === "advance" || result === "recover" || result === "park")
      ) {
        decided.add(String(state.threadId));
      }
    }
    yield* kickoffAdvanced(advanced);
    return whole;
  });

  /**
   * Update each worker's reach. A dropped worker is unreconciled and its offline time starts; one
   * back online is reconciled, then its held signals released (minus those for threads just
   * decided), and its offline interval is excluded from timeouts. The caller schedules after.
   */
  const syncWorkerReach = Effect.gen(function* () {
    if (Option.isNone(placement)) return;
    const summary = yield* workersNow;
    const nowMs = Date.parse(yield* nowIso);
    const registered = new Set<BoardWorkerId>(summary.workers.map((worker) => worker.id));
    const online = new Set<BoardWorkerId>(
      summary.workers
        .filter((worker) => worker.status.state === "online")
        .map((worker) => worker.id),
    );
    // Drops the feed saw first, with when it saw them: one already back online
    // is unreconciled all the same.
    const dropped = [...droppedWorkers];
    droppedWorkers.clear();
    for (const [workerId, at] of dropped) {
      if (!registered.has(workerId)) continue;
      reconciledWorkers.delete(workerId);
      if (!unreachableSince.has(workerId)) unreachableSince.set(workerId, at);
    }
    for (const workerId of reconciledWorkers) {
      if (!online.has(workerId)) reconciledWorkers.delete(workerId);
    }
    for (const workerId of registered) {
      if (!online.has(workerId) && !unreachableSince.has(workerId)) {
        unreachableSince.set(workerId, nowMs);
      }
    }
    // A removed worker is forgotten; its cards are the removal's business.
    for (const map of [unreachableSince, offlineIntervals, heldSignals, decidedThreads]) {
      for (const workerId of map.keys()) if (!registered.has(workerId)) map.delete(workerId);
    }
    for (const workerId of online) {
      if (reconciledWorkers.has(workerId)) continue;
      if (!(yield* reconcileWorker(workerId))) continue;
      const decided = decidedThreads.get(workerId) ?? new Set<string>();
      decidedThreads.delete(workerId);
      const since = unreachableSince.get(workerId);
      if (since !== undefined) {
        offlineIntervals.set(workerId, [
          ...(offlineIntervals.get(workerId) ?? []),
          { from: since, to: nowMs },
        ]);
        unreachableSince.delete(workerId);
      }
      reconciledWorkers.add(workerId);
      const held = heldSignals.get(workerId) ?? [];
      heldSignals.delete(workerId);
      for (const signal of held) {
        if (decided.has(String(signal.threadId))) continue;
        yield* processThreadSignal(signal).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("board supervisor: a held signal failed", {
              workerId,
              signal: signal.type,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
    }
  });

  const reconcile = Effect.gen(function* () {
    // Wait for activation: upstream's `provider-sessions.reconcile` runs a phase after this and
    // marks restart-orphaned sessions, so reading earlier makes dead steps look alive. Waited here
    // rather than relying on phase order. Absent where activation is not wired (tests); the item
    // is still enqueued first, so live events stay queued behind it.
    if (serverActivation !== undefined) yield* serverActivation;
    // Sweep cached todo rows whose thread or link is gone: a delete while the server was down
    // leaves rows with no event to un-apply. Best-effort, never blocks reconcile. The clock is
    // read first so a thread born after the listing keeps its row.
    const listedAt = yield* nowIso;
    yield* threads.listLiveThreadIds().pipe(
      Effect.flatMap((liveThreadIds) =>
        boardQueries.boardSweepThreadTodos(liveThreadIds, listedAt),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor: thread-todo sweep failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    const board = yield* readBoard;
    // Cards reconcile settles as succeeded may auto-advance, but subscribers are parked until
    // activation, so their kickoff is re-derived from state at the end of the pass.
    const advanced: BoardCard["id"][] = [];
    // A step on a worker is left for that worker's own reconcile
    // (`syncWorkerReach`, below), which needs it online — a worker the board
    // can't reach supplies no evidence. Its slot is restored now all the same:
    // it is held until that reconcile, or a removal, gives it back.
    const paused = yield* workerPausedNow;
    for (const state of boardNonTerminalStepStates(board)) {
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined) continue;
      if (paused(slotKeyFor(board, state).workerId)) {
        if (state.slotHeld) yield* slots.restore(slotKeyFor(board, state));
        continue;
      }
      const decided = yield* reconcileStep({ board, card, state, restoreSlot: true });
      if (decided === "advance") advanced.push(card.id);
    }
    // Every worker online now, reconciled before anything else acts on it.
    yield* syncWorkerReach;
    // With every restored slot counted, offer the queued/pending steps to the
    // governor: re-admit what now fits, re-queue the rest. Slot accounting
    // reconciles to zero once all work drains, including after a forced restart.
    yield* schedule();
    // Kickoff pass for the cards reconcile itself advanced.
    yield* kickoffAdvanced(advanced);
    // CI passes the restart cut off run again from the top.
    yield* recoverCiPasses();
    // Resume review loops halted between phases: nothing is in flight, so no event will ask again.
    // Converged or held loops plan `complete`, which `replanSettledStage` ignores; `resume` leaves
    // base staleness unmeasured so a restart never starts an unattended sync.
    const quiet = yield* readBoard;
    for (const card of quiet.cards) {
      if (card.archivedAt !== null) continue;
      const state = boardCardStepState(quiet, card.id);
      if (state === null || !settledReviewPhase(quiet, card, state)) continue;
      yield* replanSettledStage(card, { resume: true });
    }
    // Re-evaluate every finished card's worktree and the board's orphans on boot, refreshing Done
    // cards whose cached PR is still open. Off the worker: it fetches from remotes.
    yield* requestWorktreeSweep({ refreshOpenPullRequests: true });
    // Settle threads the board finished with while down. A predicate over state, so no backlog
    // replay; a settle that cannot land is retried by the 30s sweep.
    yield* releaseFinishedThreads;
    // Start every card whose last dependency landed while the server was down.
    // A predicate over state rather than an event to catch, so
    // boot needs no backlog to replay — it simply asks the question once, and
    // the 30s sweep asks it again from then on.
    yield* sweepArmedCards;
    // And every retry rung that came due while the server was down.
    // A predicate over state rather than an event to catch, exactly like the
    // armed-card pass above, so a card parked for a rung that expired hours ago
    // does not wait another 30s.
    yield* sweepRetries;
    // Last: it is the only sweep that may call the forge, and a card it merges moves to Done, which
    // the armed-card pass above must not see first.
    yield* sweepAutoMergeHolds;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: reconciliation failed", { cause: Cause.pretty(cause) }),
    ),
  );

  // When each step thread was last seen held on a permission prompt, or had one answered. Read
  // as a life sign, so a freshly approved agent gets a full window instead of an immediate nudge.
  // Stamped by the human's answer and by the sweep while a prompt holds. In-memory; dropped once
  // released and a window old, or when the step leaves running.
  const permissionHeldAt = new Map<string, string>();

  // Step threads waiting on their own background work: start, check-ins sent, and whether the
  // latest is unanswered. Only a check-in's reply keeps the schedule; other turns or a commit
  // start a fresh wait. In-memory on purpose: background work dies with the server.
  const backgroundWaits = new Map<
    string,
    {
      readonly since: string;
      readonly checkInsSent: number;
      readonly checkInOutstanding: boolean;
      readonly progressed: boolean;
    }
  >();
  const beginBackgroundWait = (threadId: ThreadId, now: string, progressed = false) =>
    void backgroundWaits.set(String(threadId), {
      since: now,
      checkInsSent: 0,
      checkInOutstanding: false,
      progressed,
    });
  /**
   * Only a check-in's reply continues the schedule, or replies would restart the free check-ins.
   * Any other turn starts a fresh wait, carrying forward a commit made since the old one began,
   * which the new `since` would hide.
   */
  const noteBackgroundTurnEnd = Effect.fn("board-supervisor-noteBackgroundTurnEnd")(function* (
    found: { readonly card: BoardCard; readonly state: BoardCardStepState },
    threadId: ThreadId,
  ) {
    const wait = backgroundWaits.get(String(threadId));
    if (wait?.checkInOutstanding === true) {
      backgroundWaits.set(String(threadId), { ...wait, checkInOutstanding: false });
      return;
    }
    const progressed =
      wait !== undefined &&
      (wait.progressed || (yield* committedSince(found.state, found.card, wait.since)));
    beginBackgroundWait(threadId, yield* nowIso, progressed);
  });
  /** The thread's shell when it is between turns, needs no human and has
      background work — the same reading the card's "Waiting" label makes. */
  const threadWaitingOnBackground = (threadId: ThreadId) =>
    liveThread(threadId).pipe(Effect.map((shell) => shell?.waitingOnBackground ?? false));

  /**
   * Supervise a step waiting on its own background work; true means the timeout logic must not
   * run. Check-ins at +5, +15, +30 minutes, then every 30, asking the agent to verify the work.
   * The first three are free; later ones are charged like recoveries (no backoff park) and the
   * one crossing a ceiling escalates. The step stays running.
   */
  const sweepBackgroundWait = Effect.fn("board-supervisor-sweepBackgroundWait")(function* (input: {
    readonly board: BoardState;
    readonly state: BoardCardStepState;
    readonly now: string;
    readonly nowMs: number;
  }) {
    const { board, state } = input;
    if (state.threadId === null) return false;
    const key = String(state.threadId);
    const wait = backgroundWaits.get(key);
    if (wait === undefined) {
      // The turn end was missed (a dropped event): begin the wait here, ahead of the
      // caller's `timeoutMs` gate, so a step with no timeout is still checked
      // on and a timed one does not idle a whole timeout first.
      if (!(yield* threadWaitingOnBackground(state.threadId))) return false;
      beginBackgroundWait(state.threadId, input.now);
      return true;
    }
    const shell = yield* liveThread(state.threadId);
    if (shell === undefined || !shell.waitingOnBackground) {
      // A live turn (a check-in being answered) is supervised the ordinary
      // way and keeps the wait; background work that is gone ends it.
      if (shell === undefined || shell.backgroundWork === null) backgroundWaits.delete(key);
      return false;
    }
    const card = board.cards.find((candidate) => candidate.id === state.cardId);
    if (card === undefined || card.archivedAt !== null) return true;
    // The agent committed real work: whatever it is waiting on now is a new
    // wait, and gets a fresh five-minute first check. A todo advance is not
    // read here (see `committedSince`); a wake that did real work restarts the
    // schedule through its own turn end instead.
    if (yield* committedSince(state, card, wait.since)) {
      beginBackgroundWait(state.threadId, input.now, true);
      return true;
    }
    const sinceMs = Date.parse(wait.since);
    if (input.nowMs < boardBackgroundCheckInDueMs({ sinceMs, checkInsSent: wait.checkInsSent })) {
      return true;
    }
    // A human's message is already on its way in; the board's would land
    // behind it.
    if (yield* supersededByPendingTurn(state)) return true;
    const charged = boardBackgroundCheckInCharged(wait.checkInsSent);
    if (charged) {
      const exec = resolveBoardStageExecution(
        yield* boardSettings,
        card.stage,
        boardProjectStageConfig(board, card.projectId),
      );
      const ceiling = recoveryCeilingCrossed({
        stallCount: state.stallCount + 1,
        maxAttempts: state.maxAttempts,
        stageEntryRecoveries: boardStageEntryRecoveryCount(board, card.id) + 1,
        maxRecoveriesPerStageEntry: exec.maxInvocationsPerStageEntry,
      });
      if (ceiling !== null) {
        yield* Effect.logWarning("board supervisor: background wait escalated to a human", {
          cardId: card.id,
          stepId: state.stepId,
          ceiling,
          waitingSince: wait.since,
          checkInsSent: wait.checkInsSent,
        });
        backgroundWaits.delete(key);
        yield* escalateStep({ card, state, progressed: false });
        return true;
      }
    }
    const checkedIn = yield* dispatchOptional({
      type: "board.card.check-in-step",
      commandId: yield* commandId("check-in-step"),
      cardId: card.id,
      stepId: state.stepId,
      charged,
      progressed: wait.progressed,
      createdAt: input.now,
    });
    if (!checkedIn) return true;
    backgroundWaits.set(key, {
      since: wait.since,
      checkInsSent: wait.checkInsSent + 1,
      checkInOutstanding: true,
      progressed: false,
    });
    yield* sendTurn({
      threadId: state.threadId,
      text: boardBackgroundCheckInNudge(),
      runtimeMode: state.runtimeMode,
    });
    return true;
  });
  // A permission prompt, or a question only a human can answer: a `request_secret` waits inside
  // a live run with no question signal to park the step. Review-deciding questions are the
  // board's own to answer, so they never count.
  const threadAwaitingHuman = (state: Pick<BoardCardStepState, "stepId">, threadId: ThreadId) =>
    liveThread(threadId).pipe(
      Effect.map(
        (shell) =>
          shell !== undefined &&
          (shell.awaitingPermission ||
            (shell.awaitingUserInput &&
              shell.sessionStatus !== "error" &&
              !isReviewDecidingStep(state))),
      ),
    );
  const stampPermissionAnswered = (threadId: ThreadId) =>
    nowIso.pipe(Effect.map((now) => void permissionHeldAt.set(String(threadId), now)));

  const processDomainEvent = (event: BoardEvent) => {
    switch (event.type) {
      case "board.card-moved":
        // Generic auto-kickoff: a card landing in ANY stage may start a run
        // — not just Building. The stage's `autoExecute` setting gates it. The
        // handler first clears any leftover step from the stage the card left,
        // so a card carrying a stalled/in-flight step still starts the new one.
        return handleCardMoved(event);
      case "board.card-project-changed":
        // The card is now in a different repository, so anything live
        // is working the wrong checkout. Abandon it and restart the stage.
        return handleCardProjectChanged(event);
      case "board.card-created":
        // Creating a card straight into an auto-executing stage is a real path
        // now and must behave identically to a drag.
        return handleCardCreated(event);
      case "board.card-stage-thread-requested":
        // On-demand kickoff, the counterpart of auto-kickoff.
        return handleStageThreadRequested(event);
      case "board.card-updated":
        return event.payload.workCancelled === true
          ? handleWorkCancelled(event.payload.card).pipe(Effect.andThen(handleCardUpdated(event)))
          : handleCardUpdated(event);
      case "board.card-step-completed":
        return handleStepCompleted(event);
      case "board.plan-review-stopped":
        return handlePlanReviewStopped(event);
      case "board.plan-review-started":
        return handlePlanReviewStartedLate(event);
      case "board.plan-review-rounds-changed":
        return handlePlanReviewRoundsChanged(event);
      case "board.card-step-awaiting-input":
      case "board.card-step-paused":
      case "board.card-step-settled":
        return endAutoPlanIfUndriven(event.payload.cardId);
      case "board.card-step-force-start-requested":
        // A human took a slot over the cap. Scheduling here is what
        // makes the click start the card: without it the override would sit on
        // the row until some unrelated step boundary happened to run a pass.
        return schedule();
      case "board.card-step-recovered":
        // A resume overtakes a schedule: every way out of a parked step publishes this event, so
        // one clear covers them all. Safe against a recovery nudge: a card with a future schedule
        // has no running step to nudge.
        return clearScheduleForCard(event.payload.cardId).pipe(
          Effect.andThen(
            // A `requeue-step` lands `queued` with no slot; offer it to the governor now. Nudges
            // and in-thread resumes also emit this event, hence the status test.
            event.payload.state.status === "queued" ? schedule() : Effect.void,
          ),
          Effect.andThen(endAutoPlanIfUndriven(event.payload.cardId)),
        );
      case "board.project-stage-config-set":
        return handleProjectConfigSet(event.payload.projectId);
      case "board.card-archived":
        return handleArchived(event);
      case "board.card-deleted":
        return handleCardDeleted(event);
      case "board.plans-approved":
        // The split's integration branch.
        return handlePlansApproved(event);
      case "board.card-worker-pinned":
        // A re-pin may give a step stalled for a missing provider a worker
        // that has it, and a held card a worker that is ready — and
        // takes a card off a worker it may have a step stranded on.
        return stallStrandedStep(event.payload.cardId).pipe(
          Effect.andThen(requeueResolvedPlacementStalls(event.payload.cardId)),
          Effect.andThen(schedule()),
        );
      case "board.card-worker-move-recorded":
        // A force-move's start strands whatever ran on the old worker;
        // a move that landed releases the card's held step.
        if (event.payload.step.phase === "start") return stallStrandedStep(event.payload.cardId);
        return event.payload.step.phase === "done" || event.payload.step.phase === "restarted"
          ? requeueResolvedPlacementStalls(event.payload.cardId).pipe(Effect.andThen(schedule()))
          : Effect.void;
      case "board.worker-removed":
        return stallStepsOnRemovedWorker(event.payload.workerId).pipe(Effect.andThen(schedule()));
      case "board.card-worker-removal":
        // A re-add reattaches the card; whatever its removal stalled resumes
        // once the worker is online.
        return event.payload.outcome === "reattached"
          ? requeueResolvedPlacementStalls(event.payload.cardId).pipe(Effect.andThen(schedule()))
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  /** The worker a thread lives on, from the card link that names it; null for
      a thread no card links. */
  const threadWorkerId = (board: BoardState, threadId: ThreadId): BoardWorkerId | null => {
    for (const card of board.cards) {
      const link = card.threadLinks.find((candidate) => candidate.threadId === threadId);
      if (link !== undefined) return boardThreadLinkWorkerId(link);
    }
    return null;
  };

  /**
   * A thread signal, unless its worker is not reconciled: then it
   * is held until `syncWorkerReach` has reconciled that worker, so the boot
   * reconcile scoped to it acts first. A removed worker's signals are dropped —
   * its steps were stalled, and nothing it says changes that.
   */
  // Untraced: runs once per thread signal, a per-event hot path.
  const gateThreadSignal = Effect.fnUntraced(function* (signal: ThreadSignal) {
    if (Option.isNone(placement)) return yield* processThreadSignal(signal);
    const board = yield* readBoard;
    if ((board.workers ?? []).length === 0) return yield* processThreadSignal(signal);
    const workerId = threadWorkerId(board, signal.threadId);
    if (workerId === null || workerId === BOARD_LOCAL_WORKER_ID || workerReconciled(workerId)) {
      return yield* processThreadSignal(signal);
    }
    if (!(board.workers ?? []).some((worker) => worker.id === workerId)) return;
    const held = heldSignals.get(workerId) ?? [];
    held.push(signal);
    if (held.length > HELD_SIGNALS_MAX) held.shift();
    heldSignals.set(workerId, held);
  });

  const processThreadSignal = (signal: ThreadSignal) => {
    switch (signal.type) {
      case "turn-requested":
        // A human restarting a stalled step by hand — the board's own
        // turns land here too and no-op, since only a `stalled` step resumes.
        return handleTurnStartRequested(signal);
      case "limit-resumed":
        // v2's usage-limit recovery resumed a thread the board armed it for
        // (`parkForUsageLimit`): wake the step it parked, and nothing else.
        // Not a human turn, so it buys no free ending.
        return resumeParkedStep(signal.threadId, { usageLimitOnly: true }).pipe(
          Effect.andThen(deliverDeferredSteer(signal.threadId)),
        );
      case "interrupt-requested":
        // A human pressing Stop on a board-run step. The board's own
        // interrupts land here too and are filtered inside, off the sets that
        // already track them.
        return pauseStepForHumanStop(signal.threadId);
      case "approval-responded":
        // A human answered a permission prompt: a life sign for the
        // timeout sweep, so the resumed agent is not nudged seconds into work.
        return stampPermissionAnswered(signal.threadId);
      case "turn-start-failed":
        // A turn that never started has no turn end, so without this the step holds a slot and
        // shows a spinner until the timeout sweep.
        return failStepAtSpawn({ threadId: signal.threadId, detail: signal.detail });
      case "session-started":
        // Only matters for an orphan: the session the spawn raced now exists —
        // deliver the durable interrupt.
        if (!orphanedThreads.delete(String(signal.threadId))) return Effect.void;
        return interruptOrphan(signal.threadId);
      case "turn-ended":
        // An orphan whose turn ended needs no interrupt any more.
        orphanedThreads.delete(String(signal.threadId));
        // The ended turn's own id rides through: it is what lets the handler
        // tell a thread read that has not caught up yet from a genuinely live
        // second turn.
        return handleTurnEnded(signal.threadId, signal.turnRef);
      case "input-requested":
        // An ordinary agent question: fires for EVERY input
        // request.
        return handleInputRequested(signal.threadId);
      case "input-resolved":
        // A structured question being ANSWERED — the one way a
        // parked step goes back to work that no turn request sees. A
        // cancellation resolves the question too, and must not resume.
        if (!signal.answered) return Effect.void;
        return signal.byBoard === true
          ? resumeParkedStep(signal.threadId)
          : resumeParkedStep(signal.threadId).pipe(
              Effect.andThen(humanAnsweredPlanning(signal.threadId)),
            );
      case "todos-changed":
      case "thread-deleted":
        return Effect.void;
    }
  };

  // Enforce `timeoutMs` on unattended running steps: recovery is otherwise edge-triggered on
  // turn end, so a hung turn would hold its slot forever. Human-in-the-loop runs are exempt.
  const sweepTimeouts = Effect.gen(function* () {
    const board = yield* readBoard;
    const now = yield* nowIso;
    const nowMs = Date.parse(now);
    const paused = yield* workerPausedNow;
    for (const state of board.stepStates ?? []) {
      if (state.status !== "running" || state.humanInLoop) continue;
      // A step on a worker out of reach is not timed: nothing it
      // does can be seen, and silence from it is not evidence of anything.
      const workerId = slotKeyFor(board, state).workerId;
      if (paused(workerId)) continue;
      // Ahead of the `timeoutMs` gate: a background wait runs on its own fixed
      // schedule, and with turn-end recovery suppressed for it, a
      // step with no timeout would otherwise never be checked on at all.
      if (yield* sweepBackgroundWait({ board, state, now, nowMs })) continue;
      if (state.timeoutMs <= 0) continue;
      // The clock runs from the latest life sign: nudge or start, todo advance, thread output, and
      // (only once overdue) a fresh commit. Output shields only for `outputSignalShieldsStep`, so a
      // thrashing agent still climbs the ladder; `resolveProgressedSinceLastNudge` ignores it.
      // Todo advances and commits have no ceiling.
      const heldAt =
        state.threadId === null ? undefined : permissionHeldAt.get(String(state.threadId));
      if (state.threadId !== null && heldAt !== undefined) {
        if (yield* threadAwaitingHuman(state, state.threadId)) {
          permissionHeldAt.set(String(state.threadId), now);
        } else if (nowMs - Date.parse(heldAt) > state.timeoutMs) {
          permissionHeldAt.delete(String(state.threadId));
        }
      }
      const todo = yield* threadTodoState(state.threadId);
      const lastSignalAt = outputSignalShieldsStep({
        nowMs,
        startedAt: state.startedAt,
        timeoutMs: state.timeoutMs,
      })
        ? yield* threadLastSignalAt(state.threadId)
        : null;
      const referenceMs = Math.max(
        ...[
          state.lastNudgeAt ?? state.startedAt,
          todo?.advancedAt ?? null,
          lastSignalAt,
          state.threadId === null ? null : (permissionHeldAt.get(String(state.threadId)) ?? null),
        ]
          .filter((value): value is string => value != null)
          .map((value) => Date.parse(value))
          .filter((value) => Number.isFinite(value)),
      );
      // Its worker's time out of reach since that life sign is not counted:
      // the reference shifts by the offline interval, not resets.
      const offlineMs = Number.isFinite(referenceMs)
        ? boardOfflineCreditMs(offlineIntervals.get(workerId) ?? [], referenceMs, nowMs)
        : 0;
      if (!Number.isFinite(referenceMs) || nowMs - referenceMs - offlineMs <= state.timeoutMs) {
        continue;
      }
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined || card.archivedAt !== null) continue;
      const worktreePath = card.worktree?.path ?? null;
      const baseRefName = card.worktree?.baseRefName ?? null;
      if (state.mode === "build" && worktreePath !== null && baseRefName !== null) {
        const committedAt = yield* latestBranchCommitIso(card, worktreePath, baseRefName);
        const committedMs = committedAt === null ? Number.NaN : Date.parse(committedAt);
        if (Number.isFinite(committedMs) && nowMs - committedMs <= state.timeoutMs) continue;
      }
      // A requested turn the provider has not started is invisible to every life sign; nudging
      // would land behind a human's message. A delay, not a shield: bounded by
      // `lastNudgeAt ?? startedAt`.
      // Checked last, so only overdue steps pay.
      if (yield* supersededByPendingTurn(state)) continue;
      // A thread on a permission prompt or a secret request is waiting on a human and emits
      // nothing; nudging it would replace the violet wait with a stall. Read last, so only overdue
      // steps pay.
      if (state.threadId !== null && (yield* threadAwaitingHuman(state, state.threadId))) {
        permissionHeldAt.set(String(state.threadId), now);
        continue;
      }
      yield* recoverStep({ card, state });
    }
    // A stamp is only ever read for a running step's thread; drop the rest so
    // the map stays bounded and a finished step's stamp cannot shield the next.
    const runningThreadIds = new Set(
      (board.stepStates ?? [])
        .filter((state) => state.status === "running" && state.threadId !== null)
        .map((state) => String(state.threadId)),
    );
    for (const id of permissionHeldAt.keys()) {
      if (!runningThreadIds.has(id)) permissionHeldAt.delete(id);
    }
    for (const id of backgroundWaits.keys()) {
      if (!runningThreadIds.has(id)) backgroundWaits.delete(id);
    }
    // Offline intervals are read only from a running step's last nudge or start, so a worker
    // without running steps drops its history and a flapping worker's list stays bounded.
    const earliestReference = new Map<BoardWorkerId, number>();
    for (const state of board.stepStates ?? []) {
      if (state.status !== "running") continue;
      const workerId = slotKeyFor(board, state).workerId;
      const at = Date.parse(state.lastNudgeAt ?? state.startedAt ?? "");
      earliestReference.set(
        workerId,
        Math.min(
          earliestReference.get(workerId) ?? Number.POSITIVE_INFINITY,
          Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY,
        ),
      );
    }
    for (const [workerId, intervals] of offlineIntervals) {
      const earliest = earliestReference.get(workerId);
      const kept =
        earliest === undefined ? [] : intervals.filter((interval) => interval.to > earliest);
      if (kept.length === 0) offlineIntervals.delete(workerId);
      else if (kept.length !== intervals.length) offlineIntervals.set(workerId, kept);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: timeout sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const processInput = (input: SupervisorInput) => {
    switch (input.source) {
      case "domain":
        return processDomainEvent(input.event);
      case "thread":
        return gateThreadSignal(input.signal);
      case "reconcile":
        return reconcile;
      case "ci":
        return handleCiPassFinished(input.finished);
      case "workers":
        // A worker back online is reconciled before anything is
        // scheduled onto it.
        return syncWorkerReach.pipe(
          Effect.andThen(requeueResolvedPlacementStalls()),
          Effect.andThen(schedule()),
        );
      case "timeout-sweep":
        // These sweeps ride the 30s tick: each is a board read plus an in-memory pass serialised
        // against the handlers, and the tick is the only retry for work nothing else will ask about
        // again (dropped turn ends, a restart, a worker whose reconcile did not finish).
        return syncWorkerReach.pipe(
          Effect.andThen(sweepTimeouts),
          Effect.andThen(releaseFinishedThreads),
          Effect.andThen(sweepSchedules),
          Effect.andThen(sweepArmedCards),
          Effect.andThen(sweepRetries),
          Effect.andThen(sweepAutoMergeHolds),
          // Forge-check CI steps poll on the same cadence.
          Effect.andThen(sweepCiForgeSteps),
          // A pass with nothing behind it is held on the second tick.
          Effect.andThen(sweepOrphanedCiPasses),
          Effect.andThen(sweepAutoArchives),
        );
    }
  };

  const processInputSafely = (input: SupervisorInput) =>
    processInput(input).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("board supervisor failed to process input", {
            source: input.source,
            eventType:
              input.source === "domain"
                ? input.event.type
                : input.source === "thread"
                  ? input.signal.type
                  : input.source,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: SupervisorReactorShape["start"] = Effect.fn("board-supervisor-start")(function* () {
    // forkParked holds these subscriptions until activation, so reconcile cannot rely on them and
    // ends with a state-derived kickoff. Forked first so live events queue behind reconcile.
    yield* forkParked(
      Stream.runForEach(boardEngine.liveBoardEvents, (event) => {
        // A worktree provisioned or cleaned up triggers a cleanup
        // pass. Straight to the single-flight sweep, not the worker: the pass
        // never touches step state, and it coalesces a burst into one run.
        if (
          event.type === "board.card-worktree-ready" ||
          event.type === "board.card-worktree-reclaimed"
        ) {
          return requestWorktreeSweep();
        }
        if (
          event.type !== "board.card-moved" &&
          // A card changed project. Human-only and rare, and the whole
          // point is that the agent working the card in the OLD repository is
          // stopped now rather than at the next step boundary.
          event.type !== "board.card-project-changed" &&
          event.type !== "board.card-created" &&
          event.type !== "board.card-stage-thread-requested" &&
          event.type !== "board.card-updated" &&
          event.type !== "board.card-step-completed" &&
          // A human's "start it anyway". Rare, and the whole point is
          // that it takes effect on the click rather than at the next step
          // boundary, so it has to cross this filter.
          event.type !== "board.card-step-force-start-requested" &&
          // A step going back to the build queue. Emitted by every
          // recovery too, which is a handful of events an hour at most — far
          // below the volume that made thread activity need filtering at the
          // gateway (`ThreadGatewayV1.observe`).
          event.type !== "board.card-step-recovered" &&
          // A step parked or settled may end a pending auto-plan
          // request. Step boundaries, so a handful an hour.
          event.type !== "board.card-step-awaiting-input" &&
          event.type !== "board.card-step-paused" &&
          event.type !== "board.card-step-settled" &&
          event.type !== "board.card-archived" &&
          event.type !== "board.card-deleted" &&
          event.type !== "board.plans-approved" &&
          // A re-pin or a finished move can start a held card.
          event.type !== "board.card-worker-pinned" &&
          event.type !== "board.card-worker-move-recorded" &&
          // A worker removed stalls what ran there; a re-add can
          // resume it.
          event.type !== "board.worker-removed" &&
          event.type !== "board.card-worker-removal" &&
          // A project's CI switched off moves its cards on from CI.
          // Settings edits, so rare.
          event.type !== "board.project-stage-config-set" &&
          // A human turned a running plan review off, or turned one
          // on after the plan was posted; Changed its rounds.
          event.type !== "board.plan-review-stopped" &&
          event.type !== "board.plan-review-rounds-changed" &&
          !(event.type === "board.plan-review-started" && event.payload.turnedOnLate === true)
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
    // Thread signals from the gateway. A session coming up matters only for a
    // thread orphaned by a rejected admit — the durable delivery point for its
    // turn interrupt — and the todo signals feed the todo cache, not this.
    yield* forkParked(
      Stream.runForEach(threads.observe, (signal) => {
        if (signal.type === "session-started" && !orphanedThreads.has(String(signal.threadId))) {
          return Effect.void;
        }
        if (signal.type === "todos-changed" || signal.type === "thread-deleted") {
          return Effect.void;
        }
        return worker.enqueue({ source: "thread", signal });
      }),
    );
    // Worker changes — status, providers, checkouts, setups — can
    // start a card held for its worker. Absent on a local-only harness.
    if (Option.isSome(placement)) {
      yield* forkParked(
        Stream.runForEach(placement.value.changes, (summary) =>
          Effect.gen(function* () {
            const at = Date.parse(yield* nowIso);
            for (const view of summary.workers) {
              if (view.status.state !== "online" && !droppedWorkers.has(view.id)) {
                droppedWorkers.set(view.id, at);
              }
            }
            yield* worker.enqueue({ source: "workers" });
          }),
        ),
      );
    }
    // The server restarts mid-step: reconcile persisted step state, serialised
    // ahead of the live events now flowing into the same worker queue.
    yield* worker.enqueue({ source: "reconcile" });
    // Periodic timeout sweep: rides the worker so it never races the
    // event handlers. 30s granularity is plenty against minutes-scale timeouts.
    yield* forkParked(
      Effect.forever(
        Effect.sleep("30 seconds").pipe(
          Effect.flatMap(() => worker.enqueue({ source: "timeout-sweep" })),
        ),
      ),
    );
  });

  return {
    start,
    reconcile,
    // Forge-check CI steps poll on the sweep too.
    sweep: sweepTimeouts.pipe(
      Effect.andThen(sweepCiForgeSteps),
      Effect.andThen(sweepOrphanedCiPasses),
    ),
    fireSchedules: sweepSchedules,
    fireAutoArchives: sweepAutoArchives,
    startArmed: sweepArmedCards,
    fireRetries: sweepRetries,
    fireAutoMerges: sweepAutoMergeHolds,
    releaseThreads: releaseFinishedThreads,
    drain: worker.drain.pipe(
      Effect.andThen(cardCleanupWorker.drain),
      Effect.andThen(cardRetireWorker.drain),
    ),
    // CI passes run on their own fibers and report through the
    // worker; a pass's end can start the next one, so this loops until none
    // is running. Never used by `drain`: a long pass would block it.
    drainCi: Effect.suspend(function drainCi(): Effect.Effect<void> {
      return ciPasses.awaitIdle.pipe(
        Effect.andThen(worker.drain),
        Effect.andThen(Effect.suspend(() => (ciPasses.busy() ? drainCi() : Effect.void))),
      );
    }),
    retryCi: (cardId, action = "retry") =>
      action === "stop"
        ? answerCiAction("stop", cardId, stopCi(cardId))
        : answerCiAction("retry", cardId, retryCi(cardId)),
    ciSendBack: (cardId) =>
      ciSendBack(cardId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: CI send-back failed", {
            cardId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ outcome: "failed" } as const)),
        ),
      ),
    skipCi: (cardId, stamp) =>
      skipCi(cardId, stamp).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: skip CI failed", {
            cardId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ outcome: "failed" } as const)),
        ),
      ),
    sweepWorktrees: requestWorktreeSweep,
    // The main worker first: boot reconcile and event handlers are what
    // request passes, so a pass may not be queued until they have run.
    drainWorktreeSweep: worker.drain.pipe(
      Effect.andThen(cardCleanupWorker.drain),
      Effect.andThen(cardRetireWorker.drain),
      Effect.andThen(worktreeSweepWorker.drain),
    ),
    checkWorktree: (cardId) =>
      checkCardWorktree(cardId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: worktree check failed", {
            cardId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ outcome: "failed" } as const)),
        ),
      ),
    forceRemoveWorktree: (cardId) =>
      forceRemoveCardWorktree(cardId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: forced worktree removal failed", {
            cardId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ outcome: "failed" } as const)),
        ),
      ),
    // Outside the serialised worker: request-scoped, and they touch no step state. Total: an RPC
    // or agent tool call owes its caller an answer, not an unhandled failure. A card being created
    // has no placement, so its project's local checkout answers.
    resolvePullRequestLink: (projectId, target) =>
      workspaces.localProject(projectId).pipe(
        Effect.flatMap((workspace) => resolvePullRequestLink(workspace, target)),
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: pull request link lookup failed", {
            projectId,
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.as({
              outcome: "refused",
              detail: "The pull request could not be looked up. See the server log for details.",
            } as const),
          ),
        ),
      ),
    linkPullRequest: (cardId, target, options) =>
      linkPullRequest(cardId, target, options).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: pull request link failed", {
            cardId,
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.as({
              outcome: "refused",
              detail: "The pull request could not be linked. See the server log for details.",
            } as const),
          ),
        ),
      ),
    refreshPullRequest: (cardId, options) =>
      Effect.flatMap(readCard(cardId), (card) =>
        card === null
          ? Effect.succeed({ outcome: "unknown-card" } as const)
          : refreshCardPullRequest(card, undefined, options),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: pull request refresh failed", {
            cardId,
            cause: Cause.pretty(cause),
          }).pipe(
            // T3o: TOTAL, like the merge beside it — the RPC owes the
            // user an answer, and "the lookup broke" is one they can act on.
            Effect.as({
              outcome: "lookup-failed",
              detail: "The pull request could not be looked up. See the server log for details.",
            } as const),
          ),
        ),
      ),
    mergePullRequest: (cardId) =>
      mergeCardPullRequestByHand(cardId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: merge failed", {
            cardId,
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.as({
              outcome: "refused",
              detail: "The merge could not be attempted. See the server log for details.",
            } as const),
          ),
        ),
      ),
    requestReviewRound: (cardId, carry) =>
      requestReviewRound(cardId, carry).pipe(
        Effect.catchCause((cause) =>
          // Total for the same reason the other two are: an RPC handler owes
          // the user a response, and a read-model hiccup must read as "the
          // round did not start" rather than as an unhandled failure on a
          // button click.
          Effect.logWarning("board supervisor: review round request failed", {
            cardId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ outcome: "failed" } as const)),
        ),
      ),
    submitForMerge: (cardId) =>
      submitCardForMerge(cardId).pipe(
        Effect.catchCause((cause) =>
          // Total for the same reason merging is: an RPC handler owes the user
          // a response, and a read-model hiccup must read as "it did not
          // start" rather than as an unhandled failure on a button click.
          Effect.logWarning("board supervisor: submit for merge failed", {
            cardId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ outcome: "failed" } as const)),
        ),
      ),
  } satisfies SupervisorReactorShape;
});

export const SupervisorReactorLive = Layer.effect(SupervisorReactor, make);
