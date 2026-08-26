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
  boardCardPlans,
  boardCardStepCompletions,
  boardCardStepState,
  boardRunLabel,
  boardNextStageId,
  boardNonTerminalStepStates,
  boardSeedStageRole,
  boardStageById,
  boardStageEntryInvocationCount,
  boardStageIndex,
  CommandId,
  BOARD_ENVELOPE_QUESTION_MECHANISM,
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EMPTY_BOARD_STATE,
  isBoardTerminalStepStatus,
  MessageId,
  resolveBoardStageExecution,
  resolveBoardStageModelSelection,
  ThreadId,
  type BoardCard,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { BoardStepSlots, type BoardConcurrencyLimit } from "./BoardStepSlots.ts";
import { boardSnapshotQueryMethodsOf } from "./projection.ts";
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

/** Whether a step's thread is still doing live work — an active turn or a
    pending question a human can still answer. A present-but-idle thread (turn
    ended, session reaped) is NOT alive for supervision purposes: its step
    settled without completing, which is the death path. */
function threadIsAlive(shell: OrchestrationThreadShell): boolean {
  return (
    shell.hasPendingUserInput || (shell.session !== null && shell.session.activeTurnId !== null)
  );
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const serverSettings = yield* ServerSettingsService;
  const slots = yield* BoardStepSlots;
  const git = yield* GitVcsDriver.GitVcsDriver;
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

  /** What a stage with no model of its own runs on. The board has no
      compiled-in model pair — a hardcoded one is a pair the user may not have
      enabled — so an unset stage falls back to the app's OWN text-generation
      selection, which is a provider instance and model the user has already
      configured. The settings card asks for an explicit per-stage model; this
      is only what a never-configured stage lands on. */
  const fallbackModelSelection = serverSettings.getSettings.pipe(
    Effect.map((settings) => ({
      instanceId: settings.textGenerationModelSelection.instanceId,
      model: settings.textGenerationModelSelection.model,
    })),
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
      — so writing a plan moves the default with it. */
  const buildHumanInLoopDefault = (
    board: BoardState,
    exec: BoardStageExecution,
    cardId: BoardCard["id"],
  ): boolean =>
    boardCardPlans(board, cardId).length > 0
      ? exec.humanInLoopWithPlan
      : exec.humanInLoopWithoutPlan;

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
      return card.humanInLoop ?? buildHumanInLoopDefault(board, exec, card.id);
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
    // The base ref for a top-level card is the project's DEFAULT branch — not
    // whatever the project checkout happens to have checked out. origin/HEAD
    // names it when a remote exists; a purely local repo falls back to the
    // current branch, with a detached HEAD (`rev-parse` answers the literal
    // string 'HEAD') treated as a resolution failure rather than a branch. A
    // sub-board plan card branches off its parent's integration branch (D12).
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
          Effect.map((result) => result.stdout.trim()),
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
          : currentBranch === "HEAD"
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
        attachments: [],
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

    const threadId = yield* spawnStepThread({
      card,
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
    const threadId = yield* spawnStepThread({
      card,
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
      // A build-mode step needs a ready worktree to spawn into; a card whose
      // worktree is still provisioning is re-offered once it lands. A null or
      // FAILED worktree is retried right here (the decider permits
      // re-provisioning a failed one), so a provisioning failure is a visible,
      // retried step — never a silently wedged pending step.
      let worktreePath =
        card.worktree !== null && card.worktree.status === "ready" ? card.worktree.path : null;
      if (worktreePath === null && (card.worktree === null || card.worktree.status === "failed")) {
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
    const firstEntry = !completions.some((completion) => completion.stepId === card.stage);
    // The boot pass only ever STARTS fresh work (or resumes an executor-driven
    // continuation below); a re-entry is skipped — its clean human thread must
    // not re-open on every server restart.
    if (bootPass && !firstEntry) return;
    const model = resolveBoardStageModelSelection(exec.model, yield* fallbackModelSelection);
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
        execution: exec,
      },
      completions,
      runState: { round: 1, completedStepIds: [] },
    });
    if (plan.kind === "complete") {
      // The executor considers this entry already complete — a multi-step
      // executor plans from the card's ALL-TIME completions, so a review loop
      // that previously converged or exhausted its rounds reports `complete`
      // forever. A re-entry drag-back or an explicit on-demand request still
      // deserves a conversation (D7): open a clean human-in-the-loop thread on
      // the stage's own step id, exactly as a simple-stage re-entry does.
      // Never from the boot pass, though — a restart is not a human action.
      if (bootPass) return;
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
        providerInstanceId: model.instanceId,
        model: model.model,
        runtimeMode: exec.runtimeMode,
        ...(model.options === undefined ? {} : { modelOptions: model.options }),
        mode: exec.mode,
        humanInLoop: true,
        maxAttempts: exec.maxAttempts,
        timeoutMs: exec.timeoutMs,
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
        execution: exec,
      },
      completions,
      runState: { round: 1, completedStepIds },
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
          yield* dispatch({
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
          createdAt: yield* nowIso,
        });
        if (exec.mode === "build") yield* ensureWorktree(card);
        return;
      }
      case "complete": {
        // The stage is done. A successful stage may auto-advance (D8) — for the
        // review loop that covers both a converged round and the round cap; a
        // non-succeeded terminal outcome (a broken reviewer payload) leaves the
        // card put with its findings visible.
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

  // Release the step's slot on settlement — a no-op for a plan-mode step, which
  // never held one (D5). The provider is read off the frozen run row (D12).
  const releaseSlot = (state: BoardCardStepState) =>
    state.slotHeld ? slots.release(state.providerInstanceId) : Effect.void;

  const settleStep = Effect.fn("board-supervisor-settleStep")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
    readonly outcome: "succeeded" | "failed" | "abandoned";
  }) {
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
          createdAt: yield* nowIso,
        });
      }
      return;
    }
    // A human-in-the-loop run that ends a turn without completing is WAITING on
    // the human, not dead (D5): no drop monitoring, no recovery, no attempt
    // consumed. The card stays running until the human acts (or flips it to
    // unattended, at which point supervision resumes on the same thread).
    if (found.state.humanInLoop) return;
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
    switch (completion.outcome) {
      case "succeeded":
        yield* settleStep({ card, state, outcome: "succeeded" });
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
    if (isBoardTerminalStepStatus(state.status)) return;
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
    const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
    if (card === undefined) return;
    const state = boardCardStepState(board, event.payload.cardId);
    if (state !== null && !isBoardTerminalStepStatus(state.status)) {
      yield* settleStep({ card, state, outcome: "abandoned" });
      // The abandoned step released its slot — offer it to whatever is queued.
      yield* schedule();
    }
    // Reclaim the card's worktree at archive (t3o-09, D6/D15): remove it only
    // when clean and pushed, otherwise record why it was kept — without this,
    // every archived card leaks its worktree and `board/*` branch on disk.
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

  // A card was created (D10): if it landed in an auto-executing stage, kick off
  // exactly as a drag would. The created payload is flat, so re-read the card.
  const handleCardCreated = Effect.fn("board-supervisor-handleCardCreated")(function* (
    event: Extract<OrchestrationEvent, { type: "board.card-created" }>,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
    if (card === undefined) return;
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
        yield* dispatch({
          type: "thread.settle",
          commandId: yield* commandId("settle-graduated"),
          threadId: link.threadId,
        });
      }
    }
    yield* beginStageRun({ card: kickoffCard, onDemand: false });
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
        if (
          event.type !== "board.card-moved" &&
          event.type !== "board.card-created" &&
          event.type !== "board.card-stage-thread-requested" &&
          event.type !== "board.card-updated" &&
          event.type !== "board.card-step-completed" &&
          event.type !== "board.card-archived"
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
  } satisfies SupervisorReactorShape;
});

export const SupervisorReactorLive = Layer.effect(SupervisorReactor, make);
