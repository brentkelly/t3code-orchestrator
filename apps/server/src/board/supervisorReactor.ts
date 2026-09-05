/**
 * T3o supervisor reactor (t3o-10) — the core of T3o. The board stops being a
 * record of work and starts causing it.
 *
 * A `DrainableWorker`-backed reactor following `CheckpointReactor` /
 * `ProviderCommandReactor`. It consumes board and thread-lifecycle events and
 * dispatches commands, driving each card's step through Select → Admit → Spawn
 * → Run → Settle → Release (D4). All *decisions* are pure functions in
 * `supervisor.ts`; this module is the effectful shell: read state, spawn
 * threads, provision worktrees, dispatch commands.
 *
 * Death is routine, not exceptional (the module notes on t3o-09/t3o-10): a step
 * thread that settles without calling `board_complete_step` has died or stalled
 * (`ProviderSessionReaper` makes "the thread is gone" a normal path), so it is
 * handled as control flow. Recovery escalates and never loops (D13). Boot
 * reconciliation re-reads every non-terminal step on startup, because the
 * server will restart mid-step.
 */
import {
  boardCardChildren,
  boardBuildHumanInLoopDefault,
  boardCardPlans,
  boardSubBoardFloorStage,
  unmetBoardCardDependencies,
  boardCardPullRequestsEqual,
  boardCardStepCompletions,
  boardCardUnfinishedChildren,
  boardCardStepState,
  boardRunLabel,
  boardNextStageId,
  boardNonTerminalStepStates,
  boardSeedStageRole,
  boardStageById,
  boardStageEntryInvocationCount,
  boardStepErrorSummary,
  boardStageIndex,
  isBoardStageAtOrAfterBuild,
  boardStageWithRole,
  CommandId,
  BOARD_ENVELOPE_QUESTION_MECHANISM,
  boardTextEndsWithQuestion,
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EMPTY_BOARD_STATE,
  effectiveBoardStageRole,
  isBoardCardPullRequestTerminal,
  isBoardMergeStageExecution,
  isBoardTerminalStepStatus,
  MessageId,
  resolveBoardStageExecution,
  resolveBoardDefaultModelSelection,
  resolveBoardStageModelSelection,
  resolveBoardCardStageModelOverride,
  boardModelSelectionOfOverride,
  type BoardCardStageModelOverride,
  ThreadId,
  type ChatAttachment,
  type BoardCard,
  type BoardCardId,
  type BoardCardPullRequest,
  type BoardCardStepState,
  type BoardSettings,
  type BoardStageExecution,
  type BoardState,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { BoardStepSlots, type BoardConcurrencyLimit } from "./BoardStepSlots.ts";
import { boardSnapshotQueryMethodsOf } from "./projection.ts";
import { BoardPullRequestGateway } from "./BoardPullRequestGateway.ts";
import { pullMergedBaseBranch } from "./baseBranchSync.ts";
import {
  removeBoardCardAttachmentsDir,
  spawnPushesBriefImages,
  stageBoardCardImagesAsPending,
} from "./attachments.ts";
import { deleteCardBranch } from "./branchCleanup.ts";
import {
  assertSingleBoardWorktreeWriter,
  boardCardWorktreeBranchName,
  provisionBoardCardWorktree,
  reclaimBoardCardWorktree,
  resolveBoardCardBaseRef,
  runBoardCardWorktreeSetup,
} from "./worktree.ts";
import {
  composeStepPrompt,
  orderBoardQueue,
  reconcileStepDecision,
  recoveryDecision,
  resolveBoardConcurrencyLimit,
  type BoardQueueCandidate,
} from "./supervisor.ts";
import { stageExecutorForRole } from "./stageExecutor.ts";

/** What a Merge click did, for the RPC to turn into a toast. */
export type BoardMergeAttemptResult =
  | { readonly outcome: "merged"; readonly number: number }
  | { readonly outcome: "conflict"; readonly detail: string }
  | { readonly outcome: "refused"; readonly detail: string }
  | { readonly outcome: "not-open"; readonly state: "closed" | "merged" }
  | { readonly outcome: "no-pull-request" }
  | { readonly outcome: "no-workspace" }
  /** The card is not in the merge-role stage. The button only renders there,
      so this is a client that called the RPC without one. */
  | { readonly outcome: "wrong-stage" }
  /** The card's base moved since its last review round started (t3o-24, D2):
      the card went back to review to rebase and run one gate round instead of
      merging an unreviewed combined diff. */
  | { readonly outcome: "stale-base" }
  | { readonly outcome: "unknown-card" };

export interface SupervisorReactorShape {
  /** Reconcile persisted step state, then subscribe to board and thread
      events. Must run in a scope so worker fibers finalize on shutdown. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Reconcile every non-terminal step against the live world (boot / test). */
  readonly reconcile: Effect.Effect<void>;
  /** One timeout-sweep pass over running unattended steps (t3o-17). In
      production the worker runs it on a timer; exposed so tests can drive the
      liveness clock deterministically. */
  readonly sweep: Effect.Effect<void>;
  /** Resolves when the internal queue is empty and idle (test hook). */
  readonly drain: Effect.Effect<void>;
  /** Re-resolve one card's pull request from the forge and record any change.
      The client-driven refresh triggers (card detail opened, View PR clicked)
      call this through the board RPC. */
  readonly refreshPullRequest: (cardId: BoardCardId) => Effect.Effect<void>;
  /** Merge a card's pull request and advance it (the Merge button). */
  readonly mergePullRequest: (cardId: BoardCardId) => Effect.Effect<BoardMergeAttemptResult>;
}

export class SupervisorReactor extends Context.Service<SupervisorReactor, SupervisorReactorShape>()(
  "t3/board/supervisorReactor",
) {}

type SupervisorInput =
  | { readonly source: "domain"; readonly event: OrchestrationEvent }
  | { readonly source: "runtime"; readonly event: ProviderRuntimeEvent }
  // Boot reconcile, run THROUGH the worker so it is serialised before the live
  // events it causes (the subscriptions attach first — see `start`).
  | { readonly source: "reconcile" }
  // Periodic timeout sweep (t3o-17): the edge-triggered turn.completed path
  // cannot see a turn that HANGS, so a timer funnels overdue running steps
  // into the same recovery ladder.
  | { readonly source: "timeout-sweep" };

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** The `detail` string off a `provider.*.failed` activity payload, which the
    activity schema types as `unknown` (t3o-30, D2). Anything else reads as an
    empty detail rather than throwing — a malformed payload must not stop the
    board from landing the step. */
function providerFailureDetail(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const detail = (payload as { readonly detail?: unknown }).detail;
  return typeof detail === "string" ? detail : "";
}

/** Whether a step's thread is still doing live work — an active turn or a
    pending question a human can still answer. A present-but-idle thread (turn
    ended, session reaped) is NOT alive for supervision purposes: its step
    settled without completing, which is the death path. */
function threadIsAlive(shell: OrchestrationThreadShell): boolean {
  return (
    shell.hasPendingUserInput || (shell.session !== null && shell.session.activeTurnId !== null)
  );
}

/**
 * The model/access override in force for a card's CURRENT stage (t3o-29),
 * resolved through the parent for a sub-board child, or null when the
 * workspace config governs.
 *
 * The reactor resolves it because it is the only layer that can see both the
 * card and the board it sits on; what the override then GOVERNS is the
 * executor's call, so this is handed down on the config rather than folded into
 * `model` (see `BoardStageExecutorConfig.cardOverride`). That is what keeps the
 * reactor from having to know that a review stage treats it differently.
 *
 * Free: the parent is already in the aggregate every caller holds, so this is
 * an in-memory find, not a read. Sub-boards are one level deep, so there is no
 * chain to walk.
 */
function cardStageModelOverride(
  board: BoardState,
  card: BoardCard,
): BoardCardStageModelOverride | null {
  return resolveBoardCardStageModelOverride({
    card,
    parent:
      card.parentCardId === null
        ? null
        : (board.cards.find((candidate) => candidate.id === card.parentCardId) ?? null),
    stageId: card.stage,
  });
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const serverSettings = yield* ServerSettingsService;
  const slots = yield* BoardStepSlots;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const pullRequests = yield* BoardPullRequestGateway;
  const setupRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:board-${tag}:${uuid}`)));
  const freshThreadId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => ThreadId.make(`thread-${uuid}`)),
  );
  const freshMessageId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => MessageId.make(`msg-${uuid}`)),
  );

  const readBoard = snapshotQuery
    .getCommandReadModel()
    .pipe(
      Effect.map((model: OrchestrationReadModel): BoardState => model.board ?? EMPTY_BOARD_STATE),
    );

  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor dispatch failed", {
          commandType: (command as { readonly type?: string }).type,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** `dispatch`, but a REFUSAL is an expected answer rather than a fault.
   *
   *  A handful of the supervisor's writes are speculative by design: the
   *  reactor cannot know whether the command still applies by the time the
   *  decider sees it, so it asks and accepts "no". The graduation sweep fires a
   *  settle at every thread the card holds without checking which are still
   *  running; the review loop settles the phase it just left; a refresh records
   *  a pull request another trigger may have recorded a moment earlier. In each
   *  case the decider's refusal IS the guard the caller is relying on, and the
   *  plain helper logging it at WARN turns the normal path into a stream of
   *  warnings about nothing.
   *
   *  Only an invariant refusal is demoted — that is the decider saying "this
   *  command does not apply", which is what these callers asked about. Anything
   *  else (a storage failure, a defect) is still a warning, because none of
   *  these call sites is speculating about THAT. */
  const dispatchOptional = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.catchCause((cause) => {
        const refusal = Cause.findErrorOption(cause).pipe(
          Option.filter((error) => error._tag === "OrchestrationCommandInvariantError"),
          Option.getOrUndefined,
        );
        return refusal === undefined
          ? Effect.logWarning("board supervisor dispatch failed", {
              commandType: (command as { readonly type?: string }).type,
              cause: Cause.pretty(cause),
            })
          : Effect.logDebug("board supervisor dispatch refused", {
              commandType: (command as { readonly type?: string }).type,
              detail: refusal.detail,
            });
      }),
    );

  /** `dispatch`, but the caller learns whether the command LANDED. The plain
      helper above swallows a rejection, which is right for best-effort writes
      and wrong for the two commands a spawn is built from: a thread that was
      never created must not be recorded as the step's running thread. */
  const dispatchLanded = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        // An interrupt-only cause is a teardown, not a rejection: the command's
        // fate is unknown, so reporting "did not land" would have the caller
        // compensate — delete a thread that may exist, stall a step on a server
        // that is merely shutting down. Re-interrupt instead, mirroring the WS
        // bootstrap path's own guard.
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("board supervisor dispatch failed", {
              commandType: (command as { readonly type?: string }).type,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
      ),
    );

  const boardSettings = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.board ?? DEFAULT_BOARD_SETTINGS),
    Effect.catchCause(() => Effect.succeed(DEFAULT_BOARD_SETTINGS)),
  );

  /** What a stage with no model of its own runs on: the board's own default
      model when the user has set one (t3o-30, D1), and only otherwise the app's
      text-generation selection.
   *
   * The board still has no compiled-in pair — a hardcoded one is a pair the user
   * may not have enabled, which is exactly how a conflict-resolution step came
   * to spawn onto a codex CLI that was not installed. `Settings → Board` now
   * names the fallback, so an unset stage runs on something the user chose and
   * can see. The per-stage picker is still the recommended answer; this is what
   * a never-configured stage lands on. */
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

  // Progress signal (t3o-17 D2, re-pointed by t3o-18 D16). The reactor — not the
  // pure `recoveryDecision` — resolves whether a step made progress since the
  // last nudge, from two OR'd sources: the step thread's TODO LIST advancing (a
  // `turn.plan.updated` whose done count rose or whose in-progress item changed,
  // recorded as `advancedAt` on `board_thread_todos`), or a new commit on the
  // card's branch (read from git). A step with a live progress signal has its
  // consecutive `stallCount` reset, so a long productive job never escalates.
  //
  // This replaces t3o-17's `board_report_progress` watermark, deleted by D13 —
  // and it is a better signal on t3o-17's own terms. It wanted "the agent
  // asserting it did some work" and rejected token output and tool-call counts as
  // noise: a ticked todo names the specific item finished, where a prose note
  // asserted only that the model still had tokens to spend. It is also durable
  // rather than in-memory, so a restart no longer costs an un-reset stall.
  const boardQueries = boardSnapshotQueryMethodsOf(snapshotQuery);
  // Threads spawned for a step whose admit was then rejected (see
  // admitBuildCandidate): their turn must be stopped, but an interrupt fired
  // milliseconds after spawn races provider session startup and no-ops. The
  // set makes it durable — the runtime stream's `session.started` for an
  // orphan re-dispatches the interrupt once a session exists to interrupt.
  // Entries clear on interrupt or on the orphan's own turn.completed, so the
  // set stays bounded.
  const orphanedThreads = new Set<string>();
  const interruptOrphan = Effect.fn("board-supervisor-interruptOrphan")(function* (
    threadId: ThreadId,
  ) {
    yield* dispatch({
      type: "thread.turn.interrupt",
      commandId: yield* commandId("interrupt-orphan"),
      threadId,
      createdAt: yield* nowIso,
    });
  });

  const isAfter = (candidate: string, floor: string): boolean => {
    const a = Date.parse(candidate);
    const b = Date.parse(floor);
    return Number.isFinite(a) && Number.isFinite(b) && a > b;
  };

  /** The latest commit time (strict ISO 8601) on the worktree's HEAD, or null on
      any error / empty history — a new commit since the last nudge is progress
      (D2). Best-effort: git failure never blocks recovery. */
  const latestCommitIso = (cwd: string) =>
    git
      .execute({
        operation: "boardSupervisor.progressCommit",
        cwd,
        args: ["log", "-1", "--format=%cI"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result): string | null => {
          const iso = result.stdout.trim();
          return iso.length > 0 ? iso : null;
        }),
        Effect.catchCause(() => Effect.succeed(null as string | null)),
      );

  /** The step thread's cached todo row, or null (t3o-18, D16). Best-effort: a
      snapshot query built without the board factory (upstream test mocks) or a
      read failure both answer "no list", which reads as "no progress" — the
      conservative direction. */
  const threadTodoState = Effect.fn("board-supervisor-threadTodoState")(function* (
    threadId: ThreadId | null,
  ) {
    if (threadId === null || boardQueries === null) return null;
    return yield* boardQueries
      .boardThreadTodo(threadId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
  });

  /** Resolve `progressedSinceLastNudge` for a step (t3o-17 D2 / t3o-18 D16): the
      step thread's todo list ADVANCED, or a new commit landed on the card's
      branch, both since the recorded `lastNudgeAt`. The first stall has no nudge
      window yet, so it is never counted as progress. Kept out of
      `recoveryDecision`, which stays pure — no git, no SQL. */
  const resolveProgressedSinceLastNudge = Effect.fn(
    "board-supervisor-resolveProgressedSinceLastNudge",
  )(function* (state: BoardCardStepState, card: BoardCard) {
    if (state.lastNudgeAt === null) return false;
    const todo = yield* threadTodoState(state.threadId);
    if (todo?.advancedAt != null && isAfter(todo.advancedAt, state.lastNudgeAt)) return true;
    // A commit counts too (D2); only a build-mode step has a worktree to inspect.
    const worktreePath = card.worktree?.path ?? null;
    if (state.mode !== "build" || worktreePath === null) return false;
    const committedAt = yield* latestCommitIso(worktreePath);
    return committedAt !== null && isAfter(committedAt, state.lastNudgeAt);
  });

  /** Whether the step's agent stopped with something for a human to answer
      (t3o-34, D2).
   *
      The reactor does the SQL and `boardTextEndsWithQuestion` does the reading,
      the same split `progressedSinceLastNudge` uses to keep `recoveryDecision`
      pure. A read failure — or a thread with no assistant message at all —
      answers `false`, which routes a human-in-the-loop stop to the louder
      "Needs a human" and leaves the unattended nudge exactly as it was.

      Only a message the agent wrote SINCE the work last resumed counts. A turn
      that ends having said nothing — interrupted, errored, tool-only — leaves an
      older message newest, and taking it at face value would re-park the card on
      a question the human has already answered, and prepend "you asked a
      question" to every nudge from then on. The reference point is
      `lastNudgeAt`, which every resume and every nudge moves to now, falling
      back to when the step started. */
  const endedWithQuestion = Effect.fn("board-supervisor-endedWithQuestion")(function* (
    state: Pick<BoardCardStepState, "threadId" | "lastNudgeAt" | "startedAt">,
  ) {
    const threadId = state.threadId;
    if (threadId === null || boardQueries === null) return false;
    const message = yield* boardQueries
      .boardLatestAssistantMessage(threadId)
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

  const projectCwd = (board: OrchestrationReadModel, card: BoardCard): string | null => {
    const project = board.projects.find((entry) => entry.id === card.projectId);
    return project?.workspaceRoot ?? null;
  };

  /** The build stage's per-card human-in-the-loop default (D6): a card with a
      plan uses `humanInLoopWithPlan`, one without uses `humanInLoopWithoutPlan`
      — so writing a plan moves the default with it. A sub-board child counts
      as planned (its approved plan became its brief, so it owns no plan row):
      `boardBuildHumanInLoopDefault` is the one rule, shared with the card
      detail so the toggle's hint and the run agree. */
  const buildHumanInLoopDefault = (
    board: BoardState,
    exec: BoardStageExecution,
    card: BoardCard,
  ): boolean => boardBuildHumanInLoopDefault(exec, card, boardCardPlans(board, card.id).length > 0);

  /** The resolved human-in-the-loop stance for a fresh (first-entry) run of a
      stage (D5/D6). The build role reads the per-card toggle over its two
      defaults; every other stage uses its own `humanInLoop` setting. A
      re-entry (D7) forces human-in-the-loop regardless and is handled by the
      caller. */
  const resolveHumanInLoop = (
    board: BoardState,
    settings: BoardSettings,
    card: BoardCard,
    exec: BoardStageExecution,
  ): boolean => {
    const stage = boardStageById(board, card.stage);
    if (stage?.role === "build") {
      return card.humanInLoop ?? buildHumanInLoopDefault(board, exec, card);
    }
    return exec.humanInLoop;
  };

  /** Whether the card already has a live (non-tombstoned) linked thread for a
      stage's step (D7): auto-kickoff is suppressed so a manually adopted thread
      is never trampled. The step's role is the stage id. */
  const hasLiveStageThread = (card: BoardCard, stageId: string): boolean =>
    card.threadLinks.some((link) => link.role === stageId && link.tombstonedAt === null);

  // Send a follow-up turn (recovery nudge or escalation question) to an
  // existing step thread.
  const sendTurn = Effect.fn("board-supervisor-sendTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    /** The frozen run-row authority (t3o-21). A nudge/resume on an EXISTING
        thread inherits that thread's posture, so this is inert today — but
        passing the step's real value rather than a hardcoded `full-access`
        keeps the "board never forces full-access" invariant true at every
        dispatch and removes a footgun if the turn command ever stops ignoring
        it for existing threads. */
    readonly runtimeMode: BoardCardStepState["runtimeMode"];
  }) {
    const createdAt = yield* nowIso;
    yield* dispatch({
      type: "thread.turn.start",
      commandId: yield* commandId("recover-turn"),
      threadId: input.threadId,
      message: {
        messageId: yield* freshMessageId,
        role: "user",
        text: input.text,
        attachments: [],
      },
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      createdAt,
    });
  });

  /** Report a worktree failure onto the card, with the reason a human can act
      on. Every arm of `ensureWorktree` reports through here so a build that
      cannot start is visible on the card (activity rail) rather than only in
      the server log — including the pre-flight arms that fail before a worktree
      record exists, which the decider accepts for exactly that reason. */
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

  // Provision the card's branch + worktree (t3o-09 effects), reporting the
  // outcome through the worktree lifecycle commands. Returns the worktree path
  // on success, or null on failure — every failure arm reports through
  // `failWorktree` first, so the card carries a visible, retryable reason (a
  // `failed` worktree once one exists, an activity row when provisioning never
  // got that far) rather than being a silent wedge.
  // The project checkout's DEFAULT branch — not whatever it happens to have
  // checked out. origin/HEAD names it when a remote exists; a purely local
  // repo falls back to the current branch, with a detached HEAD (`rev-parse`
  // answers the literal string 'HEAD') treated as a resolution failure rather
  // than a branch. Shared by worktree provisioning and integration-branch
  // creation; `defaultBranch === ""` is the failure signal, `detachedHead`
  // disambiguates the message.
  const resolveDefaultBranch = Effect.fn("board-supervisor-resolveDefaultBranch")(function* (
    cwd: string,
  ) {
    const gitRef = (args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "boardCardWorktree.defaultBranch",
          cwd,
          args: [...args],
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
          Effect.catchCause(() => Effect.succeed("")),
        );
    const originHead = yield* gitRef([
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const currentBranch = yield* gitRef(["rev-parse", "--abbrev-ref", "HEAD"]);
    const defaultBranch =
      originHead.startsWith("origin/") && originHead.length > "origin/".length
        ? originHead.slice("origin/".length)
        : currentBranch === "HEAD"
          ? ""
          : currentBranch;
    return { defaultBranch, detachedHead: currentBranch === "HEAD" };
  });

  const ensureWorktree = Effect.fn("board-supervisor-ensureWorktree")(function* (card: BoardCard) {
    if (card.worktree !== null && card.worktree.status === "ready" && card.worktree.path !== null) {
      return card.worktree.path;
    }
    const model = yield* snapshotQuery.getCommandReadModel();
    const cwd = projectCwd(model, card);
    // Every pre-flight failure below reports through `fail-worktree` rather
    // than a server-side log: the card is the only place the human is looking,
    // and a build that cannot start must say so THERE (the activity rail's
    // "could not prepare the worktree: …" row) instead of leaving the card
    // parked in its stage with nothing running and no explanation.
    if (cwd === null) {
      yield* failWorktree(card, "The card's project has no workspace folder on this server.");
      return null;
    }
    const branch = boardCardWorktreeBranchName(card);
    // A sub-board plan card branches off its parent's integration branch
    // (D12); a top-level card off the project default.
    const { defaultBranch, detachedHead } = yield* resolveDefaultBranch(cwd);
    // A child of a LIVE split retries the integration-branch creation HERE,
    // BEFORE resolving its base (t3o-23, D5): approval fires the creation
    // once, but the reactor may have been down or git transiently broken at
    // that moment, and a fire-once side effect with no second chance would
    // strand the split. The trigger is the parent's state, not a null
    // resolution — a second-round parent (reclaimed slice, merged pull
    // request retired into history) resolves to the OLD round's base rather
    // than null, so a null-trigger would silently route every child there. A
    // live split parent is exactly one thing: frozen in the build-role stage
    // with a slice that names no live branch. A DONE parent is not touched —
    // its merged baseRef below is the right base for a straggler child.
    // Each child build attempt is the organic retry; `ensureIntegrationBranch`
    // is idempotent, so a raced pair of children converges on the one branch.
    if (card.parentCardId !== null) {
      const board = yield* readBoard;
      const parent = board.cards.find((candidate) => candidate.id === card.parentCardId);
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
        yield* ensureIntegrationBranch(parent);
      }
    }
    const baseRefName = resolveBoardCardBaseRef({
      card,
      cards: (yield* readBoard).cards,
      defaultBranch,
    });
    if (baseRefName === null || defaultBranch === "") {
      // Say WHICH of the three ways base-ref resolution failed — "could not
      // resolve the base branch" is true but unactionable, and the three have
      // different fixes (commit the parent's work, check out a branch, run
      // `git init` + a first commit).
      yield* failWorktree(
        card,
        baseRefName === null
          ? "The parent card has no branch yet, so there is no base to cut this card's branch from."
          : detachedHead
            ? `The project checkout at ${cwd} is on a detached HEAD, so there is no branch to cut the card's branch from.`
            : `${cwd} is not a git repository, or has no commits yet, so there is no branch to cut the card's branch from.`,
      );
      return null;
    }
    // Observe the provision dispatch: a rejected command (e.g. the worktree is
    // not in a provisionable state) must abort BEFORE the git effect, or the
    // tree lands on disk untracked while `record-worktree` is then rejected too.
    const provisionAccepted = yield* engine
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
    if (!provisionAccepted) return null;
    const provisioned = yield* provisionBoardCardWorktree({
      projectCwd: cwd,
      branch,
      baseRefName,
    }).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, git),
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor: worktree provisioning failed", {
          cardId: card.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none<{ readonly path: string }>())),
      ),
    );
    if (Option.isNone(provisioned)) {
      yield* failWorktree(card, "git worktree add failed; retry the build.");
      return null;
    }
    yield* dispatch({
      type: "board.card.record-worktree",
      commandId: yield* commandId("record-worktree"),
      cardId: card.id,
      path: provisioned.value.path,
      createdAt: yield* nowIso,
    });
    return provisioned.value.path;
  });

  // Create a fresh thread for a step and link it to the card, returning the new
  // thread id. Shared by the initial spawn and by recovery when the step's
  // thread has vanished (reaped/deleted). The card↔thread link is what lets the
  // agent's board_* tools resolve their card (the MCP write path keys on it, D3).
  // The one push (t3o-32, K4): a build-mode or plan-mode spawn carries the
  // brief's images natively, so a "screenshot plus 'fix this'" card is seen on
  // turn one. Staged as fresh pending uploads so upstream's Normalizer claims
  // them into thread scope untouched. Absent config (the test harness) means
  // nothing to stage — the manifest still reaches every thread through
  // `board_get_card_context`.
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

  const spawnStepThread = Effect.fn("board-supervisor-spawnStepThread")(function* (input: {
    readonly card: BoardCard;
    /** The frozen run-row fields a spawn needs (D12). */
    readonly step: {
      readonly stepId: string;
      /** Null on a stage with no steps (t3o-19, D4); the title falls back to
          the frozen stage label. */
      readonly stepLabel: string | null;
      readonly stageLabel: string | null;
      readonly providerInstanceId: BoardCardStepState["providerInstanceId"];
      readonly model: string;
      /** Frozen run-row mode (D5/D12): governs resources (worktree + slot). */
      readonly mode: BoardCardStepState["mode"];
      /** Frozen run-row agent authority (t3o-21): the user-chosen posture, read
          verbatim — the board never derives it from `mode`. */
      readonly runtimeMode: BoardCardStepState["runtimeMode"];
      /** Frozen run-row model options (reasoning/effort, t3o-21). */
      readonly modelOptions: BoardCardStepState["modelOptions"];
    };
    /** Where the thread runs: the card's worktree for a `build`-mode step, the
        project workspace root for a `plan`-mode step (no worktree, D5). */
    readonly worktreePath: string;
    /** The branch to open the thread on — the worktree's branch for `build`,
        null for `plan` (read-only, no branch). */
    readonly branch: string | null;
    /** Whether to run the worktree setup script — build only. */
    readonly runSetup: boolean;
    readonly text: string;
    /** The brief's images on a build/plan spawn (t3o-32, K4); `[]` elsewhere. */
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    const { card, step } = input;
    const threadId = yield* freshThreadId;
    const createdAt = yield* nowIso;
    // The agent authority is the USER's choice, frozen onto the run row at
    // stage entry (t3o-21) and read verbatim here — the board no longer forces
    // `full-access` on build-mode steps (a security defect). If the chosen
    // posture asks for approval on a command, the run surfaces as "Input
    // needed" and continues once a human approves. Tool access stays
    // `interactionMode: "default"` (the MCP write tools are a separate axis).
    const runtimeMode = step.runtimeMode;
    // The thread is created with its OWN command first. `thread.turn.start`
    // carries a `bootstrap.createThread` block, but that block is interpreted
    // by the WebSocket dispatch path (`dispatchBootstrapTurnStart` in ws.ts),
    // NOT by the engine — a server-side dispatch straight into the engine is
    // decided as an ordinary turn start and rejected: "thread does not exist".
    // The board dispatches in-process, so it creates the thread itself.
    const created = yield* dispatchLanded({
      type: "thread.create",
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
      createdAt,
    });
    if (!created) return null;
    const started = yield* dispatchLanded({
      type: "thread.turn.start",
      commandId: yield* commandId("spawn-turn"),
      threadId,
      message: {
        messageId: yield* freshMessageId,
        role: "user",
        text: input.text,
        attachments: input.attachments,
      },
      runtimeMode,
      interactionMode: "default",
      createdAt,
    });
    if (!started) {
      // The thread exists but will never run a turn. Delete it rather than
      // leave an empty thread in the sidebar for a run that never started —
      // the same cleanup the WS bootstrap path performs.
      yield* dispatch({
        type: "thread.delete",
        commandId: yield* commandId("spawn-cleanup"),
        threadId,
      });
      return null;
    }
    yield* dispatch({
      type: "board.card.link-thread",
      commandId: yield* commandId("link-thread"),
      cardId: card.id,
      threadId,
      role: step.stepId,
      createdAt: yield* nowIso,
    });
    // Run the worktree setup script in the build thread's terminal (t3o-09).
    // Build-mode only — a plan-mode step has no worktree. Best-effort.
    if (input.runSetup) {
      yield* runBoardCardWorktreeSetup({
        threadId,
        projectId: card.projectId,
        worktreePath: input.worktreePath,
      }).pipe(
        Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, setupRunner),
        Effect.catchCause(() => Effect.void),
      );
    }
    return threadId;
  });

  /**
   * A spawn that produced no thread (the create or its first turn was
   * rejected). Nothing is running, so the step must NOT be admitted as
   * `running` against a thread that does not exist: that phantom state reads as
   * a live run, so every later kickoff — a drag back in, the card's "+ →
   * restart" — hits the one-step-at-a-time guard and silently does nothing.
   *
   * Land it in `stalled` instead, the same status recovery escalates to: the
   * card shows the loud badge, and an on-demand restart explicitly supersedes a
   * stalled step, so the human has a way back.
   */
  const escalateSpawnFailure = Effect.fn("board-supervisor-escalateSpawnFailure")(
    function* (input: { readonly card: BoardCard; readonly state: BoardCardStepState }) {
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
        createdAt: yield* nowIso,
      });
      // Escalation releases the step's slot exactly as the recovery escalation
      // does (D4), gated on the PERSISTED `slotHeld`: a step that reached this
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
      : snapshotQuery.getThreadShellById(threadId).pipe(Effect.map(Option.isNone));

  /** The prompt for a step's run, composed from the frozen run row (D12). The
      role keys the envelope's deliverable postamble segment; roles are seeded,
      never created, so the card's stage id resolves it without a board read. */
  const stepPromptFor = (card: BoardCard, state: BoardCardStepState): string =>
    composeStepPrompt({
      card,
      stageLabel: state.stageLabel,
      step: {
        stepId: state.stepId,
        stepLabel: state.stepLabel,
        prompt: state.prompt,
        humanInLoop: state.humanInLoop,
      },
      role: boardSeedStageRole(card.stage),
    });

  // Offer one build-mode step to the governor: acquire a slot under the resolved
  // caps and spawn its thread on the card's worktree, or leave it queued (D11).
  // Enforces the one-writer-per-worktree invariant (t3o-09) BEFORE acquiring, so
  // a refused spawn never leaks a slot.
  const admitBuildCandidate = Effect.fn("board-supervisor-admitBuildCandidate")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    readonly worktreePath: string;
    readonly limits: BoardConcurrencyLimit;
  }) {
    const { card, state } = input;
    // One writer at a time per worktree (t3o-09 invariant). The assertion counts
    // the writer we are ABOUT to spawn, so an existing writer plus the new one
    // fails it; on failure we REFUSE before acquiring a slot, so the invariant
    // blocks rather than stranding a slot.
    const board = yield* readBoard;
    // Re-check on the fresh read: external RPC commands are not serialised with
    // the worker, so the card may have been archived since `schedule` snapshot
    // it — admitting would be rejected AFTER the slot was acquired.
    const fresh = board.cards.find((candidate) => candidate.id === card.id);
    if (fresh === undefined || fresh.archivedAt !== null) return;
    const liveWriters = (board.stepStates ?? [])
      .filter(
        (candidate) =>
          candidate.cardId === card.id &&
          !isBoardTerminalStepStatus(candidate.status) &&
          candidate.threadId !== null,
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

    const admitted = yield* slots.acquire(state.providerInstanceId, input.limits);
    if (!admitted) {
      // No slot right now. A fresh (pending) step is recorded queued so the card
      // shows its badge; a queued step stays put and is re-offered next boundary.
      if (state.status === "pending") {
        yield* dispatch({
          type: "board.card.admit-step",
          commandId: yield* commandId("admit-step"),
          cardId: card.id,
          stepId: state.stepId,
          admitted: false,
          threadId: null,
          createdAt: yield* nowIso,
        });
      }
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
      worktreePath: input.worktreePath,
      branch: card.worktree?.branch ?? null,
      runSetup: true,
      text: stepPromptFor(card, state),
    });
    if (threadId === null) {
      // No thread was created, so release the slot this candidate just acquired
      // (the persisted `slotHeld` is still false — admit-step never ran — so
      // `releaseSlot` would decline it) and escalate rather than admit.
      yield* slots.release(state.providerInstanceId);
      yield* escalateSpawnFailure({ card, state });
      return;
    }
    // Observe the admit dispatch (the generic `dispatch` helper swallows
    // rejections): if admit-step does not land, the persisted `slotHeld` stays
    // false and the settle path can never release the slot just acquired — a
    // permanent under-capacity leak. Release it here and unlink the orphaned
    // thread instead.
    const admitLanded = yield* engine
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
          Effect.logWarning("board supervisor: admit-step rejected after acquire; releasing slot", {
            cardId: card.id,
            stepId: state.stepId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
    if (!admitLanded) {
      yield* slots.release(state.providerInstanceId);
      // The spawn already started an agent turn — interrupt it so the orphan
      // is not left burning tokens against a step the board refused to admit.
      // The immediate dispatch only lands if the provider session has already
      // bound (a slow admit); the usual case is caught durably by the
      // orphanedThreads set — the runtime `session.started` for this thread
      // re-dispatches the interrupt once there is a session to interrupt.
      orphanedThreads.add(String(threadId));
      yield* interruptOrphan(threadId);
      yield* dispatch({
        type: "board.card.unlink-thread",
        commandId: yield* commandId("unlink-orphan"),
        cardId: card.id,
        threadId,
        createdAt: yield* nowIso,
      });
    }
  });

  // A plan-mode step holds no slot and needs no worktree (D5): spawn it directly
  // in the project workspace root and mark it admitted. The decider records
  // `slotHeld: false` for a plan-mode admit, so nothing is charged against the
  // concurrency ceiling.
  const admitPlanStep = Effect.fn("board-supervisor-admitPlanStep")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
  }) {
    const { card, state } = input;
    const model = yield* snapshotQuery.getCommandReadModel();
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
      text: stepPromptFor(card, state),
    });
    // A plan step holds no slot, so a failed spawn leaks no capacity — but it
    // must still not be admitted against a thread that was never created.
    if (threadId === null) {
      yield* escalateSpawnFailure({ card, state });
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

  // The governor's scheduling pass (t3o-11, D11). Plan-mode steps spawn
  // immediately (no slot, no worktree, D5). Build-mode steps waiting for a slot,
  // whose worktree is ready, are ordered by the priority rule (stage desc →
  // started before unstarted → drag order) and offered to the governor greedily.
  const schedule = Effect.fn("board-supervisor-schedule")(function* () {
    const board = yield* readBoard;
    const settings = yield* boardSettings;
    const entries = new Map<
      string,
      {
        readonly card: BoardCard;
        readonly state: BoardCardStepState;
        readonly worktreePath: string;
        readonly limits: BoardConcurrencyLimit;
      }
    >();
    const candidates: BoardQueueCandidate[] = [];
    for (const state of board.stepStates ?? []) {
      if (state.status !== "pending" && state.status !== "queued") continue;
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined || card.archivedAt !== null) continue;
      if (state.mode === "plan") {
        // Plan-mode holds no slot: spawn a freshly selected step now. (Plan
        // steps are never `queued` — nothing withholds them.)
        if (state.status === "pending") yield* admitPlanStep({ card, state });
        continue;
      }
      // A build-mode step needs a ready worktree to spawn into. Anything that
      // is not `ready` and not mid-flight `provisioning` is (re)provisioned
      // right here, so a provisioning failure is a visible, retried step —
      // never a silently wedged pending one. That set is: `null` (never
      // provisioned), `failed` (retry), `reclaimed` (a card dragged back out
      // of Done to be reworked), and `branch-only` (a split PARENT reaching
      // its own review — its integration branch exists but no worktree does
      // yet, t3o-23 D5). `ensureWorktree` is idempotent and attaches to an
      // existing branch, so each of these resolves to a real worktree; only a
      // slice already `provisioning` is left to be re-offered when it lands.
      let worktreePath =
        card.worktree !== null && card.worktree.status === "ready" ? card.worktree.path : null;
      if (
        worktreePath === null &&
        (card.worktree === null || card.worktree.status !== "provisioning")
      ) {
        worktreePath = yield* ensureWorktree(card);
      }
      if (worktreePath === null) continue;
      const key = `${String(card.id)}::${state.stepId}`;
      entries.set(key, {
        card,
        state,
        worktreePath,
        limits: resolveBoardConcurrencyLimit(settings.concurrency, state.providerInstanceId),
      });
      // "Started" = the card has begun THIS stage's step (a recorded completion
      // for it), so a re-entered stage never ranks as mid-flight on a fresh run.
      candidates.push({
        cardId: card.id,
        stepId: state.stepId,
        providerInstanceId: state.providerInstanceId,
        stageOrder: boardStageIndex(board, card.stage),
        started: boardCardStepCompletions(board, card.id).some((c) => c.stepId === state.stepId),
        orderKey: card.orderKey,
      });
    }
    for (const candidate of orderBoardQueue(candidates)) {
      const entry = entries.get(`${String(candidate.cardId)}::${candidate.stepId}`);
      if (entry !== undefined) yield* admitBuildCandidate(entry);
    }
  });

  // ── Base-tip measurement (t3o-24, D1) ──────────────────────────────────
  // One `rev-parse` in the PROJECT ROOT — never the card's worktree, whose
  // HEAD is the card branch — against the card's recorded base ref. Null is
  // the honest failure signal (no worktree slice, no workspace root, an
  // unresolvable ref): staleness is measured, never assumed, so an
  // unmeasurable tip records nothing and intercepts nothing.
  const measureBaseTip = Effect.fn("board-supervisor-measureBaseTip")(function* (card: BoardCard) {
    const baseRefName = card.worktree?.baseRefName ?? null;
    if (baseRefName === null) return null;
    const model = yield* snapshotQuery.getCommandReadModel();
    const cwd = projectCwd(model, card);
    if (cwd === null) return null;
    const tip = yield* git
      .execute({
        operation: "boardBaseTip.resolve",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `refs/heads/${baseRefName}`],
        timeoutMs: 10_000,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
        Effect.catchCause(() => Effect.succeed("")),
      );
    return tip.length > 0 ? tip : null;
  });

  // Whether the card's base has MOVED since the run row's recorded
  // `baseTipAtRoundStart` (t3o-24, D1) — the reactor's one impure input to
  // `planNext` and to the crossing/merge-click interceptions. Generic on
  // purpose (D15): it compares two commit ids off the run row it already
  // owns, and learns nothing about review rounds. Scoped to sub-board
  // children: siblings are CREATED to collide on their shared base, while a
  // top-level card's base moving is the universal condition of trunk
  // development, reviewed at the human's discretion (t3o-24, scope).
  const resolveBaseStale = Effect.fn("board-supervisor-resolveBaseStale")(function* (
    card: BoardCard,
  ) {
    if (card.parentCardId === null) return false;
    const board = yield* readBoard;
    const recorded = boardCardStepState(board, card.id)?.baseTipAtRoundStart ?? null;
    if (recorded === null) return false;
    const tip = yield* measureBaseTip(card);
    if (tip === null) return false;
    return tip !== recorded;
  });

  // The tip a select-step command records (t3o-24, D1): measured fresh when
  // the executor's plan STARTS a review round (`recordBaseTip` — the
  // executor's signal, so the reactor never parses review step ids), else
  // carried forward from the row being replaced, so a round's later steps
  // keep the tip their round's review started from.
  const baseTipForPlan = Effect.fn("board-supervisor-baseTipForPlan")(function* (
    card: BoardCard,
    recordBaseTip: boolean,
  ) {
    if (recordBaseTip) return yield* measureBaseTip(card);
    const board = yield* readBoard;
    return boardCardStepState(board, card.id)?.baseTipAtRoundStart ?? null;
  });

  // Generic auto-kickoff (D7): a card entering a stage (drag or create), or an
  // on-demand thread request, resolves the stage's execution config, freezes it
  // onto the run row (select-step), and spawns. Auto-kickoff acts only when the
  // stage auto-executes; on-demand always starts a thread. First entry runs the
  // stage prompt; a re-entry opens a clean human-in-the-loop thread with no
  // prompt injected. A stage the card already has a live thread for is skipped.
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
    // A split parent builds THROUGH its children (t3o-23, D4): while any
    // child is unfinished, no run starts for it — not the build stage's
    // auto-execute (its move into Building is part of the approval), and not
    // an on-demand start either, because a thread spawned for a frozen card
    // could only watch. Its review-stage entry, which only happens after the
    // last child finished, kicks off normally.
    if (boardCardUnfinishedChildren(board, card.id).length > 0) return;
    // One step at a time (D4): do not start a run while one is live. The one
    // exception is `stalled` (t3o-17): supervision has given up and nothing is
    // running, so an EXPLICIT on-demand start is the human's retry affordance
    // — it supersedes the stalled step (settled abandoned; its slot was
    // already released at escalation) instead of no-opping, which would leave
    // a stalled card with a dead thread no exit but archive → unarchive. The
    // supersede runs BEFORE the live-stage-thread guard: the stalled step's
    // own thread link (role = step id = stage id on a simple stage, never
    // tombstoned at escalation) would otherwise trip that guard first, and it
    // is unlinked here for the same reason.
    const existing = boardCardStepState(board, card.id);
    const supersedeStalled = onDemand && existing !== null && existing.status === "stalled";
    if (supersedeStalled) {
      yield* settleStep({ card, state: existing, outcome: "abandoned" });
      if (existing.threadId !== null) {
        yield* dispatch({
          type: "board.card.unlink-thread",
          commandId: yield* commandId("unlink-stalled"),
          cardId: card.id,
          threadId: existing.threadId,
          createdAt: yield* nowIso,
        });
      }
      // The adopted-thread guard still applies (D7): superseding clears the
      // stalled step's OWN link, but a live stage thread beyond it — one a
      // human adopted — must not be trampled by a fresh spawn. The stalled
      // step is settled either way, so that adopted conversation is now the
      // stage's thread.
      const adopted = card.threadLinks.some(
        (link) =>
          link.role === card.stage &&
          link.tombstonedAt === null &&
          link.threadId !== existing.threadId,
      );
      if (adopted) return;
    } else {
      // Never trample a manually adopted thread for this stage (D7).
      if (hasLiveStageThread(card, card.stage)) return;
      if (existing !== null && !isBoardTerminalStepStatus(existing.status)) return;
    }
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(settings, card.stage);
    // Auto-kickoff fires only for an auto-executing stage; on-demand always runs.
    if (!onDemand && !exec.autoExecute) return;
    const completions = boardCardStepCompletions(board, card.id);
    // First entry vs re-entry (D7): a recorded completion for this stage's step
    // means the card has been here before, so re-run nothing — open a clean
    // human-in-the-loop conversation. This is reactor policy, orthogonal to the
    // executor's "what runs next".
    // The merge role does not follow the re-entry rule at all; it follows a
    // stricter one of its own. Nothing in this stage may run UNATTENDED unless
    // the board itself asked for it, which the pending-merge arm marks.
    //
    //  - Armed (a Merge click hit a conflict): run the conflict prompt
    //    unattended, however many times the card has been here. The step is
    //    requested once per conflict, not once per stage entry, so a second
    //    request is as real as the first — the re-entry rule would have given
    //    it an empty prompt and resolved nothing.
    //  - Not armed (a human restarted the stage thread by hand): a clean
    //    conversation, never an agent that merges base into their branch and
    //    pushes it. This holds even on the card's FIRST visit, where the
    //    ordinary rule would have run unattended.
    //
    // Every other stage keeps the ordinary rule: re-entry means the card came
    // back, and coming back must not silently redo the stage's work.
    const mergeRole = effectiveBoardStageRole(stage) === "merge";
    const armedConflictFix = mergeRole && mergeAwaitingConflictFix.has(String(card.id));
    // A sub-board child's merge stage is not a conversation (t3o-28, D3), so
    // the "not armed means talk to a human" arm above does not apply to it —
    // the same carve-out `autoMergeChild` documents, for the same reason: the
    // initiating act was Begin build on the parent, and a child parked here
    // strands every sibling that depends on it.
    //
    // It re-attempts the MERGE rather than assuming a conflict, because the
    // arm can be missing for two very different reasons and only the forge can
    // tell them apart: a conflict fix that escalated (`recoverStep` disarms) or
    // a server restart (the set is in-memory) both leave a real conflict
    // unarmed, while a merge refused for failing checks was never armed at all.
    // Running the conflict prompt blind on that second case spawns an agent to
    // "fix" a branch with nothing wrong with it — the asymmetric mistake
    // `isMergeConflictRefusal` exists to avoid. Asking the forge again gets a
    // conflict re-armed and its step started unattended through the ordinary
    // path below, and gets a policy block onto the activity rail instead.
    //
    // Gated on `!armedConflictFix` so the conflict step this very call can
    // start does not re-enter here and merge in a loop.
    if (mergeRole && !armedConflictFix && card.parentCardId !== null) {
      yield* autoMergeChild(card);
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
    // Ask the stage executor what runs next (D15): the reactor delegates the
    // "what to execute" decision rather than computing it inline. A card
    // entering its stage has no completed step for this run, so a simple stage
    // yields its single seeded step; the `complete`/`escalate` arms are the seam
    // t3o-16's review executor returns through and are not reached at entry.
    const plan = stageExecutorForRole(stage.role).planNext({
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
      // Stage entry: nothing of this card's is in flight yet.
      runState: {
        round: 1,
        completedStepIds: [],
        liveStepId: null,
        baseStale: yield* resolveBaseStale(card),
      },
    });
    if (plan.kind === "complete") {
      // The executor considers this entry already complete — a multi-step
      // executor plans from the card's ALL-TIME completions, so a review loop
      // that previously converged, was stopped, or exhausted its rounds reports `complete`
      // forever. A re-entry drag-back or an explicit on-demand request still
      // deserves a conversation (D7): open a clean human-in-the-loop thread on
      // the stage's own step id, exactly as a simple-stage re-entry does.
      // Never from the boot pass, though — a restart is not a human action.
      if (bootPass) return;
      const reentryModel =
        cardOverride === null ? model : boardModelSelectionOfOverride(cardOverride);
      yield* dispatch({
        type: "board.card.select-step",
        commandId: yield* commandId("select-step"),
        cardId: card.id,
        stepId: card.stage,
        // A re-entry conversation on the stage's own step: no step identity
        // (t3o-19, D4), just the stage's name.
        stepLabel: null,
        stageLabel: stage.label,
        prompt: "",
        // The card's override governs its re-entry conversation too (t3o-29):
        // this is still this card's run of this stage, and a user who pinned
        // the model would not expect dragging the card back to silently drop
        // it. Applied here rather than by an executor because no executor plans
        // a re-entry — the reactor owns it (D7) — and it is unconditional, so
        // it teaches the reactor nothing about stage kinds.
        providerInstanceId: reentryModel.instanceId,
        model: reentryModel.model,
        runtimeMode: cardOverride?.runtimeMode ?? exec.runtimeMode,
        ...(reentryModel.options === undefined ? {} : { modelOptions: reentryModel.options }),
        mode: exec.mode,
        humanInLoop: true,
        maxAttempts: exec.maxAttempts,
        timeoutMs: exec.timeoutMs,
        // A re-entry conversation starts no review round: carry the recorded
        // tip forward (t3o-24, D1) so a parked card's staleness stays
        // answerable.
        baseTipAtRoundStart: yield* baseTipForPlan(card, false),
        createdAt: yield* nowIso,
      });
      yield* schedule();
      return;
    }
    if (plan.kind !== "run") return;
    // Mode (D5) and human-in-the-loop (D5/D6/D7) are reactor policy layered onto
    // the executor's step: a re-entry forces a clean human-in-the-loop thread
    // with no prompt injected.
    const humanInLoop = firstEntry ? resolveHumanInLoop(board, settings, card, exec) : true;
    const prompt = firstEntry ? plan.prompt : "";
    yield* dispatch({
      type: "board.card.select-step",
      commandId: yield* commandId("select-step"),
      cardId: card.id,
      stepId: plan.stepId,
      stepLabel: plan.stepLabel,
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
      // otherwise (t3o-24, D1).
      baseTipAtRoundStart: yield* baseTipForPlan(card, plan.recordBaseTip),
      createdAt: yield* nowIso,
    });
    // Provisioning is `schedule`'s job, not a second call here: it already
    // provisions (or retries) the worktree of every pending build-mode step,
    // including the one just selected, and plan mode needs none. Doing it
    // twice was invisible while provisioning succeeded — the second call
    // short-circuits on a `ready` worktree — but a FAILING one reported its
    // failure onto the card twice for a single click.
    yield* schedule();
  });

  // Auto-advance to the next stage in order (D8): on a successful UNATTENDED
  // run, if the stage's `autoAdvance` is on, move the card to the next stage —
  // never the hardcoded "review". Never on a human-in-the-loop run (no
  // completion stance to advance on), never when the stage is last. Rides the
  // ordinary move command, gated like every other transition (a crossing into a
  // blocked build boundary is refused, leaving the card put).
  const advanceStage = Effect.fn("board-supervisor-advanceStage")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
  }) {
    if (input.state.humanInLoop) return;
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(settings, input.card.stage);
    if (!exec.autoAdvance) return;
    const board = yield* readBoard;
    const next = boardNextStageId(board, input.card.stage);
    if (next === null) return;
    yield* dispatch({
      type: "board.card.move",
      commandId: yield* commandId("advance"),
      cardId: input.card.id,
      toStage: next,
      createdAt: yield* nowIso,
    });
  });

  /**
   * The sub-board runs itself once the parent starts it (t3o-28, D3).
   *
   * The parent's arrival at the build-role stage is the Begin build for the
   * WHOLE split, so every child the plan graph does not block moves off the
   * materialisation floor into build — and every later call starts whatever
   * the last finisher unblocked, so a four-plan chain walks itself from #1 to
   * #4 with no human in between.
   *
   * Each child rides an ordinary `board.card.move` (floor → build is adjacent
   * by construction, so no override), which means `handleCardMoved` does the
   * rest exactly as it does for a drag: step selection, a worktree cut from
   * the integration branch, the thread spawn, and the governor's slots. A
   * cascaded child is indistinguishable from a dragged one — including when
   * there is no slot free, where it simply queues.
   *
   * D18's "approving a split cannot fan out into N running agents" is intact:
   * `handleCardCreated` still refuses to start a materialised child. The
   * fan-out moved to the gesture that means it.
   */
  const cascadeUnblockedChildren = Effect.fn("board-supervisor-cascadeChildren")(function* (
    parentCardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const parent = board.cards.find((candidate) => candidate.id === parentCardId);
    if (parent === undefined || parent.archivedAt !== null) return;
    const buildStage = boardStageWithRole(board, "build");
    const floor = boardSubBoardFloorStage(board);
    if (buildStage === null || floor === null) return;
    // Fire once the split has BEGUN — not only while the parent sits exactly at
    // build. "Begun" = some live child has already left the floor for the build
    // stage or beyond (a building, reviewing, merging or done child). Before
    // that, approval alone must start nothing (t3o-28 D1) — the human has not
    // pressed Begin build. But once a child is underway, the split runs to
    // completion no matter WHERE the human parked the parent: dragging the
    // supervising card back to the floor must not silently strand the freed
    // siblings, which is the production bug this replaced. The parent arriving
    // at build (its own move) still triggers the first cascade; this only widens
    // the child-finished / child-deleted re-runs to survive a parked parent.
    const begun =
      parent.stage === buildStage.stageId ||
      boardCardChildren(board, parent.id).some(
        (child) => child.archivedAt === null && isBoardStageAtOrAfterBuild(board, child.stage),
      );
    if (!begun) return;
    for (const child of boardCardChildren(board, parent.id)) {
      if (child.archivedAt !== null) continue;
      // Waiting on the floor is the only state this starts. A child further
      // along is already running, done, or parked somewhere by a human — and
      // none of those want a move.
      if (child.stage !== floor.stageId) continue;
      // The D11 dependency gate would refuse this move anyway; skipping it
      // here keeps the cascade from teaching the rule by refusal.
      const unmet = unmetBoardCardDependencies({
        board,
        dependsOn: child.dependsOn,
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

  // A split parent advances when its last child finishes (t3o-23, D4; the
  // D18 carve-out "a parent card advances when its last child plan card
  // reaches Done"). Rides the ordinary move like `advanceStage` — the
  // decider's ceiling has lifted (no unfinished children left), and the target
  // is the NEXT stage in order, not a hardcoded review, so a custom stage
  // between Build and Review is not skipped. Only a parent still sitting in
  // the build-role stage advances: that is where the human's Begin build put
  // it (t3o-28, D1/D3), so a parent still short of build, one already dragged
  // onward, or one that never split is left alone — which is also what makes
  // a raced double-fire harmless, the second call finding the parent moved.
  const advanceParentIfChildrenDone = Effect.fn("board-supervisor-advanceParent")(function* (
    parentCardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const parent = board.cards.find((candidate) => candidate.id === parentCardId);
    if (parent === undefined || parent.archivedAt !== null) return;
    const buildStage = boardStageWithRole(board, "build");
    if (buildStage === null) return;
    // All children deleted is NOT completion — the parent unfreezes where it
    // stands and the human decides what the empty split means.
    if (boardCardChildren(board, parent.id).length === 0) return;
    if (boardCardUnfinishedChildren(board, parent.id).length > 0) return;
    // The parent's build-through-children is finished, so it advances to the
    // stage after build — its own integration review — from WHEREVER it sits.
    // A human may have parked it back on the floor (`ready`) while the children
    // ran; leaving it there once every child is done is the mirror of the
    // stranded-cascade bug, so the target is the stage after build rather than
    // the stage after the parent's current position. A parent already at or
    // past that target (its review has started, or it is further on) needs no
    // move.
    const next = boardNextStageId(board, buildStage.stageId);
    if (next === null) return;
    const parentIndex = boardStageIndex(board, parent.stage);
    const targetIndex = boardStageIndex(board, next);
    if (parentIndex < 0 || targetIndex < 0 || parentIndex >= targetIndex) return;
    yield* dispatch({
      type: "board.card.move",
      commandId: yield* commandId("advance-parent"),
      cardId: parent.id,
      toStage: next,
      // The parent may be parked several stages below build; the advance is
      // machinery, not a drag, but it forces adjacency the same way the t3o-24
      // regression does.
      override: true,
      createdAt: yield* nowIso,
    });
  });

  // The mirror check (t3o-24, D4): a child leaving the done-role stage while
  // its parent sits PAST the build-role stage leaves the parent ahead of
  // reality — its review (or merge, or Done) describes an integration branch
  // whose children are no longer all finished. Move the parent back to the
  // build-role stage: an ordinary move (the decider's freeze-guard admits
  // exactly this regression), whose own `handleCardMoved` abandons any live
  // parent review step through the existing abandon path. When the child
  // finishes again, `advanceParentIfChildrenDone` re-advances the parent and
  // its review starts a fresh round against the changed integration branch —
  // D1–D3 applied one level up. Guarded on the freeze actually re-engaging
  // (unfinished children exist), so it is a cheap no-op on every other move.
  const regressParentIfChildLeftDone = Effect.fn("board-supervisor-regressParent")(function* (
    parentCardId: BoardCardId,
  ) {
    const board = yield* readBoard;
    const parent = board.cards.find((candidate) => candidate.id === parentCardId);
    if (parent === undefined || parent.archivedAt !== null) return;
    const buildStage = boardStageWithRole(board, "build");
    if (buildStage === null) return;
    const parentIndex = boardStageIndex(board, parent.stage);
    const buildIndex = boardStageIndex(board, buildStage.stageId);
    if (parentIndex < 0 || buildIndex < 0 || parentIndex <= buildIndex) return;
    if (boardCardUnfinishedChildren(board, parent.id).length === 0) return;
    yield* dispatch({
      type: "board.card.move",
      commandId: yield* commandId("regress-parent"),
      cardId: parent.id,
      toStage: buildStage.stageId,
      // The parent may be two or more stages ahead (merge, Done); the
      // regression is machinery, not a drag, but it forces adjacency the same
      // way.
      override: true,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Merge a sub-board child down, on its arrival at the merge-role stage.
   *
   * The merge spec's rule — "no merge happens that a human did not initiate" —
   * is about a card whose merge nobody asked for. A sub-board child is not
   * that card. The human DID initiate it: Begin build on the parent is the one
   * act that fans a split out, and t3o-28 D3 spends the rest of the lifecycle
   * making good on it ("finishing #1 starts #2 and #3 with no human in
   * between"). A child parked at the merge stage waiting to be clicked breaks
   * that chain and strands every sibling whose dependency it holds — the split
   * stops being automation and becomes N buttons.
   *
   * So the carve-out is exactly one card shape: `parentCardId !== null`. A
   * top-level card still merges only on a click, which is what every merge
   * test outside the sub-board suite pins.
   *
   * What it does NOT change is what happens when the forge says no. A conflict
   * still starts the conflict-resolution step (and that step's success still
   * finishes the merge), and a policy block — failing checks, a missing
   * approval — still stops and hands the card to a human, because that block
   * needs a decision the board does not have. The one addition is that an
   * unattended refusal has to be legible: nobody is watching the return value
   * of an auto-merge, so the reason goes on the activity rail.
   */
  const autoMergeChild = Effect.fn("board-supervisor-autoMergeChild")(function* (card: BoardCard) {
    const outcome = yield* mergeCardPullRequest(card.id);
    switch (outcome.outcome) {
      // Landed, or already in hand: the merge advanced the card to Done, a
      // conflict step is running and will finish the merge itself, and a stale
      // base has already sent the card back for one more review round.
      case "merged":
      case "conflict":
      case "stale-base":
        return;
      default:
        break;
    }
    // Everything else is the card stopping where it stands. Say why on the
    // card: this merge had no click behind it, so there is no return value for
    // a human to read and no dialog to put it in.
    const detail =
      outcome.outcome === "refused"
        ? outcome.detail
        : outcome.outcome === "not-open"
          ? `Its pull request is ${outcome.state}, so there was nothing to merge.`
          : outcome.outcome === "no-pull-request"
            ? "It has no pull request to merge."
            : `The merge could not run (${outcome.outcome}).`;
    yield* dispatch({
      type: "board.card.record-note",
      commandId: yield* commandId("auto-merge-refused"),
      cardId: card.id,
      kind: "card-merge-refused",
      detail: `Held the sub-board merge. ${detail}`,
      createdAt: yield* nowIso,
    });
  });

  // A step settled `succeeded`: ask the stage executor what runs NEXT before
  // advancing the card (t3o-16). For a single-step stage the executor reports
  // `complete` (its one step is done) and this advances exactly as before; for a
  // multi-step stage (the review loop) it returns the next round-scoped step and
  // this selects it, re-entering the ordinary select-step → schedule → spawn
  // path. The reactor stays generic — it never learns which kind of stage it is
  // driving, only what the executor says to run. A terminal loop outcome
  // (`blocked`, a broken reviewer payload) leaves the card put with its
  // completions visible (D8).
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
    const exec = resolveBoardStageExecution(settings, card.stage);
    const completions = boardCardStepCompletions(board, card.id);
    const model = resolveBoardStageModelSelection(exec.model, yield* fallbackModelSelection);
    const cardOverride = cardStageModelOverride(board, card);
    const completedStepIds = completions
      .filter((completion) => completion.outcome === "succeeded")
      .map((completion) => completion.stepId);
    const plan = stageExecutorForRole(stage.role).planNext({
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
      // round is already counted through its recorded completion.
      runState: {
        round: 1,
        completedStepIds,
        liveStepId: null,
        baseStale: yield* resolveBaseStale(card),
      },
    });
    switch (plan.kind) {
      case "run": {
        // Only auto-EXECUTE a stage that opts into it. A completed step is
        // normally the card's current stage's own, but if the card was dragged
        // to another column while a step was still in flight and that step later
        // finishes, `card.stage` is now the DESTINATION — and the simple
        // executor, seeing no completion for it, plans a fresh `run`. That is
        // how a finished Planning run, on a card already moved to the manual
        // Sprint column, once spawned a spurious Sprint thread on the app's
        // fallback provider. The move handler now abandons such leftovers before
        // they complete; this is the second lock. Gating only the `run` arm (not
        // the whole continuation) leaves a manual stage's `complete` → auto-
        // advance path intact — this blocks a spurious SPAWN, not a crossing.
        if (!exec.autoExecute) return;
        // The card is finished with the phase that just settled: the loop is
        // moving to the NEXT step within this stage (the review loop is the one
        // stage that lands here). Settle that phase's thread so it drops out of
        // the inbox as the next phase spins up — the card keeps the tab, this
        // only clears the inbox. Best-effort: a thread still mid-turn is refused
        // by the settle guard and simply skipped; the swallow-on-reject dispatch
        // never derails the continuation. The stage's FINAL phase does not reach
        // this arm (it `complete`s → advances), so its thread is settled by the
        // graduation sweep in `handleCardMoved` instead.
        if (state.threadId !== null) {
          yield* dispatchOptional({
            type: "thread.settle",
            commandId: yield* commandId("settle-phase"),
            threadId: state.threadId,
          });
        }
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
          // An intra-stage continuation carries the stage entry's running
          // invocation total forward (t3o-17, D5): the projector keeps one
          // step-state row per card, so without the carry each phase selection
          // would reset the per-stage-entry ceiling and the review loop's real
          // bound would become rounds × phases × ceiling.
          priorInvocations: boardStageEntryInvocationCount(board, card.id),
          // Measured fresh when this plan starts a review round, carried
          // forward otherwise (t3o-24, D1).
          baseTipAtRoundStart: yield* baseTipForPlan(card, plan.recordBaseTip),
          createdAt: yield* nowIso,
        });
        if (exec.mode === "build") yield* ensureWorktree(card);
        return;
      }
      case "complete": {
        // The stage is done. A SUCCESSFUL stage may auto-advance (D8) — for the
        // review loop that means a converged round and nothing else. Every
        // other terminal outcome leaves the card put with its findings visible:
        // a broken reviewer payload, a loop the user stopped, and — since
        // t3o-22 D1 — a loop that ran out of rounds with findings still open,
        // which carries a converged loop's round counts and the opposite
        // meaning.
        if (plan.outcome === "succeeded") yield* advanceStage({ card, state });
        return;
      }
      case "escalate": {
        // The executor cannot proceed and wants a human (e.g. a phase that
        // completed with an unreadable payload). Leave the card put — there is no
        // live step to gate. t3o-18 D13 deleted `board.card.request-input`, the
        // command this used to record the question with, and the Activity rail's
        // curated kinds (D12) have no "escalation note" among them. Nothing
        // rendered that activity row before either, so nothing regresses
        // visually; the question goes to the server log, where the operator
        // reading a card that stopped moving will find it.
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
   * Ask a SETTLED stage's executor whether an edit gave it more to run
   * (t3o-22, D6), and start that step if so.
   *
   * The path exists for the review loop: a loop held at its round cap is
   * terminal, so raising the card's budget must make it plan round N+1 — but
   * `continueStage` only ever runs off a step settling, and nothing settles
   * here. It stays role-agnostic on purpose (t3o-16 AC10): it asks whatever
   * executor the stage has and acts ONLY on a `run` plan.
   *
   * A `complete` plan is a deliberate no-op. `SimpleStageExecutor` reports
   * exactly that for its already-recorded step, so every non-review stage falls
   * straight through — and, more importantly, routing a `complete` back into
   * `advanceStage` would let any card edit re-advance a card that already
   * graduated.
   */
  const replanSettledStage = Effect.fn("board-supervisor-replanSettledStage")(function* (
    card: BoardCard,
  ) {
    const board = yield* readBoard;
    const stage = boardStageById(board, card.stage);
    if (stage === null) return;
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(settings, card.stage);
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
    const plan = stageExecutorForRole(stage.role).planNext({
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
      // The stage is settled, so nothing of this card's is in flight.
      runState: {
        round: 1,
        completedStepIds,
        liveStepId: null,
        baseStale: yield* resolveBaseStale(card),
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
      // Carried forward exactly as an intra-stage continuation does (t3o-17,
      // D5). Resuming a held loop spends more of the SAME stage entry's budget,
      // so the per-stage-entry ceiling still applies; a resume that stalls on it
      // is the stall guard working, and it surfaces on the card.
      priorInvocations: boardStageEntryInvocationCount(board, card.id),
      // Measured fresh when this plan starts a review round, carried forward
      // otherwise (t3o-24, D1).
      baseTipAtRoundStart: yield* baseTipForPlan(card, plan.recordBaseTip),
      createdAt: yield* nowIso,
    });
    if (exec.mode === "build") yield* ensureWorktree(card);
    yield* schedule();
  });

  // Release the step's slot on settlement — a no-op for a plan-mode step, which
  // never held one (D5). The provider is read off the frozen run row (D12).
  const releaseSlot = (state: BoardCardStepState) =>
    state.slotHeld ? slots.release(state.providerInstanceId) : Effect.void;

  const settleStep = Effect.fn("board-supervisor-settleStep")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    readonly outcome: "succeeded" | "failed" | "abandoned";
  }) {
    // A conflict fix that did NOT succeed must not leave the card armed. The
    // success path consumes the entry itself (and needs it, to complete the
    // merge), so only the other terminal outcomes clear it here — otherwise a
    // failed, timed-out or abandoned fix leaves a stale entry that the next
    // merge-stage step to succeed, possibly one a human started by hand days
    // later, would consume and turn into a merge nobody asked for.
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

  const recoverStep = Effect.fn("board-supervisor-recoverStep")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
  }) {
    // Resolve the two things the pure decision needs but must not read itself
    // (D2/D5): the progress signal (git/activity) and the stage-entry invocation
    // total and its ceiling (settings). `recoveryDecision` stays pure.
    const board = yield* readBoard;
    const settings = yield* boardSettings;
    const exec = resolveBoardStageExecution(settings, input.card.stage);
    const progressedSinceLastNudge = yield* resolveProgressedSinceLastNudge(
      input.state,
      input.card,
    );
    const stageEntryInvocations = boardStageEntryInvocationCount(board, input.card.id);
    const todo = yield* threadTodoState(input.state.threadId);
    const decision = recoveryDecision({
      stepState: input.state,
      progressedSinceLastNudge,
      hasTodoList: todo?.hasList ?? false,
      stageEntryInvocations,
      maxInvocationsPerStageEntry: exec.maxInvocationsPerStageEntry,
      endedWithQuestion: yield* endedWithQuestion(input.state),
    });

    // Recovery gives up (t3o-17, D3/D4): consecutive stalls exhausted
    // `maxAttempts`, or the stage-entry invocation ceiling was crossed. Ask the
    // human (retry / switch provider / take it over) as a visible card activity,
    // and land the step in the distinct `stalled` status — loud, not the same
    // `awaiting-input` a healthy question reaches — while RELEASING its slot: no
    // thread is running, so a parked card must not hold capacity for a weekend.
    // Crucially do NOT drive the agent — escalation is a human decision, and
    // sending another turn would re-arm death detection and re-escalate every
    // turn. Not driving the agent is what makes recovery "escalate and never
    // loop": it stops here until a human acts.
    if (decision.kind === "escalate") {
      // The escalation question used to be recorded with
      // `board.card.request-input`; t3o-18 D13 deleted that command. The
      // human-facing signal is the card's `stalled` badge (t3o-17, D3) — loud,
      // and the board offers a way to find every stalled card — and the question
      // itself goes to the server log.
      yield* Effect.logWarning("board supervisor: recovery escalated to a human", {
        cardId: input.card.id,
        stepId: input.state.stepId,
        stallCount: decision.stallCount,
        question: decision.question,
      });
      // Escalation lands the step `stalled` — non-terminal, so it never reaches
      // `settleStep` and its disarm. A conflict fix that stalls has handed the
      // card to a human, and the human's next move must be an explicit Merge
      // click; leaving the card armed would let some later merge-stage step
      // succeeding turn into a merge nobody asked for.
      disarmPendingMerge(input.card.id);
      yield* dispatch({
        type: "board.card.recover-step",
        commandId: yield* commandId("recover-step"),
        cardId: input.card.id,
        stepId: input.state.stepId,
        threadId: input.state.threadId,
        escalateToHuman: true,
        progressed: progressedSinceLastNudge,
        createdAt: yield* nowIso,
      });
      // Release the held slot exactly once (D4), riding the existing machinery:
      // the pre-escalation state's `slotHeld` gates the release, and the decider
      // has set the persisted `slotHeld` to false, so a re-run releases nothing.
      yield* releaseSlot(input.state);
      yield* schedule();
      return;
    }

    // Ordinary retry. Recovery never releases the held slot (a retry keeps its
    // place, D13). If the step's thread survives, nudge it in place; if it has
    // vanished (reaped/deleted) — a routine path, not an error — respawn a fresh
    // thread and continue there, so the nudge is never sent into the void.
    const gone = yield* threadGone(input.state.threadId);
    let threadId = input.state.threadId;
    let acted = false;
    // Where a respawn runs: a build-mode step needs its ready worktree; a
    // plan-mode step respawns in the project workspace root (D5).
    const respawnTarget = yield* Effect.gen(function* () {
      if (input.state.mode === "build") {
        return input.card.worktree?.path != null
          ? { worktreePath: input.card.worktree.path, branch: input.card.worktree.branch ?? null }
          : null;
      }
      const model = yield* snapshotQuery.getCommandReadModel();
      const cwd = projectCwd(model, input.card);
      return cwd === null ? null : { worktreePath: cwd, branch: null as string | null };
    });
    if (gone) {
      if (respawnTarget !== null) {
        // Tombstone the dead thread's card link before spawning a fresh one, so
        // links do not accumulate across recoveries (D9). Best-effort — the
        // dispatch helper swallows a reject (e.g. already tombstoned by the
        // thread-deletion path).
        if (input.state.threadId !== null) {
          yield* dispatch({
            type: "board.card.unlink-thread",
            commandId: yield* commandId("unlink-dead"),
            cardId: input.card.id,
            threadId: input.state.threadId,
            createdAt: yield* nowIso,
          });
        }
        const respawned = yield* spawnStepThread({
          card: input.card,
          step: {
            stepId: input.state.stepId,
            stepLabel: input.state.stepLabel,
            stageLabel: input.state.stageLabel,
            providerInstanceId: input.state.providerInstanceId,
            model: input.state.model,
            mode: input.state.mode,
            runtimeMode: input.state.runtimeMode,
            modelOptions: input.state.modelOptions,
          },
          worktreePath: respawnTarget.worktreePath,
          branch: respawnTarget.branch,
          runSetup: false,
          text: decision.nudge,
          attachments: [],
        });
        // A respawn that produced no thread sent nothing. Escalating here is
        // what keeps the failure visible: the `!acted` arm below leaves the
        // step `running` against the thread this recovery just tombstoned, so
        // the timeout sweep would re-enter every `timeoutMs` forever — no
        // attempt consumed, a build step's slot held throughout, and nothing
        // the human can see or restart (the phantom-running state this whole
        // change exists to eliminate).
        if (respawned === null) {
          yield* escalateSpawnFailure({ card: input.card, state: input.state });
          yield* schedule();
          return;
        }
        threadId = respawned;
        acted = true;
      }
    } else if (input.state.threadId !== null) {
      yield* sendTurn({
        threadId: input.state.threadId,
        text: decision.nudge,
        runtimeMode: input.state.runtimeMode,
      });
      acted = true;
    }
    // If we could neither nudge a live thread nor respawn a vanished one (a gone
    // thread with no worktree/provider to respawn against), do NOT burn an
    // attempt on a recovery that sent nothing — leave the step as-is and say so.
    if (!acted) {
      yield* Effect.logWarning(
        "board supervisor: cannot recover step — no thread and cannot respawn",
        {
          cardId: input.card.id,
          stepId: input.state.stepId,
        },
      );
      return;
    }
    yield* dispatch({
      type: "board.card.recover-step",
      commandId: yield* commandId("recover-step"),
      cardId: input.card.id,
      stepId: input.state.stepId,
      threadId,
      escalateToHuman: false,
      progressed: progressedSinceLastNudge,
      createdAt: yield* nowIso,
    });
  });

  // A step thread's turn ended (runtime `turn.completed`): the death/stall test
  // (D4). A step that is running OR awaiting a human answer, with no completion
  // and no pending question left on the thread, settled without completing —
  // recover. A still-pending question is the legitimate gate (D13), not death.
  // ── Card ↔ pull request ─────────────────────────────────────────────

  /**
   * Re-resolve the card's pull request from the forge and record it if it
   * moved.
   *
   * Called from the refresh triggers, never on a timer. There is deliberately
   * NO periodic sweep: the cost of PR lookups is driven by how many branches
   * are asked about, not how often, and a board-wide poll would grow with the
   * board while telling us nothing new about cards nobody is touching.
   *
   * Three cheap refusals come first, and between them they keep the lookup set
   * bounded by "cards actually in flight":
   *
   *  1. No ready worktree — no branch, so nothing to look up.
   *  2. A MERGED pull request — the one state that can never change again, so a
   *     card stops costing lookups the moment its PR lands. `closed`
   *     deliberately does NOT stop them: it can be reopened, and a branch
   *     whose PR was closed is the one most likely to get a new one.
   *  3. A lookup FAILURE records nothing, leaving the last known link in
   *     place. This mirrors `rememberLastKnownPr` in `GitManager` and exists
   *     for the same reason: a rate limit or a network blip must not blank a
   *     card's PR badge. "No PR" and "could not ask" are different answers and
   *     only the first is worth recording.
   */
  const refreshCardPullRequestLink = Effect.fn("board-supervisor-refreshCardPullRequestLink")(
    function* (card: BoardCard) {
      const worktree = card.worktree;
      // No branch means nothing to look up — a card that never entered Building
      // has no worktree at all. But a RECLAIMED worktree still has its branch
      // name (reclaim nulls `path`, not `branch`) and its card can still be
      // merged, so it must still be refreshable: falling back to the project
      // root keeps "the worktree was tidied away" from silently freezing the
      // card's link at whatever it last said.
      if (worktree === null) return;
      if (isBoardCardPullRequestTerminal(card.pullRequest)) return;

      const model = yield* snapshotQuery.getCommandReadModel();
      const cwd = worktree.path ?? projectCwd(model, card);
      if (cwd === null) return;

      const found = yield* pullRequests.find({ cwd, branch: worktree.branch }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("board supervisor: pull request lookup failed; keeping last known", {
            cardId: card.id,
            branch: worktree.branch,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        ),
      );
      // `undefined` is the failure sentinel, `null` a real "there is no PR".
      if (found === undefined) return;

      const next =
        found === null
          ? null
          : ({
              number: found.number,
              url: found.url,
              state: found.state,
              headBranch: found.headRef,
              baseRef: found.baseRef,
              checkedAt: yield* nowIso,
            } satisfies BoardCardPullRequest);

      // Re-read before deciding. The lookup above is a forge round trip, and
      // the card handed in was read BEFORE it — so every trigger this card has
      // (a card opening in one browser tab, the same card opening in another, a
      // review step boundary, a stage move) spends that whole window holding a
      // pull request state that another trigger may have already recorded. The
      // guards below are all comparisons against what the card holds NOW, so
      // they have to run against the freshest read available or they compare
      // against a state that has already been superseded.
      const current = (yield* readCard(card.id)) ?? card;

      // A pull request at or below the floor belongs to a round this card has
      // already finished (see `BoardCard.pullRequestFloor`). The decider refuses
      // it too — that refusal is the load-bearing one — but a card on its second
      // round resolves its retired pull request on EVERY lookup until the new
      // round opens one, so catching it here keeps that from being a rejected
      // dispatch and a warning log every single time. `open` and the card's
      // current link are exempt for the reasons the decider gives: the first is
      // the branch's live pull request rather than a finished round's, and the
      // second is how a link adopted while open records its own merge.
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
        return;
      }
      // The decider rejects a no-op too, but checking here keeps the common case
      // — a refresh that found exactly what we already knew — from generating a
      // rejected dispatch on every card open. It cannot close the window
      // entirely: two refreshes that overlap can both pass this and only one
      // can land, which is why the dispatch below tolerates the refusal.
      if (boardCardPullRequestsEqual(current.pullRequest, next)) return;

      yield* dispatchOptional({
        type: "board.card.record-pull-request",
        commandId: yield* commandId("record-pr"),
        cardId: card.id,
        pullRequest: next,
        createdAt: yield* nowIso,
      });
    },
  );

  /**
   * Refresh the card's pull request, then settle it if that leaves a merged
   * pull request on a card sitting in Done.
   *
   * The settle is deliberately hung off the REFRESH rather than off the stage
   * move. "In Done" and "merged" are two facts that can become true in either
   * order — the card can arrive in Done with its pull request already merged,
   * or sit there while somebody merges it on the forge — and only the second
   * fact to arrive can act on the pair. Every refresh trigger the card already
   * has (a merge click, a stage move, the card's detail being opened) therefore
   * doubles as a settle trigger, and none of them costs a forge call it was not
   * already making. Nothing here polls.
   */
  const refreshCardPullRequest = Effect.fn("board-supervisor-refreshCardPullRequest")(function* (
    card: BoardCard,
    /** The stage to settle against, when the caller holds better authority than
        the read model does. Only `handleCardMoved` passes it: a `board.card-moved`
        payload carries the post-move stage, which is the rule that handler
        already states for itself, and the read model has not necessarily caught
        up. Every other caller — the RPC path included — omits it and gets the
        card's own stage as re-read, which is the freshest thing available to
        them; overriding with a stage they read EARLIER would be strictly
        staler, not fresher. */
    movedToStage?: BoardCard["stage"],
  ) {
    yield* refreshCardPullRequestLink(card);
    // Re-read for the pull request the refresh may have just recorded.
    const refreshed = yield* readCard(card.id);
    if (refreshed === null) return;
    yield* settleCardAtDone(
      movedToStage === undefined ? refreshed : { ...refreshed, stage: movedToStage },
    );
  });

  /** The card as the read model currently has it, or null if it is gone. */
  const readCard = Effect.fn("board-supervisor-readCard")(function* (cardId: BoardCardId) {
    const board = yield* readBoard;
    return board.cards.find((candidate) => candidate.id === cardId) ?? null;
  });

  /**
   * Delete a card's branch on arrival at Done, when its PR is merged and the
   * merge stage's `deleteBranchOnDone` is on.
   *
   * Runs AFTER a refresh, so the decision is made against what the forge says
   * now rather than whatever was last cached — the difference matters most in
   * exactly the case this exists for, a PR merged on GitHub while the card sat
   * in the merge stage.
   *
   * Best-effort throughout: a cleanup that fails is reported on the card and
   * never blocks the move to Done. A branch that outlives its card is untidy;
   * a card that cannot reach Done because a `git push --delete` failed is
   * broken.
   */
  const cleanupBranchOnDone = Effect.fn("board-supervisor-cleanupBranchOnDone")(function* (
    card: BoardCard,
  ) {
    const worktree = card.worktree;
    if (worktree === null) return;
    if (card.pullRequest === null || card.pullRequest.state !== "merged") return;

    const settings = yield* boardSettings;
    const board = yield* readBoard;
    const mergeStage = boardStageWithRole(board, "merge");
    if (mergeStage === null) return;
    const exec = resolveBoardStageExecution(settings, mergeStage.stageId);
    if (!isBoardMergeStageExecution(exec) || !exec.deleteBranchOnDone) return;

    const model = yield* snapshotQuery.getCommandReadModel();
    const cwd = projectCwd(model, card);
    if (cwd === null) return;

    const result = yield* deleteCardBranch({ git, cwd, branch: worktree.branch }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor: branch cleanup failed", {
          cardId: card.id,
          branch: worktree.branch,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
    if (result === null) return;
    // Report it on the card, not just in the log. Deleting a branch is
    // irreversible, and a partial cleanup — remote gone, local still held by a
    // worktree — is a real outcome whenever `reclaimWorktreeOnDone` is off, so
    // the user needs to be told which of their branches still exist without
    // reading server logs to find out.
    const deleted = [
      ...(result.remoteDeleted ? ["remote"] : []),
      ...(result.localDeleted ? ["local"] : []),
    ];
    const detail =
      deleted.length === 0
        ? `Kept branch ${worktree.branch}${result.skippedReason === null ? "" : ` — ${result.skippedReason}`}`
        : `Deleted ${deleted.join(" and ")} branch ${worktree.branch}${
            result.skippedReason === null ? "" : ` — ${result.skippedReason}`
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
   * Remove a card's worktree, reporting the outcome onto the card.
   *
   * Shared by the two moments a worktree is reclaimed — arrival at Done with a
   * merged pull request, and archive — so both get the same clean-and-pushed
   * refusal, the same activity-rail entry and the same never-fatal error
   * handling. Reclaim NEVER deletes uncommitted work to save disk: a dirty or
   * unpushed tree is kept and the reason recorded (t3o-09, D6).
   *
   * A worktree that is not `ready` is already gone (or never arrived), so this
   * is idempotent — the property the boot sweep leans on.
   */
  const reclaimCardWorktree = Effect.fn("board-supervisor-reclaimCardWorktree")(function* (
    card: BoardCard,
  ) {
    if (card.worktree === null || card.worktree.status !== "ready" || card.worktree.path === null) {
      return;
    }
    const model = yield* snapshotQuery.getCommandReadModel();
    const cwd = projectCwd(model, card);
    if (cwd === null) return;
    const reclaimed = yield* reclaimBoardCardWorktree({
      projectCwd: cwd,
      worktreePath: card.worktree.path,
    }).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, git),
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        Effect.logWarning("board supervisor: worktree reclaim failed", {
          cardId: card.id,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.as(
            Option.none<{
              readonly outcome: "removed" | "blocked";
              readonly reason: string | null;
            }>(),
          ),
        ),
      ),
    );
    if (Option.isNone(reclaimed)) return;
    yield* dispatch({
      type: "board.card.reclaim-worktree",
      commandId: yield* commandId("reclaim-worktree"),
      cardId: card.id,
      outcome: reclaimed.value.outcome,
      ...(reclaimed.value.reason === null ? {} : { reason: reclaimed.value.reason }),
      createdAt: yield* nowIso,
    });
  });

  /**
   * The round each card was last settled in, this process — see
   * `settleCardAtDone`. Keyed by ROUND rather than being a plain set of card
   * ids, and cleared by nothing but archive.
   *
   * A per-card flag cleared on the move out of Done looked equivalent and was
   * not: a settle already in flight when the card moved would finish afterwards
   * and re-add the flag, and round two would then silently never settle. The
   * round index moves with the card instead, so a late write from round one
   * records round one and cannot mask round two.
   *
   * `pullRequestHistory.length` IS the round index: it increments exactly once,
   * at the boundary, when the card leaves the done-role stage carrying a pull
   * request.
   */
  const settledAtDone = new Map<string, number>();
  const boardCardRound = (card: BoardCard): number => card.pullRequestHistory.length;

  /**
   * Cards whose settle is running right now.
   *
   * `settledAtDone` is marked on COMPLETION, deliberately — a settle that dies
   * partway must be retryable. That leaves a check-then-set window across every
   * yield in between, and the `board.refreshPullRequest` RPC is not serialised
   * through the reactor's worker, so two card opens really can be in that
   * window together and both run the cleanup. This closes it: the test and the
   * add below are synchronous, so no yield separates them.
   */
  const settlingAtDone = new Set<string>();

  /**
   * Give a finished card its disk back: reclaim the worktree, then delete the
   * branches.
   *
   * Runs when a card is in the done-role stage AND its pull request is merged.
   * Both halves are gated on `merged` because that is what makes them safe —
   * the commits already live in the base branch, so neither the checkout nor
   * the branch holds anything that exists nowhere else.
   *
   * THE ORDER IS THE POINT. `deleteCardBranch` refuses to delete a local
   * branch a worktree still has checked out, and until this ran second that
   * refusal was the NORMAL outcome — every finished card left its local
   * `board/*` branch behind, permanently: archive reclaims a worktree but
   * never deletes branches, so nothing came along later to collect it.
   * Reclaiming first means the branch is unheld by the time the delete is
   * attempted, so the worktree and the local branch go together, in one move.
   *
   * Best-effort throughout, both halves. A card that cannot reach Done because
   * a `git push --delete` failed is broken; a branch that outlives its card is
   * merely untidy.
   */
  const settleCardAtDone = Effect.fn("board-supervisor-settleCardAtDone")(function* (
    card: BoardCard,
  ) {
    if (card.pullRequest === null || card.pullRequest.state !== "merged") return;
    const board = yield* readBoard;
    const stage = boardStageById(board, card.stage);
    if (stage === null || effectiveBoardStageRole(stage) !== "done") return;
    // Settling hangs off the pull-request refresh, and a refresh fires every
    // time anyone OPENS the card — so without a guard a card sitting in Done
    // would re-run `git push --delete` on an already-deleted branch and append
    // another "Deleted branch…" row to its activity rail on every single open.
    //
    // Deliberately NOT gated on the worktree still being `ready`. That would
    // read as a durable guard and is not one: the two paths that keep a `ready`
    // worktree at Done (`reclaimWorktreeOnDone` off, and a reclaim refused for
    // a dirty tree) are exactly the paths that would then never have their
    // branches deleted at all, and a card whose worktree was reclaimed earlier
    // — at archive, before being unarchived — would silently lose its cleanup
    // too. The reclaim's own `ready` check keeps THAT half idempotent; this set
    // keeps the branch half idempotent.
    //
    // In memory, following `mergeAwaitingConflictFix`. After a restart a card
    // still sitting in Done can settle once more, which costs one idempotent
    // cleanup attempt — the remote delete reports "remote ref does not exist"
    // and is treated as success — rather than an unbounded stream of them.
    const round = boardCardRound(card);
    if (settledAtDone.get(String(card.id)) === round) return;
    // Both checks and the add are synchronous — nothing yields between them —
    // so a concurrent caller cannot slip through into the same settle.
    if (settlingAtDone.has(String(card.id))) return;
    settlingAtDone.add(String(card.id));

    // `ensuring`, so a failure anywhere below releases the in-flight marker.
    // Leaking it would wedge the card out of ever settling again in this
    // process — the opposite of what marking on completion is FOR.
    yield* Effect.gen(function* () {
      const settings = yield* boardSettings;
      if (settings.lifecycle.reclaimWorktreeOnDone) {
        // Re-assert immediately before the destructive half. Every check above
        // ran against the snapshot this was called with, and there are yields
        // in between — long enough for a human to drag the card straight back
        // out of Done and start round two in that very checkout. Removing it
        // then would delete work that had just begun, and the reclaim's own
        // clean-and-pushed refusal does not cover it: a checkout can be clean
        // and pushed and still be the one an agent is about to write to.
        //
        // Re-asserted on the ROUND, not on the stage. Re-reading the stage
        // would contradict the rule `handleCardMoved` states — the move event's
        // payload is the authority for where a card is, precisely because the
        // read model may not have caught up — so a lagging read would cancel
        // legitimate reclaims. The round index has no such ambiguity: it only
        // ever advances, and it advances on exactly the move being guarded
        // against.
        const current = yield* readCard(card.id);
        if (current !== null && boardCardRound(current) === round) {
          yield* reclaimCardWorktree(current);
        }
      }
      // Re-read: the reclaim just changed the card's worktree state, and branch
      // cleanup asks whether a worktree still holds the branch.
      const reclaimed = yield* readCard(card.id);
      yield* cleanupBranchOnDone(reclaimed ?? card);
    }).pipe(Effect.ensuring(Effect.sync(() => settlingAtDone.delete(String(card.id)))));
    // "Settled" means THIS ROUND HAS HAD ITS ATTEMPT — not "achieved
    // everything". Both halves above swallow their own errors, so control
    // reaches here whatever they managed: a reclaim refused for a dirty tree
    // and a `git push --delete` that failed on a network blip both count.
    //
    // That is deliberate rather than a gap. Nothing in this process can clean a
    // dirty tree, so re-attempting on every card open would re-report a refusal
    // the card is already displaying; and a cleanup that failed has already
    // said so on the card's activity rail, which is where a human looks. The
    // retry paths are the honest ones: the round index moves when the card next
    // leaves Done carrying a pull request, giving that round its own attempt,
    // and archive reclaims unconditionally — still subject to the same
    // never-delete-uncommitted-work refusal.
    settledAtDone.set(String(card.id), round);
  });

  /**
   * Cards whose human-initiated merge is waiting on a conflict fix.
   *
   * The merge stage runs nothing on entry, but a human CAN start a thread there
   * by hand (the card's stage-restart menu). Without this set, that thread
   * reporting success would merge the pull request — a merge nobody asked for,
   * which is the one thing this design refuses to do. An entry is added only
   * when a Merge click hits a conflict, and consumed by the step that resolves
   * it.
   *
   * In-memory deliberately. After a restart the set is empty, so a conflict
   * step that finishes across a restart does NOT auto-merge and the human
   * clicks Merge again — the conservative direction, and the only one
   * consistent with "no merge happens that a human did not initiate".
   */
  const mergeAwaitingConflictFix = new Set<string>();

  /** Drop a card's pending merge. Called from every path that ends a conflict
      fix WITHOUT the success that would complete the merge — settlement,
      recovery escalation and spawn failure — because each of those hands the
      card back to a human, and only a human may start a merge. */
  const disarmPendingMerge = (cardId: BoardCardId): void => {
    mergeAwaitingConflictFix.delete(String(cardId));
  };

  /**
   * Whether a forge refusal is a MERGE CONFLICT rather than a policy block.
   *
   * The distinction drives two very different responses — start an agent to
   * resolve it, or stop and tell the human — and the cost of the two mistakes
   * is very asymmetric, so this is deliberately NARROW. Mistaking a conflict
   * for a policy block just means the user reads the real reason and clicks
   * again; mistaking a policy block for a conflict spawns an agent to "fix" a
   * branch that has nothing wrong with it, which then merges base into a
   * healthy branch and pushes for no reason.
   *
   * In particular "not mergeable" is NOT a conflict signal: GitHub wraps every
   * refusal in it, failing status checks included. Only phrases that can mean
   * nothing else count.
   */
  const isMergeConflictRefusal = (detail: string): boolean => {
    const text = detail.toLowerCase();
    return (
      text.includes("conflict") ||
      // GitHub's wording when the merge commit cannot be constructed.
      text.includes("cannot be cleanly created") ||
      // The `mergeStateStatus` token, matched with its label so the bare word
      // "dirty" appearing in some other sentence cannot trigger a fix.
      text.includes("mergestatestatus: dirty")
    );
  };

  /**
   * Merge a card's pull request, then advance it — the blue Merge button.
   *
   * Always human-initiated: nothing in the merge stage auto-executes, so no
   * merge ever happens that someone did not ask for. What follows a refusal
   * depends on WHY:
   *
   * - **Conflicts** — start the merge stage's conflict-resolution step. It
   *   runs through the ordinary step machine (slot, timeout, stall detection,
   *   attempt ladder) and reports through `board_complete_step`, which is the
   *   only channel an agent has to say "done, and it worked". On success
   *   `handleStepCompleted` finishes the merge the human already asked for.
   * - **Anything else** (failing checks, missing approvals) — report the
   *   forge's own reason and stop. That block needs a human, so the next
   *   attempt should be a human's too; there is no automatic retry.
   */
  const mergeCardPullRequest = Effect.fn("board-supervisor-mergeCardPullRequest")(function* (
    cardId: BoardCardId,
    /** True when this call is the completion of a conflict fix rather than a
        fresh Merge click. Bounds the conflict→merge cycle (see below). */
    viaConflictFix = false,
  ) {
    const card = yield* readCard(cardId);
    if (card === null) return { outcome: "unknown-card" } as const;

    // Re-check first. This is a cache read, not a guaranteed round trip: the
    // underlying lookup has a 2-minute TTL, so it narrows the staleness window
    // rather than closing it. That is the honest bound, and it is enough —
    // acting on a stale `open` costs a refused merge the user reads and
    // retries, not a wrong merge, because the forge is the one that decides.
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

    // The merge-click staleness gate (t3o-24, D2): the crossing was checked
    // when the card entered this stage, but the human may have PARKED it here
    // while a sibling merged underneath — so the click re-measures. A stale
    // child goes back to the review-role stage (where the sync-base step and
    // the gate round run) instead of merging a diff that was never reviewed
    // against the base it merges into. Skipped when the board has no
    // review-role stage to send it to — there is then no loop to gate with.
    if (fresh.parentCardId !== null && (yield* resolveBaseStale(fresh))) {
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

    const worktree = fresh.worktree;
    const model = yield* snapshotQuery.getCommandReadModel();
    // The card's own worktree when it still has one, else the project root:
    // a reclaimed worktree must not make a card unmergeable.
    const cwd = worktree?.path ?? projectCwd(model, fresh);
    if (cwd === null) return { outcome: "no-workspace" } as const;

    const settings = yield* boardSettings;
    // Resolved from the MERGE-ROLE stage, not from `fresh.stage`. They are the
    // same stage today because of the gate above, but reading the role holder
    // is what makes the strategy the user configured the one that runs —
    // resolving off the card's own stage would silently fall back to squash
    // the moment those two could differ.
    const exec = resolveBoardStageExecution(settings, mergeStage.stageId);
    const strategy = isBoardMergeStageExecution(exec) ? exec.strategy : "squash";

    const failure = yield* pullRequests.merge({ cwd, number: pullRequest.number, strategy }).pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(error)),
    );

    if (failure !== null) {
      const detail = failure.detail;
      if (isMergeConflictRefusal(detail) && !viaConflictFix) {
        // Ask for the stage's own thread: the merge stage resolves to the
        // conflict-resolution prompt in build mode, so this is the conflict
        // step and nothing else can run here.
        //
        // `viaConflictFix` bounds the cycle at ONE automatic attempt per click:
        // this call is itself the completion of a conflict fix, and conflicting
        // again means the fix did not work. Starting another step there would
        // loop a pair of agents against a branch that keeps re-conflicting,
        // burning provider capacity with nobody watching. Fall through to
        // `refused` instead, so the card says so and waits for a human.
        // Reporting `conflict` puts the card into "Resolving conflicts…" and
        // DISABLES the Merge button, so it must only ever be said when a fix
        // will actually run. Two checks, because a kickoff can fail in two
        // very different places:
        //
        //  - Up front, against the guards `beginStageRun` applies AFTER the
        //    command has already landed. Those are silent `return`s, not
        //    failures, so nothing downstream can report them — a card with a
        //    hand-started thread on this stage would otherwise sit disabled
        //    forever, claiming work that never started.
        //  - `dispatchLanded` for a decider rejection (an archived card).
        //
        // Either way: disarm and report the refusal, which leaves the button
        // live so the human can act.
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
        mergeAwaitingConflictFix.add(String(fresh.id));
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
      return { outcome: "refused" as const, detail };
    }

    // Record the merged state before moving, so a card arriving at Done is
    // already known to be merged — which is what the branch cleanup gates on.
    yield* refreshCardPullRequest(fresh);
    const merged = (yield* readCard(cardId)) ?? fresh;

    // Pull the just-merged commits into the LOCAL base branch of the project
    // ROOT checkout (not `cwd`, which may be the card's worktree). The merge ran
    // on the forge, so the clone new worktrees fork from is now behind; without
    // this the next card branches off pre-merge history. Best-effort and
    // fast-forward-only — a base we can't cleanly advance is a staleness the
    // next fetch fixes, never a reason to fail a merge that already landed.
    const root = projectCwd(model, fresh);
    const baseBranch = merged.pullRequest?.baseRef ?? null;
    if (root !== null && baseBranch !== null) {
      yield* pullMergedBaseBranch({ git, cwd: root, baseBranch }).pipe(
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
    const nextStage = boardNextStageId(board, merged.stage);
    if (nextStage !== null) {
      yield* dispatch({
        type: "board.card.move",
        commandId: yield* commandId("merge-advance"),
        cardId: merged.id,
        toStage: nextStage,
        orderKey: merged.orderKey,
        createdAt: yield* nowIso,
      });
    }
    return { outcome: "merged" as const, number: pullRequest.number };
  });

  const handleTurnCompleted = Effect.fn("board-supervisor-handleTurnCompleted")(function* (
    threadId: ThreadId,
  ) {
    const board = yield* readBoard;
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
    const shell = yield* snapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    // Another turn is already live on the thread — typically the recovery
    // nudge `handleStepCompleted` sent for a `failed` completion moments
    // before this turn.completed arrived. The thread is not dead; the live
    // turn's own completion will re-run this test.
    if (shell !== undefined && shell.session !== null && shell.session.activeTurnId !== null) {
      if (!shell.hasPendingUserInput) return;
    }
    if (shell !== undefined && shell.hasPendingUserInput) {
      // A proper structured question — "Input needed", not a failure, no retry
      // consumed (D13). Move (or keep) the step on the human gate. A no-op when
      // it is already awaiting-input.
      if (found.state.status === "running") {
        yield* dispatch({
          type: "board.card.await-step-input",
          commandId: yield* commandId("await-input"),
          cardId: found.card.id,
          stepId: found.state.stepId,
          reason: "question",
          createdAt: yield* nowIso,
        });
      }
      return;
    }
    // A human-in-the-loop run that ends a turn without completing is WAITING on
    // the human, not dead (D5): no drop monitoring, no recovery, no attempt
    // consumed, no slot released. But it is NOT running either, and until t3o-34
    // this arm said nothing at all — so the step stayed `running`, the shell's
    // `stepRunning` stayed true, and the card pulsed its blue "being worked" dot
    // for as long as it sat there. The agent had stopped.
    //
    // So park it, and say which kind of stop it was (D1/D3). The envelope asks
    // agents to raise blockers through the structured mechanism and forbids
    // ending a turn with a question in prose; they do it anyway, most of all in
    // planning, where a question with a paragraph of consequence per option is a
    // poor fit for a picker. Reading the last message is how the board stops
    // depending on an instruction that does not hold.
    if (found.state.humanInLoop) {
      // Already parked and still parked: re-deciding the reason would churn a
      // delta per turn.completed for no change.
      if (found.state.status === "awaiting-input") return;
      yield* dispatch({
        type: "board.card.await-step-input",
        commandId: yield* commandId("await-input"),
        cardId: found.card.id,
        stepId: found.state.stepId,
        reason: (yield* endedWithQuestion(found.state)) ? "question" : "stopped",
        createdAt: yield* nowIso,
      });
      return;
    }
    // Unattended, running with no question → died mid-work. Awaiting-input with
    // no pending question → the human answered and the agent ran another turn
    // without completing (or died); either way death detection is re-armed.
    yield* recoverStep(found);
  });

  const handleStepCompleted = Effect.fn("board-supervisor-handleStepCompleted")(function* (
    event: Extract<OrchestrationEvent, { type: "board.card-step-completed" }>,
  ) {
    const completion = event.payload.completion;
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === completion.cardId);
    const state = boardCardStepState(board, completion.cardId);
    if (card === undefined || state === null || state.stepId !== completion.stepId) return;
    if (isBoardTerminalStepStatus(state.status)) return; // idempotent: already settled
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
        // The conflict-resolution step reporting success finishes the merge the
        // human already asked for. Gated on the pending-merge set, NOT merely
        // on the stage: a thread a human restarted by hand in this stage must
        // not merge anything. This is not auto-merge — every merge it can
        // complete was initiated by a Merge click that hit a conflict.
        //
        // A sub-board child carries that authorisation permanently (t3o-28, D3
        // — the same carve-out `autoMergeChild` and `beginStageRun` apply), so
        // it does not need the arm. Without this, a conflict fix that succeeds
        // across a server restart — the set is in-memory — falls through to
        // `continueStage`, and the merge stage's `autoAdvance` is off by
        // design, so the child strands at Merge with its conflicts resolved and
        // nothing left that would ever merge it.
        //
        // `delete` is the consumption, and it is the FIRST operand so a child
        // never short-circuits past it: a stale arm left behind would be
        // consumed by some later merge-stage step and turn into a merge nobody
        // asked for. It stays behind the role test, so no other stage's step
        // completing can clear a merge stage's arm.
        if (
          stageRole === "merge" &&
          (mergeAwaitingConflictFix.delete(String(card.id)) || card.parentCardId !== null)
        ) {
          // Release this fix's thread before anything else. Its link's role is
          // the stage id, which is exactly what `hasLiveStageThread` refuses to
          // trample — so leaving it live means the NEXT Merge click on a branch
          // that conflicts again opens nothing at all, while the card still
          // says it is resolving conflicts. The fix is finished with its thread
          // either way: the merge either lands (and the card graduates) or it
          // does not (and the human clicks Merge again).
          if (state.threadId !== null) {
            yield* dispatch({
              type: "board.card.unlink-thread",
              commandId: yield* commandId("unlink-conflict-fix"),
              cardId: card.id,
              threadId: state.threadId,
              createdAt: yield* nowIso,
            });
            yield* dispatchOptional({
              type: "thread.settle",
              commandId: yield* commandId("settle-conflict-fix"),
              threadId: state.threadId,
            });
          }
          yield* schedule();
          // The human clicked Merge, watched it say "resolving conflicts", and
          // is not watching the server log. If this completion does not
          // actually merge — the fix landed but the branch conflicts again, or
          // the forge now refuses for some other reason — the card has to say
          // so, or the Merge click ends in nothing at all.
          const outcome = yield* mergeCardPullRequest(card.id, true);
          if (outcome.outcome !== "merged") {
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
        // Ask the stage executor what runs next (t3o-16): a single-step stage
        // reports `complete` and this auto-advances to the next stage in order
        // on a successful unattended run (D8), re-triggering auto-kickoff there;
        // a multi-step stage (the review loop) selects its next round-scoped
        // step here instead. Then let the freed slot flow to the queue.
        yield* continueStage({ card, state });
        yield* schedule();
        return;
      case "failed":
        // A clean failure report still enters recovery (D4): retry or escalate.
        yield* recoverStep({ card, state });
        return;
      case "blocked":
        // The agent needs a human (D13): park the step on the gate.
        yield* dispatch({
          type: "board.card.await-step-input",
          commandId: yield* commandId("await-input"),
          cardId: card.id,
          stepId: state.stepId,
          // An agent that reported `blocked` asked for a human by name.
          reason: "question",
          createdAt: yield* nowIso,
        });
        return;
    }
  });

  /**
   * A step's thread asked a human a question (t3o-18, D13). Moving the step to
   * `awaiting-input` is what stops a card waiting on a human from being counted
   * as stalled.
   *
   * RE-SOURCED, not removed: this used to react to the `board.card-input-requested`
   * domain event that the deleted `board_request_input` tool produced. It now
   * reacts to the runtime `user-input.requested` event on the stream the reactor
   * already consumes, resolving the card from the emitting thread. That is
   * strictly more complete than what it replaces, because it fires for EVERY
   * input request rather than only the ones an agent remembered to double-report
   * — an agent that asked normally and skipped the tool used to leave the board
   * blind, which was the actual failure mode.
   */
  const handleInputRequested = Effect.fn("board-supervisor-handleInputRequested")(function* (
    threadId: ThreadId,
  ) {
    const board = yield* readBoard;
    const watched = stepThreadCard(board, threadId);
    if (watched === null || watched.state.status !== "running") return;
    yield* dispatch({
      type: "board.card.await-step-input",
      commandId: yield* commandId("await-input"),
      cardId: watched.card.id,
      stepId: watched.state.stepId,
      reason: "question",
      createdAt: yield* nowIso,
    });
  });

  // Mid-run human-in-the-loop toggle (D5/D6): when the per-card Build toggle is
  // flipped on a card with a non-terminal step, retune the run row so
  // drop-monitoring and auto-advance honour the new stance, and — if the step
  // has a LIVE thread — send a turn into it (the `/unattended` stance switching
  // to unattended, the question-friendly stance switching back). A queued or
  // pending step has no thread yet, so it only needs the frozen stance updated;
  // the flip would otherwise be lost before the step admits and spawns. Slot,
  // worktree and thread are untouched. Only an EXPLICIT toggle
  // (`card.humanInLoop` non-null and different from the frozen stance) reacts,
  // so an unrelated card edit never flips a run.
  const handleCardUpdated = Effect.fn("board-supervisor-handleCardUpdated")(function* (
    event: Extract<OrchestrationEvent, { type: "board.card-updated" }>,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
    const state = boardCardStepState(board, event.payload.cardId);
    if (card === undefined || state === null) return;
    // A SETTLED stage may have more to run after an edit (t3o-22, D6). The
    // review loop is why: a loop held at its round cap is terminal, and raising
    // the card's budget from the pane must make it plan the next round — but
    // nothing else in the reactor would ever ask again.
    //
    // Deliberately role-AGNOSTIC. An `if (stage.role === "review")` here would
    // be the first leak of review logic into the reactor and would break
    // t3o-16 AC10, so this asks whatever executor the stage has and acts ONLY
    // on a `run` plan. `SimpleStageExecutor` sees its one step recorded and
    // plans `complete`, so a non-review stage is untouched — and a `complete`
    // plan must stay a no-op here regardless, because re-running the advance
    // path from an edit is exactly the double-advance this must not cause.
    // Only a SUCCEEDED settle can have more to run. A terminal-but-unsuccessful
    // step (`abandoned`, `stalled`, `failed`) is not a stage waiting on budget,
    // and re-planning one is actively dangerous: `SimpleStageExecutor` decides
    // from *succeeded* completions alone, so a card carrying an `abandoned`
    // step at an auto-executing stage plans a fresh `run` — and a title edit
    // would spawn a full stage run. Before this path existed, nothing happened.
    if (isBoardTerminalStepStatus(state.status)) {
      if (state.status !== "succeeded") return;
      return yield* replanSettledStage(card);
    }
    const stage = boardStageById(board, card.stage);
    const desired =
      stage?.role === "build" ? (card.humanInLoop ?? state.humanInLoop) : state.humanInLoop;
    if (desired === state.humanInLoop) return;
    if (state.threadId !== null) {
      const text = desired
        ? `Switching to human-in-the-loop: ask me anything you need directly, and it is fine to end a turn waiting on my answer. Call board_complete_step when the work is done.`
        : `Switching to unattended: do not stop to ask permission — make every reasonable decision yourself and proceed. Call board_complete_step when the step is finished; if you are truly blocked, ${BOARD_ENVELOPE_QUESTION_MECHANISM}, and never end a turn with an unanswered question in prose.`;
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

  const handleArchived = Effect.fn("board-supervisor-handleArchived")(function* (
    event: Extract<OrchestrationEvent, { type: "board.card-archived" }>,
  ) {
    const board = yield* readBoard;
    // Reap the settle marker whether or not the card is still readable: an
    // archived card is done being settled, and an entry that outlives its card
    // is a leak the process never gets back.
    settledAtDone.delete(String(event.payload.cardId));
    const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
    if (card === undefined) return;
    const state = boardCardStepState(board, event.payload.cardId);
    if (state !== null && !isBoardTerminalStepStatus(state.status)) {
      yield* settleStep({ card, state, outcome: "abandoned" });
      // The abandoned step released its slot — offer it to whatever is queued.
      yield* schedule();
    }
    // Reclaim the card's worktree at archive (t3o-09, D6/D15) — without this,
    // every archived card leaks its worktree and `board/*` branch on disk.
    //
    // UNCONDITIONAL, and it reads no setting on purpose. Archive is the
    // guaranteed cleanup point: `reclaimWorktreeOnDone` chooses whether a card
    // is reclaimed EARLIER, at Done, and never whether it is reclaimed at all.
    // A worktree may not outlive its card.
    yield* reclaimCardWorktree(card);
    // An archived child counts as finished (t3o-23, D6), so this may have
    // been the parent's last unfinished one — or the one whose finishing
    // unblocks a sibling still waiting on the floor (t3o-28, D3).
    if (card.parentCardId !== null) {
      yield* cascadeUnblockedChildren(card.parentCardId);
      yield* advanceParentIfChildrenDone(card.parentCardId);
    }
  });

  /**
   * A card was DELETED — the destructive follow-through archive never does.
   *
   * The card itself comes entirely from the event payload: it left the read
   * model and its rows left the tables in the same transaction that produced
   * this event, so nothing about the card can be looked up any more. The one
   * board read is for the project's workspace root (`projectCwd`) — the project
   * outlives its cards, so it is still there — which the git work needs as its
   * cwd.
   *
   * The order is deliberate. Threads go first, so the agents writing into the
   * worktree are stopped before it is pulled out from under them. The worktree
   * goes next, FORCED — the normal clean-and-pushed refusal exists to protect
   * work the user might still want, and the user has just said, at a dialog
   * that spells it out, that they do not. The branches go last, because
   * `deleteCardBranch` refuses a local branch a worktree still holds and the
   * reclaim is what unholds it.
   *
   * Every step is best-effort and reports only to the log. There is no card to
   * put an activity row on, and there is no useful way to fail: the card is
   * already gone from the user's board, so an error here can only be tidied up
   * by hand, never retried.
   */
  const handleCardDeleted = Effect.fn("board-supervisor-handleCardDeleted")(function* (
    event: Extract<OrchestrationEvent, { type: "board.card-deleted" }>,
  ) {
    const card = event.payload.card;
    // Per-card in-memory bookkeeping outlives the card unless it is reaped
    // here — each entry is a leak the process never gets back.
    settledAtDone.delete(String(card.id));
    disarmPendingMerge(card.id);
    // Release the slot the card's step held. NOT a `board.card.settle-step`
    // dispatch: that command requires the card to exist, and it does not any
    // more. The step state was frozen into the payload for exactly this — the
    // slot count is in-memory, so nothing else could ever recover it and the
    // board would run one step short of its ceiling for the rest of the
    // process's life.
    const stepState = event.payload.stepState;
    if (stepState !== null) yield* releaseSlot(stepState);

    for (const threadId of event.payload.threadIds) {
      yield* dispatch({
        type: "thread.delete",
        commandId: yield* commandId("delete-card-thread"),
        threadId,
      });
    }

    // The brief's files go with the card (t3o-32, K1): board-owned storage,
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
      const model = yield* snapshotQuery.getCommandReadModel();
      const cwd = projectCwd(model, card);
      if (cwd !== null) {
        if (worktree.status === "ready" && worktree.path !== null) {
          yield* reclaimBoardCardWorktree({
            projectCwd: cwd,
            worktreePath: worktree.path,
            force: true,
          }).pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, git),
            Effect.catchCause((cause) =>
              Effect.logWarning("board supervisor: worktree removal on card delete failed", {
                cardId: card.id,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }
        // Attempted whatever the worktree's state — a card can carry a branch
        // whose worktree was already reclaimed (at an earlier archive, or at
        // Done), and that branch is exactly the one nothing else will collect.
        yield* deleteCardBranch({ git, cwd, branch: worktree.branch }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("board supervisor: branch cleanup on card delete failed", {
              cardId: card.id,
              branch: worktree.branch,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
    }

    // The released slot is capacity the board can hand to whatever is queued.
    yield* schedule();

    // Deleting a child removes it from the parent's unfinished set (t3o-23,
    // D4) — which may release a sibling that depended on it (t3o-28, D3), and
    // if it was the last one standing, advances the parent (the helper itself
    // refuses when NO children remain: an emptied split waits for the human).
    if (card.parentCardId !== null) {
      yield* cascadeUnblockedChildren(card.parentCardId);
      yield* advanceParentIfChildrenDone(card.parentCardId);
    }
  });

  // The split's integration branch (t3o-23, D5): create it — branch only, no
  // worktree, no setup script — so the first child to begin building has a
  // base to cut from, and push it so child pull requests have a remote
  // target. Effect-then-record, like every worktree mutation: the git work
  // happens first, `record-integration-branch` reports it. A failed PUSH is a
  // note, not a failure — a local-only project still builds and reviews
  // locally, and the missing remote base surfaces at the child's review step
  // with the forge CLI's own words (the t3o-20 stance).
  //
  // IDEMPOTENT and multi-entry: approval fires it, and any child whose base
  // resolution finds no parent branch fires it again (`ensureWorktree`), so a
  // reactor that was down at approval — or a transient git failure — heals on
  // the next build attempt instead of stranding the split. A parent whose
  // slice says the branch is live (`branch-only` / `provisioning` / `ready`)
  // is left alone — its branch exists and IS the integration branch — while
  // `failed` and `reclaimed` proceed: a failed attempt retries, and a
  // reclaimed slice is a SECOND-ROUND split (a merged parent dragged back and
  // re-approved) whose old branch was deleted at Done and needs a fresh one.
  const ensureIntegrationBranch = Effect.fn("board-supervisor-ensureIntegrationBranch")(function* (
    card: BoardCard,
  ) {
    if (
      card.worktree !== null &&
      card.worktree.status !== "failed" &&
      card.worktree.status !== "reclaimed"
    ) {
      return;
    }
    const model = yield* snapshotQuery.getCommandReadModel();
    const cwd = projectCwd(model, card);
    if (cwd === null) {
      yield* failWorktree(card, "The card's project has no workspace folder on this server.");
      return;
    }
    const branch = boardCardWorktreeBranchName(card);
    const gitRef = (args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "boardIntegrationBranch.ref",
          cwd,
          args: [...args],
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
          Effect.catchCause(() => Effect.succeed("")),
        );
    const { defaultBranch } = yield* resolveDefaultBranch(cwd);
    if (defaultBranch === "") {
      yield* failWorktree(
        card,
        `Could not resolve a default branch in ${cwd} to cut the integration branch from.`,
      );
      return;
    }
    // Idempotent on retry: an existing branch is the desired state, not an
    // error (an earlier attempt may have created it and died before the
    // record landed).
    const exists = yield* gitRef(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists === "") {
      const created = yield* git
        .execute({
          operation: "boardIntegrationBranch.create",
          cwd,
          args: ["branch", branch, defaultBranch],
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("board supervisor: integration branch creation failed", {
              cardId: card.id,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
          ),
        );
      if (created === null || created.exitCode !== 0) {
        // A raced sibling (two children retrying at once) may have created the
        // branch between the check above and this create — `git branch` then
        // exits non-zero with "already exists". Re-check rather than treat it
        // as fatal: an existing branch IS the desired state (idempotent).
        const nowExists = yield* gitRef([
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);
        if (nowExists === "") {
          yield* failWorktree(
            card,
            `Could not create the integration branch '${branch}' from '${defaultBranch}'.`,
          );
          return;
        }
      }
    }
    const pushed = yield* git.resolvePrimaryRemoteName(cwd).pipe(
      Effect.flatMap((remoteName) =>
        git.execute({
          operation: "boardIntegrationBranch.push",
          cwd,
          args: ["push", remoteName, branch],
          timeoutMs: 60_000,
          allowNonZeroExit: true,
        }),
      ),
      Effect.map((result) => result.exitCode === 0),
      Effect.catch(() => Effect.succeed(false)),
    );
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
      baseRefName: defaultBranch,
      createdAt: yield* nowIso,
    });
  });

  const handlePlansApproved = Effect.fn("board-supervisor-handlePlansApproved")(function* (
    event: Extract<OrchestrationEvent, { type: "board.plans-approved" }>,
  ) {
    yield* ensureIntegrationBranch(event.payload.card);
    // Approval normally leaves the parent short of build (t3o-28, D1), and the
    // cascade waits for its later move into the build stage (D3). But approving
    // a split on a parent ALREADY sitting at build (legal — a card built
    // conversationally can be split before its build starts in earnest) emits
    // no move, so that trigger never comes. Nudge the cascade here: the helper
    // no-ops unless the parent is at the build stage, so the ordinary
    // approve-from-planning path pays nothing and only this one path starts.
    yield* cascadeUnblockedChildren(event.payload.card.id);
  });

  // A card was created (D10): if it landed in an auto-executing stage, kick off
  // exactly as a drag would. The created payload is flat, so re-read the card.
  const handleCardCreated = Effect.fn("board-supervisor-handleCardCreated")(function* (
    event: Extract<OrchestrationEvent, { type: "board.card-created" }>,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
    if (card === undefined) return;
    // A sub-board child materialised by `board.plans.approve` (t3o-23, D3/D18)
    // must NOT auto-start on arrival, even if its floor stage auto-executes:
    // approving a split is one human act and cannot fan out into N running
    // agents. Each child's build is a deliberate later "Begin build" — a drag
    // (`board.card-moved`) which DOES kick off. The decider cannot enforce
    // this (it has no settings, D8), so the reactor does, keyed on the child's
    // `parentCardId`. An ordinary card created straight into an auto stage
    // (D10) has no parent and still kicks off here.
    if (card.parentCardId !== null) return;
    yield* beginStageRun({ card, onDemand: false });
  });

  // A card crossed into a new stage (drag, or an auto-advance). The card holds
  // ONE step-state row, and until this move nothing has selected a step for the
  // destination — so any non-terminal step still on the row is a LEFTOVER from
  // the stage the card just left (a run that stalled or was mid-flight in the
  // old stage; auto-advance settles its step before moving, so a legitimate
  // continuation is already terminal here). That leftover otherwise reads to
  // the auto-kickoff guard as "a live step for the current stage" and blocks
  // the destination's run — the card lands in the new stage with no thread,
  // which is exactly the "moved to planning, no thread" report. Abandon it
  // first (releasing any slot and unlinking its thread), then kick off the
  // destination stage on a fresh read so its own guards see a clean card.
  const handleCardMoved = Effect.fn("board-supervisor-handleCardMoved")(function* (
    event: Extract<OrchestrationEvent, { type: "board.card-moved" }>,
  ) {
    // The destination stage and the current link set both come from the event
    // payload, not a board re-read: the card carries its post-move stage here,
    // which is the one authority every other move path already trusts.
    const card = event.payload.card;
    const board = yield* readBoard;
    // ── The review→merge crossing gate (t3o-24, D2) ────────────────────────
    // A sub-board child ARRIVING at the merge-role stage on a forward move —
    // the auto-advance that raced a sibling's merge, or a human drag — is
    // checked against its recorded round-start tip. Stale sends it straight
    // back to the review-role stage, where `beginStageRun`'s plan enqueues the
    // sync-base step and the gate round: the merge-role stage means "reviewed
    // and ready", and a card whose base moved under its reviewed diff is
    // neither. The early return leaves any live step alone — the card is
    // going back to the stage that owns it.
    {
      const toStage = boardStageById(board, event.payload.toStage);
      const reviewStage = boardStageWithRole(board, "review");
      const fromIndex = boardStageIndex(board, event.payload.fromStage);
      const toIndex = boardStageIndex(board, event.payload.toStage);
      if (
        card.parentCardId !== null &&
        toStage !== null &&
        effectiveBoardStageRole(toStage) === "merge" &&
        reviewStage !== null &&
        fromIndex >= 0 &&
        toIndex > fromIndex &&
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
    const existing = boardCardStepState(board, card.id);
    let kickoffCard = card;
    if (existing !== null && !isBoardTerminalStepStatus(existing.status)) {
      yield* settleStep({ card, state: existing, outcome: "abandoned" });
      if (existing.threadId !== null) {
        yield* dispatch({
          type: "board.card.unlink-thread",
          commandId: yield* commandId("unlink-moved"),
          cardId: card.id,
          threadId: existing.threadId,
          createdAt: yield* nowIso,
        });
        // Stop the abandoned thread's turn: a leftover step can be genuinely
        // mid-flight (a stuck-running provider, or a build run the human dragged
        // away from), and settling the row does not touch the agent. Left alone
        // it keeps burning provider capacity and — for a build-mode leftover —
        // keeps writing the worktree while the destination stage spawns a second
        // thread, breaking the one-writer invariant. Best-effort, like every
        // other orphan interrupt (the dispatch helper swallows a reject).
        yield* interruptOrphan(existing.threadId);
        // Reflect the unlink onto the card handed to the kickoff: `beginStageRun`
        // reads the links to decide whether a live stage thread already exists,
        // and the leftover link we just tombstoned (its role is the old step id
        // — the destination stage itself on a re-entry) would otherwise trip
        // that guard against the very thread we are abandoning.
        kickoffCard = {
          ...card,
          threadLinks: card.threadLinks.map((link) =>
            link.threadId === existing.threadId && link.tombstonedAt === null
              ? { ...link, tombstonedAt: event.payload.card.updatedAt }
              : link,
          ),
        };
      }
      // The abandoned step may have held a slot — offer it to the queue.
      yield* schedule();
    }
    // Graduation sweep: the card finished a whole stage and moved to a later
    // one, so settle every thread still linked to it — the just-completed
    // stage's thread plus any earlier one left active — dropping them out of
    // the inbox (the links stay, so the card keeps its tabs). Only on a FORWARD
    // move: a backward drag is a reopen and must leave threads untouched. The
    // leftover in-flight step (if any) was just unlinked above, so the tombstone
    // filter skips it; the destination's fresh thread is not linked yet.
    // Best-effort: a thread still mid-turn is refused by the settle guard and
    // skipped, matching "settle any unsettled threads that are not running".
    const fromIndex = boardStageIndex(board, event.payload.fromStage);
    const toIndex = boardStageIndex(board, event.payload.toStage);
    if (fromIndex >= 0 && toIndex > fromIndex) {
      for (const link of kickoffCard.threadLinks) {
        if (link.tombstonedAt !== null) continue;
        yield* dispatchOptional({
          type: "thread.settle",
          commandId: yield* commandId("settle-graduated"),
          threadId: link.threadId,
        });
      }
    }
    // Refresh trigger: a stage change. The card may have crossed into the
    // merge stage (where the Merge button needs a current PR state) or into
    // Done (where the settle gates on it), and either way this is a moment the
    // answer plausibly changed. The arrival-at-Done case needs no branch of its
    // own: `refreshCardPullRequest` settles the card whenever the refresh
    // leaves it in Done with a merged pull request, which is exactly this.
    yield* refreshCardPullRequest(card, card.stage);

    yield* beginStageRun({ card: kickoffCard, onDemand: false });

    // A sub-board child reaching the merge-role stage merges itself down
    // (see `autoMergeChild`). Deliberately BEFORE the cascade block below
    // rather than left to the move it dispatches: a successful merge advances
    // the card to Done, and running the three sub-board helpers on the far
    // side of that means one arrival resolves the whole chain — merge → Done →
    // the dependency it satisfied → the freed siblings into build — instead of
    // waiting for the Done move to come back around the event loop.
    // One ordinary forward STEP into the merge stage — the pipeline delivering
    // the card — and nothing else. Merging is irreversible, so the two shapes
    // this excludes both matter:
    //
    //  - BACKWARD (a human pulling the card out of Done) is an undo, and
    //    answering an undo by re-merging on the forge is surprising at best.
    //  - A forward JUMP that skipped stages is a human overriding the pipeline
    //    (`override: true` on a non-adjacent drag). Dragging a child from
    //    Building straight onto Merge would otherwise merge a diff no review
    //    round has ever seen.
    //
    // Adjacency rather than "came from the review-role stage": a board with no
    // review stage advances Building → Merge as its ORDINARY path, and keying
    // on the review role would silently disable the sub-board's auto-merge
    // there — breaking the automation on exactly the boards that opted out of
    // reviewing.
    if (
      card.parentCardId !== null &&
      boardStageWithRole(board, "merge")?.stageId === event.payload.toStage &&
      fromIndex >= 0 &&
      toIndex === fromIndex + 1
    ) {
      yield* autoMergeChild(card);
    }

    // A child changing stage may have been the parent's last unfinished one
    // (t3o-23, D4) — the advance helper's own guards make a non-final move a
    // cheap no-op — or the one whose finishing frees a sibling to start
    // (t3o-28, D3). The mirror (t3o-24, D4): the same move may have dragged a
    // child back OUT of Done under a parent that already advanced. Every
    // helper guards itself, so all three are safe to ask every time.
    if (card.parentCardId !== null) {
      yield* cascadeUnblockedChildren(card.parentCardId);
      yield* advanceParentIfChildrenDone(card.parentCardId);
      yield* regressParentIfChildLeftDone(card.parentCardId);
    }
    // The PARENT itself arriving at the build-role stage is the Begin build
    // for the whole split (t3o-28, D3): start every child the plan graph does
    // not block. This is also how the t3o-24 regression back to build
    // restarts a corrected parent's sub-board — the helper is keyed on where
    // the parent now stands, not on how it got there. Gated on the card
    // HAVING children so an ordinary card's every move does not pay a board
    // read to be told it has no sub-board. LIVE children only: a fully-wrapped
    // split (every child archived) can cascade nothing, so it should not pay
    // the helper's own board read to be told so — and `cascadeUnblockedChildren`
    // only ever moves a live child off the floor anyway.
    else if (boardCardChildren(board, card.id).some((child) => child.archivedAt === null)) {
      yield* cascadeUnblockedChildren(card.id);
    }
  });

  // On-demand kickoff request (D7): start a thread for the card's current stage.
  const handleStageThreadRequested = Effect.fn("board-supervisor-handleStageThreadRequested")(
    function* (event: Extract<OrchestrationEvent, { type: "board.card-stage-thread-requested" }>) {
      const board = yield* readBoard;
      const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
      if (card === undefined) return;
      yield* beginStageRun({ card, onDemand: true });
    },
  );

  /**
   * A step whose turn NEVER STARTED (t3o-30, D2).
   *
   * The provider reactor reports this as a `provider.turn.start.failed` activity
   * on the step's thread — the CLI is not installed, the session would not
   * spawn, the instance rejected the model. It is categorically different from a
   * turn that ran and went quiet, which is what the recovery ladder is for:
   * there is no agent to nudge, and no amount of waiting makes one appear, so
   * the ladder would spend `timeoutMs` per rung re-sending turns into a provider
   * that cannot start one. Meanwhile the card renders a spinner for a thread
   * that is already dead — the lying spinner this whole path exists to avoid.
   *
   * So it lands `stalled` immediately, carrying the provider's own error text
   * onto the run row for the card to render, and releases the slot. Stalled is
   * the right terminus rather than `failed`: it is non-terminal and the on-
   * demand restart path already SUPERSEDES a stalled step, so the card's Restart
   * button works with no new command. A merge card additionally gets its Merge
   * button back, because that button is gated on a live step.
   *
   * Never retried automatically, even onto the board's default model. The stage
   * names the model it runs on; silently running the work somewhere else is a
   * worse outcome than saying plainly that the chosen one could not start.
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
    // Already stalled for this same reason: the provider reactor can append the
    // activity more than once for one dead session, and re-landing would inflate
    // `attempt` and double-release the slot.
    if (state.status === "stalled") return;
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
   * A human takes a parked step back over (t3o-17 D3; t3o-34 D5).
   *
   * `stalled` means "nobody is working on this and nobody will until you act" —
   * and sending a turn into the step's own thread IS the human acting. Until
   * now the card kept its stop banner, its reason and its dark dot while the
   * thread it points at was visibly working again; the only things that cleared
   * them were restarting the stage (which throws the conversation away) and the
   * agent completing the step.
   *
   * So a turn requested on a stalled step's thread puts the step back to
   * `running`: the banner and the reason go, the dot re-lights, and supervision
   * resumes on the thread the human just restarted — a turn that ends without
   * completing the step is nudged as usual, and one that never starts re-stalls
   * with the provider's new reason (`failStepAtSpawn`).
   *
   * The same argument holds, word for word, for `awaiting-input` (t3o-34, D5),
   * and it is load-bearing now that the status paints the card: a step parked
   * for a question would otherwise keep asking for an answer the human has
   * already given, which is the same lie in the other direction. It also closes
   * a hole that predates this change — a step parked by the STRUCTURED question
   * path never returned to `running` either; it was invisible only because the
   * card read the thread's flag instead of the step's status.
   *
   * Only from those two. Every other status is either already supervised — the
   * board's own kickoff, nudge and retune turns arrive on this same event — or
   * settled, and neither has anything to resume.
   */
  /**
   * A parked step goes back to work (t3o-17 D3; t3o-34 D5). Exactly two signals
   * reach here, and the pair is deliberate:
   *
   * - `thread.turn-start-requested` (domain) — a turn was ASKED for. The decider
   *   emits it only for `thread.turn.start`, so it means a human or the board
   *   sent a message. This is t3o-17's signal, and it covers every step that
   *   parked between turns: a stall, or a turn that ended with a question in
   *   prose.
   * - `user-input.resolved` (runtime) — a structured question was ANSWERED.
   *   That question is raised from INSIDE a running turn (the adapter's
   *   `canUseTool` path) and answering it merely resolves the deferred the turn
   *   is blocked on, so the same turn carries on: no turn is ever asked for and
   *   none starts. This is the only signal that sees it.
   *
   * The runtime's `turn.started` is deliberately NOT one of them, though it
   * looks like it belongs. Adapters synthesise it for assistant activity that
   * arrives with no active turn (`ClaudeAdapter`, background/subagent output
   * between prompts) — nobody sent anything. Resuming on that would clear the
   * card's badge with no human involved, and on a `stalled` step it would be
   * worse: `resume-step` zeroes `stallCount` and re-arms the timeout sweep, so a
   * t3o-17 escalation that is supposed to stop until a human acts would quietly
   * un-escalate itself. It also buys nothing the two signals above do not
   * already cover, at the cost of a worker item for every turn start of every
   * thread on the box.
   *
   * Both funnel through here, so whichever arrives second finds the step already
   * `running` and does nothing.
   */
  const resumeParkedStep = Effect.fn("board-supervisor-resumeParkedStep")(function* (
    threadId: ThreadId,
  ) {
    const board = yield* readBoard;
    const found = stepThreadCard(board, threadId);
    if (found === null) return;
    if (found.state.status !== "stalled" && found.state.status !== "awaiting-input") return;
    if (found.card.archivedAt !== null) return;
    yield* dispatch({
      type: "board.card.resume-step",
      commandId: yield* commandId("resume-step"),
      cardId: found.card.id,
      stepId: found.state.stepId,
      createdAt: yield* nowIso,
    });
  });

  const handleTurnStartRequested = Effect.fn("board-supervisor-handleTurnStartRequested")(
    function* (event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>) {
      yield* resumeParkedStep(event.payload.threadId);
    },
  );

  const reconcile = Effect.gen(function* () {
    // Sweep cached todo rows whose thread or link no longer exists (t3o-18,
    // AC 20). The cache is a projection with no event to un-apply, so a row can
    // outlive its link when a delete lands while the server is down; a single
    // set-difference DELETE at boot is the cheap, total answer. Best-effort — a
    // sweep failure must never block reconciliation of live steps.
    if (boardQueries !== null) {
      yield* boardQueries.boardSweepThreadTodos().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: thread-todo sweep failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    const board = yield* readBoard;
    // Cards whose step reconcile settles as succeeded: `continueStage` may
    // auto-advance them, and the `board.card-moved` that publishes goes into a
    // live-only PubSub whose subscribers are PARKED until server activation
    // (forkParked) — so their auto-kickoff must be re-derived from state at
    // the end of this pass instead of riding the stream.
    const advanced: BoardCard["id"][] = [];
    for (const state of boardNonTerminalStepStates(board)) {
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined) continue;
      const hasSucceeded = boardCardStepCompletions(board, card.id).some(
        (entry) => entry.stepId === state.stepId && entry.outcome === "succeeded",
      );
      const shell =
        state.threadId === null
          ? undefined
          : yield* snapshotQuery
              .getThreadShellById(state.threadId)
              .pipe(Effect.map(Option.getOrUndefined));
      const threadAlive = shell !== undefined && threadIsAlive(shell);
      const decision = reconcileStepDecision({ status: state.status, threadAlive, hasSucceeded });
      // The in-memory slot Ref is empty after a restart, so any step that still
      // holds a slot must RESTORE it here — whether we go on to watch it
      // (resume-watch) or recover it (recover keeps the slot, D13) — otherwise
      // its eventual release would floor at zero and under-count throughput.
      // Restore is unconditional (never rejected by a cap): the step genuinely
      // holds the slot, and this must run before `schedule` admits anything, so
      // the restored steps count against the ceiling the governor then honours.
      if (state.slotHeld && decision.kind !== "advance") {
        yield* slots.restore(state.providerInstanceId);
      }
      switch (decision.kind) {
        case "advance":
          yield* settleStep({ card, state, outcome: "succeeded" });
          // Ask the executor what runs next: advance a finished single-step
          // stage, or resume the next round-scoped step of a multi-step loop
          // whose phase settled during downtime (t3o-16).
          yield* continueStage({ card, state });
          advanced.push(card.id);
          break;
        case "recover":
          yield* recoverStep({ card, state });
          break;
        case "reschedule":
          // Pending/queued and slotless — placed by the final schedule pass
          // below, once every restored running step is counted (D11).
          break;
        case "resume-watch":
          // Still running with a live thread — the slot was restored above; let
          // the live turn-completion path catch its settlement.
          break;
      }
    }
    // With every restored slot counted, offer the queued/pending steps to the
    // governor: re-admit what now fits, re-queue the rest. Slot accounting
    // reconciles to zero once all work drains, including after a forced restart.
    yield* schedule();
    // Kickoff pass for the cards reconcile itself advanced: their card-moved
    // events had no live subscriber (see `advanced` above), so the next
    // stage's auto-kickoff is re-derived from state. `bootPass` restricts it
    // to first entries (or executor-driven continuations) — a re-entry's
    // clean human thread never opens as a restart side effect — and
    // beginStageRun's own guards (autoExecute, live thread, live step) make
    // the pass idempotent.
    if (advanced.length > 0) {
      const settled = yield* readBoard;
      for (const cardId of advanced) {
        const card = settled.cards.find((candidate) => candidate.id === cardId);
        if (card === undefined || card.archivedAt !== null) continue;
        const state = boardCardStepState(settled, card.id);
        if (state !== null && !isBoardTerminalStepStatus(state.status)) continue;
        yield* beginStageRun({ card, onDemand: false, bootPass: true });
      }
    }
    // Settle the cards that finished while this feature did not exist.
    //
    // The settle is normally driven by a pull-request refresh, and refreshes
    // are event-driven — so a card that reached Done before this shipped gets
    // no trigger, ever, and keeps its worktree until somebody archives it by
    // hand. That backlog is the whole reason the feature exists, so it has to
    // be swept once.
    //
    // Cached `merged` ONLY, which is what makes the sweep free: merged is
    // terminal — nothing about that pull request can change again — so the
    // cached value cannot be stale and no lookup is needed. This pass issues
    // ZERO forge calls. Cards still cached `open` are deliberately left for
    // their next ordinary refresh; refreshing them here would be a burst of
    // `gh pr list` proportional to the size of Done on every single restart,
    // which is the periodic polling this design refuses.
    //
    // It must also be SELF-TERMINATING. `settledAtDone` is empty after a
    // restart, so the sweep is the one settle path a restart re-arms; a card it
    // keeps matching gets another branch-cleanup row on its rail and another
    // forge round-trip on every single boot, forever. Two filters retire a card
    // from it permanently, one per way a settle can end:
    //
    //  - The reclaim SUCCEEDED — the worktree is no longer `ready`.
    //  - The reclaim was REFUSED — `reclaimBlockedReason` is set. A dirty or
    //    unpushed tree leaves `status: "ready"` on purpose (the card keeps its
    //    worktree, and says why), so without this the blocked card would match
    //    for ever. It is also the right answer on its own terms: nothing here
    //    can clean that tree, so re-attempting it every boot only re-reports a
    //    refusal the card is already displaying.
    //
    // The setting gate is the third: with reclaim off there is no disk backlog
    // to clear, and clearing it is the only thing this sweep is for.
    const settings = yield* boardSettings;
    if (settings.lifecycle.reclaimWorktreeOnDone) {
      const finished = yield* readBoard;
      for (const card of finished.cards) {
        if (card.archivedAt !== null) continue;
        if (card.worktree === null || card.worktree.status !== "ready") continue;
        if (card.worktree.reclaimBlockedReason !== null) continue;
        if (card.pullRequest === null || card.pullRequest.state !== "merged") continue;
        yield* settleCardAtDone(card);
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: reconciliation failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const processDomainEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "board.card-moved":
        // Generic auto-kickoff (D7): a card landing in ANY stage may start a run
        // — not just Building. The stage's `autoExecute` setting gates it. The
        // handler first clears any leftover step from the stage the card left,
        // so a card carrying a stalled/in-flight step still starts the new one.
        return handleCardMoved(event);
      case "board.card-created":
        // Creating a card straight into an auto-executing stage is a real path
        // now (D10) and must behave identically to a drag.
        return handleCardCreated(event);
      case "board.card-stage-thread-requested":
        // On-demand kickoff (D7), the counterpart of auto-kickoff.
        return handleStageThreadRequested(event);
      case "board.card-updated":
        return handleCardUpdated(event);
      case "board.card-step-completed":
        return handleStepCompleted(event);
      case "board.card-archived":
        return handleArchived(event);
      case "board.card-deleted":
        return handleCardDeleted(event);
      case "board.plans-approved":
        // The split's integration branch (t3o-23, D5).
        return handlePlansApproved(event);
      case "thread.turn-start-requested":
        // A human restarting a stalled step by hand (t3o-17, D3) — the board's own
        // turns land here too and no-op, since only a `stalled` step resumes.
        return handleTurnStartRequested(event);
      case "thread.activity-appended":
        // The other non-board event the supervisor listens to (t3o-30, D2): a
        // step's turn failing to start at all. Everything else about a thread
        // reaches the board through its own turn completion; this failure has no
        // turn to complete, so without it the step holds a slot and renders a
        // spinner until the timeout sweep eventually notices, `timeoutMs` later.
        return event.payload.activity.kind === "provider.turn.start.failed"
          ? failStepAtSpawn({
              threadId: event.payload.threadId,
              detail: providerFailureDetail(event.payload.activity.payload),
            })
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  // Enforce `timeoutMs` on unattended running steps (t3o-17): recovery is
  // otherwise edge-triggered on turn.completed, so a turn that HANGS (or whose
  // completion event was dropped) holds its slot unsupervised forever. Overdue
  // steps funnel into the same recovery ladder — nudge, then escalate — so a
  // hung step is eventually landed `stalled` and its slot released. Human-in-
  // the-loop runs are exempt (a human is the pacing, per the contracts doc).
  const sweepTimeouts = Effect.gen(function* () {
    const board = yield* readBoard;
    const nowMs = Date.parse(yield* nowIso);
    for (const state of board.stepStates ?? []) {
      if (state.status !== "running" || state.humanInLoop) continue;
      if (state.timeoutMs <= 0) continue;
      // The clock runs from the LATEST life sign, using the same two OR'd
      // progress sources as recovery (t3o-17 D2, re-pointed by t3o-18 D16): the
      // last nudge/start, the step thread's todo list ADVANCING (`advancedAt` on
      // `board_thread_todos`), and — checked below, only once a step already
      // looks overdue — a fresh commit on the card's branch. Without this, a
      // healthy hours-long turn would be nudged mid-turn every timeoutMs and
      // marched toward the stall ceiling.
      const todo = yield* threadTodoState(state.threadId);
      const referenceMs = Math.max(
        ...[state.lastNudgeAt ?? state.startedAt, todo?.advancedAt ?? null]
          .filter((value): value is string => value != null)
          .map((value) => Date.parse(value))
          .filter((value) => Number.isFinite(value)),
      );
      if (!Number.isFinite(referenceMs) || nowMs - referenceMs <= state.timeoutMs) continue;
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined || card.archivedAt !== null) continue;
      const worktreePath = card.worktree?.path ?? null;
      if (state.mode === "build" && worktreePath !== null) {
        const committedAt = yield* latestCommitIso(worktreePath);
        const committedMs = committedAt === null ? Number.NaN : Date.parse(committedAt);
        if (Number.isFinite(committedMs) && nowMs - committedMs <= state.timeoutMs) continue;
      }
      yield* recoverStep({ card, state });
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
      case "runtime": {
        const threadId = ThreadId.make(String(input.event.threadId));
        if (input.event.type === "session.started") {
          // Only enqueued for orphans (see `start`): the session the spawn
          // raced now exists — deliver the durable interrupt.
          if (!orphanedThreads.delete(String(threadId))) return Effect.void;
          return interruptOrphan(threadId);
        }
        if (input.event.type === "turn.completed") {
          // An orphan whose turn ended needs no interrupt any more.
          orphanedThreads.delete(String(threadId));
          return handleTurnCompleted(threadId);
        }
        // An ordinary agent question (t3o-18, D13): re-sourced from the runtime
        // event on the stream the reactor already consumes, so it fires for
        // EVERY input request rather than only the ones a now-deleted board tool
        // remembered to double-report.
        if (input.event.type === "user-input.requested") return handleInputRequested(threadId);
        // A structured question being ANSWERED (t3o-34, D5) — the one way a
        // parked step goes back to work that no turn-start event sees.
        if (input.event.type === "user-input.resolved") return resumeParkedStep(threadId);
        return Effect.void;
      }
      case "reconcile":
        return reconcile;
      case "timeout-sweep":
        return sweepTimeouts;
    }
  };

  const processInputSafely = (input: SupervisorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("board supervisor failed to process input", {
              source: input.source,
              eventType: "event" in input ? input.event.type : input.source,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: SupervisorReactorShape["start"] = Effect.fn("board-supervisor-start")(function* () {
    // Subscriptions are forked first, but forkParked PARKS them until server
    // activation — so reconcile (enqueued below, processed immediately by the
    // unparked worker) cannot rely on the live PubSub for its own follow-
    // through. That is why `reconcile` ends with a state-derived kickoff pass;
    // the forked-first ordering still matters once activation opens the
    // streams, so live events enqueue behind the reconcile item in the one
    // sequential worker.
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        // Thread activity is by far the highest-volume event on this stream, and
        // the board cares about exactly one kind of it (t3o-30, D2), so it is
        // filtered HERE rather than in `processDomainEvent` — the worker never
        // sees the tool calls, reasoning and output of every thread on the box.
        if (event.type === "thread.activity-appended") {
          return event.payload.activity.kind === "provider.turn.start.failed"
            ? worker.enqueue({ source: "domain", event })
            : Effect.void;
        }
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "board.card-moved" &&
          event.type !== "board.card-created" &&
          event.type !== "board.card-stage-thread-requested" &&
          event.type !== "board.card-updated" &&
          event.type !== "board.card-step-completed" &&
          event.type !== "board.card-archived" &&
          event.type !== "board.card-deleted" &&
          event.type !== "board.plans-approved"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type === "turn.completed") return worker.enqueue({ source: "runtime", event });
        // `user-input.requested` rides the same stream (t3o-18, D13): one more
        // case in an existing subscription, no new seam. It fires for every
        // agent question, which is what re-parks a step on the gate.
        if (event.type === "user-input.requested")
          return worker.enqueue({ source: "runtime", event });
        // `user-input.resolved` rides the same stream (t3o-34, D5): a structured
        // question is raised from inside a RUNNING turn, so answering it starts
        // no turn and emits no turn-start event anywhere. This is the only
        // signal that sees a step un-parked that way.
        if (event.type === "user-input.resolved")
          return worker.enqueue({ source: "runtime", event });
        // session.started matters only for a thread orphaned by a rejected
        // admit — the durable delivery point for its turn interrupt.
        if (event.type === "session.started" && orphanedThreads.has(String(event.threadId))) {
          return worker.enqueue({ source: "runtime", event });
        }
        return Effect.void;
      }),
    );
    // The server restarts mid-step: reconcile persisted step state, serialised
    // ahead of the live events now flowing into the same worker queue.
    yield* worker.enqueue({ source: "reconcile" });
    // Periodic timeout sweep (t3o-17): rides the worker so it never races the
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
    sweep: sweepTimeouts,
    drain: worker.drain,
    // Both run OUTSIDE the serialised worker: they are request-scoped, the
    // caller is waiting on the answer, and neither touches step state — the
    // conflict step they can start goes through the ordinary
    // `start-stage-thread` event, which the worker picks up as usual.
    // Both are TOTAL: they are called from an RPC handler that owes the user a
    // response, and a read-model hiccup must surface as "the merge did not
    // happen, here is why" rather than as an unhandled failure on a button
    // click.
    refreshPullRequest: (cardId) =>
      Effect.flatMap(readCard(cardId), (card) =>
        card === null ? Effect.void : refreshCardPullRequest(card),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board supervisor: pull request refresh failed", {
            cardId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    mergePullRequest: (cardId) =>
      mergeCardPullRequest(cardId).pipe(
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
  } satisfies SupervisorReactorShape;
});

export const SupervisorReactorLive = Layer.effect(SupervisorReactor, make);
