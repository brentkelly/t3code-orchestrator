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
  BoardActivityId,
  boardCardStepCompletions,
  boardCardStepState,
  boardNonTerminalStepStates,
  CommandId,
  DEFAULT_BOARD_SETTINGS,
  EMPTY_BOARD_STATE,
  isBoardTerminalStepStatus,
  MessageId,
  resolveBoardRecipeForStage,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardState,
  type BoardStep,
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
import {
  assertSingleBoardWorktreeWriter,
  boardCardWorktreeBranchName,
  provisionBoardCardWorktree,
  resolveBoardCardBaseRef,
  runBoardCardWorktreeSetup,
} from "./worktree.ts";
import {
  composeStepPrompt,
  orderBoardQueue,
  providerQuestionMechanism,
  reconcileStepDecision,
  recoveryDecision,
  resolveBoardConcurrencyLimit,
  selectNextStep,
  type BoardQueueCandidate,
} from "./supervisor.ts";

export interface SupervisorReactorShape {
  /** Reconcile persisted step state, then subscribe to board and thread
      events. Must run in a scope so worker fibers finalize on shutdown. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Reconcile every non-terminal step against the live world (boot / test). */
  readonly reconcile: Effect.Effect<void>;
  /** Resolves when the internal queue is empty and idle (test hook). */
  readonly drain: Effect.Effect<void>;
}

export class SupervisorReactor extends Context.Service<SupervisorReactor, SupervisorReactorShape>()(
  "t3/board/supervisorReactor",
) {}

type SupervisorInput =
  | { readonly source: "domain"; readonly event: OrchestrationEvent }
  | { readonly source: "runtime"; readonly event: ProviderRuntimeEvent };

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

  const boardSettings = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.board ?? DEFAULT_BOARD_SETTINGS),
    Effect.catchCause(() => Effect.succeed(DEFAULT_BOARD_SETTINGS)),
  );

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

  // Send a follow-up turn (recovery nudge or escalation question) to an
  // existing step thread.
  const sendTurn = Effect.fn("board-supervisor-sendTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly text: string;
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
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    });
  });

  // Provision the card's branch + worktree (t3o-09 effects), reporting the
  // outcome through the worktree lifecycle commands. Returns the worktree path
  // on success, or null on failure (the card records a visible, retryable
  // `failed` worktree — a reverse state, never a silent wedge).
  const ensureWorktree = Effect.fn("board-supervisor-ensureWorktree")(function* (card: BoardCard) {
    if (card.worktree !== null && card.worktree.status === "ready" && card.worktree.path !== null) {
      return card.worktree.path;
    }
    const model = yield* snapshotQuery.getCommandReadModel();
    const cwd = projectCwd(model, card);
    if (cwd === null) {
      yield* Effect.logWarning("board supervisor: no project cwd for card", { cardId: card.id });
      return null;
    }
    const branch = boardCardWorktreeBranchName(card);
    // The base ref for a top-level card is the project's default branch; a
    // sub-board plan card branches off its parent's integration branch (D12).
    const defaultBranch = yield* git
      .execute({
        operation: "boardCardWorktree.defaultBranch",
        cwd,
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.catchCause(() => Effect.succeed("")),
      );
    const baseRefName = resolveBoardCardBaseRef({
      card,
      cards: (yield* readBoard).cards,
      defaultBranch,
    });
    if (baseRefName === null || defaultBranch === "") {
      yield* dispatch({
        type: "board.card.fail-worktree",
        commandId: yield* commandId("fail-worktree"),
        cardId: card.id,
        error: "Could not resolve the card's base branch.",
        createdAt: yield* nowIso,
      });
      return null;
    }
    yield* dispatch({
      type: "board.card.provision-worktree",
      commandId: yield* commandId("provision-worktree"),
      cardId: card.id,
      branch,
      baseRefName,
      createdAt: yield* nowIso,
    });
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
      yield* dispatch({
        type: "board.card.fail-worktree",
        commandId: yield* commandId("fail-worktree"),
        cardId: card.id,
        error: "git worktree add failed; retry the build.",
        createdAt: yield* nowIso,
      });
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
    readonly step: BoardStep;
    readonly worktreePath: string;
    readonly text: string;
  }) {
    const { card, step } = input;
    const threadId = yield* freshThreadId;
    const createdAt = yield* nowIso;
    yield* dispatch({
      type: "thread.turn.start",
      commandId: yield* commandId("spawn-turn"),
      threadId,
      message: {
        messageId: yield* freshMessageId,
        role: "user",
        text: input.text,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: card.projectId,
          title: `${card.key} · ${step.label}`,
          modelSelection: { instanceId: step.providerInstanceId, model: step.model },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: card.worktree?.branch ?? null,
          worktreePath: input.worktreePath,
          createdAt,
        },
      },
      createdAt,
    });
    yield* dispatch({
      type: "board.card.link-thread",
      commandId: yield* commandId("link-thread"),
      cardId: card.id,
      threadId,
      role: step.id,
      createdAt: yield* nowIso,
    });
    // Run the worktree setup script for the worktree, in the build thread's
    // terminal (t3o-09). Best-effort — a setup failure surfaces in the thread,
    // not as a lost card.
    yield* runBoardCardWorktreeSetup({
      threadId,
      projectId: card.projectId,
      worktreePath: input.worktreePath,
    }).pipe(
      Effect.provideService(ProjectSetupScriptRunner.ProjectSetupScriptRunner, setupRunner),
      Effect.catchCause(() => Effect.void),
    );
    return threadId;
  });

  // Whether a step's thread is gone (deleted or never present) — recovery must
  // respawn rather than nudge a thread that no longer exists.
  const threadGone = (threadId: ThreadId | null) =>
    threadId === null
      ? Effect.succeed(true)
      : snapshotQuery.getThreadShellById(threadId).pipe(Effect.map(Option.isNone));

  // Offer one candidate step to the governor: acquire a slot under the resolved
  // caps and spawn its thread, or leave it queued (D11). Enforces the
  // one-writer-per-worktree invariant (t3o-09) BEFORE acquiring, so a refused
  // spawn never leaks a slot.
  const admitCandidate = Effect.fn("board-supervisor-admitCandidate")(function* (input: {
    readonly card: BoardCard;
    readonly step: BoardStep;
    readonly worktreePath: string;
    readonly attempt: number;
    readonly currentStatus: BoardCardStepState["status"];
    readonly limits: BoardConcurrencyLimit;
  }) {
    const { card, step } = input;
    // One writer at a time per worktree (t3o-09 invariant, enforced here). The
    // assertion must count the writer we are ABOUT to spawn, so a sentinel for
    // it joins the card's existing live-step threads — an existing writer plus
    // the new one is two distinct writers and the assert fails. On failure we
    // REFUSE before acquiring a slot or spawning, so the invariant actually
    // blocks rather than being logged-and-ignored, and no slot is taken and
    // then stranded. Under today's one-step-at-a-time decider there is never an
    // existing writer, so this is defence-in-depth against a concurrent-step
    // recipe.
    const board = yield* readBoard;
    const liveWriters = (board.stepStates ?? [])
      .filter(
        (state) =>
          state.cardId === card.id &&
          !isBoardTerminalStepStatus(state.status) &&
          state.threadId !== null,
      )
      .map((state) => String(state.threadId));
    const wouldConflict = yield* assertSingleBoardWorktreeWriter({
      cardId: card.id,
      activeWriterThreadIds: [...liveWriters, `board-admit:${step.id}`],
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

    const admitted = yield* slots.acquire(step.providerInstanceId, input.limits);
    if (!admitted) {
      // No slot for this instance right now. A fresh (pending) step is recorded
      // as queued so the card shows its queued badge; a step already queued
      // stays put — re-emitting queued each schedule pass would be pointless
      // churn. It will be re-offered at the next step boundary (D11).
      if (input.currentStatus === "pending") {
        yield* dispatch({
          type: "board.card.admit-step",
          commandId: yield* commandId("admit-step"),
          cardId: card.id,
          stepId: step.id,
          admitted: false,
          threadId: null,
          createdAt: yield* nowIso,
        });
      }
      return;
    }

    const threadId = yield* spawnStepThread({
      card,
      step,
      worktreePath: input.worktreePath,
      text: composeStepPrompt({ card, step, attempt: input.attempt }),
    });
    yield* dispatch({
      type: "board.card.admit-step",
      commandId: yield* commandId("admit-step"),
      cardId: card.id,
      stepId: step.id,
      admitted: true,
      threadId,
      createdAt: yield* nowIso,
    });
  });

  // The governor's scheduling pass (t3o-11, D11). Gather every card whose live
  // step is waiting for a slot (`pending` freshly selected, or `queued` holding
  // from a prior pass) and whose worktree is ready to spawn into, order them by
  // the priority rule (stage desc → started before unstarted → drag order), and
  // offer each to `admitCandidate` in that order. The greedy fill falls out:
  // the highest-priority candidate that fits a free slot starts; a candidate
  // whose provider is saturated is skipped, so a step targeting an idle vendor
  // is never blocked by a busy one. Runs after any slot release, so preemption
  // takes effect at the next step boundary with nothing in flight discarded.
  const schedule = Effect.fn("board-supervisor-schedule")(function* () {
    const board = yield* readBoard;
    const settings = yield* boardSettings;
    const entries = new Map<
      string,
      {
        readonly card: BoardCard;
        readonly step: BoardStep;
        readonly worktreePath: string;
        readonly attempt: number;
        readonly currentStatus: BoardCardStepState["status"];
        readonly limits: BoardConcurrencyLimit;
      }
    >();
    const candidates: BoardQueueCandidate[] = [];
    for (const state of board.stepStates ?? []) {
      if (state.status !== "pending" && state.status !== "queued") continue;
      const card = board.cards.find((candidate) => candidate.id === state.cardId);
      if (card === undefined || card.archivedAt !== null || card.recipeSnapshot === null) continue;
      const step = card.recipeSnapshot.steps.find((candidate) => candidate.id === state.stepId);
      if (step === undefined) continue;
      // A queued step needs a ready worktree to spawn into. A card that entered
      // Building but whose worktree is still provisioning or failed is not yet a
      // candidate — it is re-offered once its worktree lands (a fresh schedule).
      const worktreePath =
        card.worktree !== null && card.worktree.status === "ready" ? card.worktree.path : null;
      if (worktreePath === null) continue;
      const key = `${String(card.id)}::${step.id}`;
      entries.set(key, {
        card,
        step,
        worktreePath,
        attempt: state.attempt,
        currentStatus: state.status,
        limits: resolveBoardConcurrencyLimit(settings.concurrency, step.providerInstanceId),
      });
      candidates.push({
        cardId: card.id,
        stepId: step.id,
        providerInstanceId: step.providerInstanceId,
        stage: card.stage,
        started: boardCardStepCompletions(board, card.id).length > 0,
        orderKey: card.orderKey,
      });
    }
    for (const candidate of orderBoardQueue(candidates)) {
      const entry = entries.get(`${String(candidate.cardId)}::${candidate.stepId}`);
      if (entry !== undefined) yield* admitCandidate(entry);
    }
  });

  // A card entered Building (the human "Begin build" gate, D18): snapshot the
  // recipe, select the next step, provision the worktree, and admit+spawn.
  const beginCardBuild = Effect.fn("board-supervisor-beginCardBuild")(function* (card: BoardCard) {
    const settings = yield* boardSettings;
    const recipe = resolveBoardRecipeForStage(settings, card.stage);
    if (recipe.steps.length === 0) {
      yield* Effect.logDebug("board supervisor: stage has no steps", {
        cardId: card.id,
        stage: card.stage,
      });
      return;
    }
    yield* dispatch({
      type: "board.card.snapshot-recipe",
      commandId: yield* commandId("snapshot-recipe"),
      cardId: card.id,
      recipe,
      createdAt: yield* nowIso,
    });
    // Fresh Building entry never auto-advances: a card dragged back for rework
    // whose steps all already succeeded must NOT bounce straight to review
    // (advanceWhenDone: false). Only a genuine completion advances the stage.
    yield* driveNextStep(card.id, false);
  });

  // Resolve the card's next step from its snapshot and drive it to running.
  // `advanceWhenDone` gates the board-driven stage advance: it fires only when
  // a real step just completed (the success path / a reconciled success), never
  // on a fresh Building entry where "no step left" means the card was re-entered
  // for rework, not that it just finished.
  const driveNextStep = Effect.fn("board-supervisor-driveNextStep")(function* (
    cardId: BoardCard["id"],
    advanceWhenDone: boolean,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (card === undefined || card.recipeSnapshot === null) {
      // Nothing to select for this card, but a slot may have just freed — let
      // the queue flow.
      yield* schedule();
      return;
    }
    const step = selectNextStep(card.recipeSnapshot, boardCardStepCompletions(board, cardId));
    if (step === null) {
      // Every step succeeded: advance (on a real completion) and let the freed
      // capacity flow to the queue. A fresh Building entry (advanceWhenDone
      // false) with no step just schedules.
      if (advanceWhenDone) yield* advanceStage(card);
      yield* schedule();
      return;
    }
    yield* dispatch({
      type: "board.card.select-step",
      commandId: yield* commandId("select-step"),
      cardId: card.id,
      stepId: step.id,
      stepLabel: step.label,
      maxAttempts: step.maxAttempts,
      createdAt: yield* nowIso,
    });
    // Provision this card's worktree (a no-op if already ready). Admission is
    // the governor's job (`schedule`): the selected step is now `pending`, and
    // schedule offers it — plus every other waiting card — to `acquire` in
    // priority order, so it spawns if a slot is free and queues otherwise. A
    // worktree failure leaves a visible, retryable `failed` worktree; schedule
    // simply skips a card without a ready worktree, so one card's failure never
    // blocks the rest of the queue.
    yield* ensureWorktree(card);
    yield* schedule();
  });

  // Board-driven Building → Code review advance (D18): the one automatic stage
  // crossing this spec makes, and only on a successful build step. It rides the
  // ordinary move command, gated like every other transition.
  const advanceStage = Effect.fn("board-supervisor-advanceStage")(function* (card: BoardCard) {
    if (card.stage !== "building") return;
    yield* dispatch({
      type: "board.card.move",
      commandId: yield* commandId("advance"),
      cardId: card.id,
      toStage: "review",
      createdAt: yield* nowIso,
    });
  });

  const releaseSlot = (
    state: BoardCardStepState,
    step: { readonly providerInstanceId: BoardStep["providerInstanceId"] } | null,
  ) => (state.slotHeld && step !== null ? slots.release(step.providerInstanceId) : Effect.void);

  // Look up the provider instance the step is charged against, from the card's
  // snapshot, so the right slot is released.
  const stepProvider = (card: BoardCard, stepId: string): BoardStep | null =>
    card.recipeSnapshot?.steps.find((step) => step.id === stepId) ?? null;

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
    yield* releaseSlot(input.state, stepProvider(input.card, input.state.stepId));
  });

  const recoverStep = Effect.fn("board-supervisor-recoverStep")(function* (input: {
    readonly card: BoardCard;
    readonly state: BoardCardStepState;
  }) {
    const provider = stepProvider(input.card, input.state.stepId);
    const questionMechanism =
      provider !== null
        ? providerQuestionMechanism(provider.providerInstanceId)
        : "your runtime's user-input request";
    const decision = recoveryDecision({ stepState: input.state, questionMechanism });

    // Attempt budget exhausted → the D13 human gate: ask the human (retry /
    // switch provider / take it over) as a visible card activity, and park the
    // step on awaiting-input. Crucially do NOT drive the agent — escalation is a
    // human decision, and sending the agent another turn would re-arm death
    // detection (handleTurnCompleted supervises awaiting-input) and re-escalate
    // on every turn. Not driving the agent is exactly what makes recovery
    // "escalate and never loop": it stops here until a human acts.
    if (decision.kind === "escalate") {
      yield* dispatch({
        type: "board.card.request-input",
        commandId: yield* commandId("escalate-input"),
        cardId: input.card.id,
        activityId: BoardActivityId.make(yield* crypto.randomUUIDv4),
        question: decision.question,
        threadId: input.state.threadId,
        createdAt: yield* nowIso,
      });
      yield* dispatch({
        type: "board.card.recover-step",
        commandId: yield* commandId("recover-step"),
        cardId: input.card.id,
        stepId: input.state.stepId,
        threadId: input.state.threadId,
        escalateToHuman: true,
        createdAt: yield* nowIso,
      });
      return;
    }

    // Ordinary retry. Recovery never releases the held slot (a retry keeps its
    // place, D13). If the step's thread survives, nudge it in place; if it has
    // vanished (reaped/deleted) — a routine path, not an error — respawn a fresh
    // thread and continue there, so the nudge is never sent into the void.
    const gone = yield* threadGone(input.state.threadId);
    let threadId = input.state.threadId;
    let acted = false;
    if (gone) {
      if (provider !== null && input.card.worktree?.path != null) {
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
        threadId = yield* spawnStepThread({
          card: input.card,
          step: provider,
          worktreePath: input.card.worktree.path,
          text: decision.nudge,
        });
        acted = true;
      }
    } else if (input.state.threadId !== null) {
      yield* sendTurn({ threadId: input.state.threadId, text: decision.nudge });
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
    const completed = boardCardStepCompletions(board, found.card.id).some(
      (entry) => entry.stepId === found.state.stepId,
    );
    if (completed) return; // the completion handler owns this step
    const shell = yield* snapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
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
    // Running with no question → died mid-work. Awaiting-input with no pending
    // question → the human answered and the agent ran another turn without
    // completing (or died); either way death detection is re-armed. Recover.
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
        yield* driveNextStep(card.id, true);
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

  const handleInputRequested = Effect.fn("board-supervisor-handleInputRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "board.card-input-requested" }>,
  ) {
    const board = yield* readBoard;
    const state = boardCardStepState(board, event.payload.cardId);
    if (state === null || state.status !== "running") return;
    yield* dispatch({
      type: "board.card.await-step-input",
      commandId: yield* commandId("await-input"),
      cardId: event.payload.cardId,
      stepId: state.stepId,
      createdAt: yield* nowIso,
    });
  });

  const handleArchived = Effect.fn("board-supervisor-handleArchived")(function* (
    event: Extract<OrchestrationEvent, { type: "board.card-archived" }>,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === event.payload.cardId);
    const state = boardCardStepState(board, event.payload.cardId);
    if (card === undefined || state === null || isBoardTerminalStepStatus(state.status)) return;
    yield* settleStep({ card, state, outcome: "abandoned" });
    // The abandoned step released its slot — offer it to whatever is queued.
    yield* schedule();
  });

  const reconcile = Effect.gen(function* () {
    const board = yield* readBoard;
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
        const provider = stepProvider(card, state.stepId);
        if (provider !== null) yield* slots.restore(provider.providerInstanceId);
      }
      switch (decision.kind) {
        case "advance":
          yield* settleStep({ card, state, outcome: "succeeded" });
          yield* driveNextStep(card.id, true);
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
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("board supervisor: reconciliation failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const processDomainEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "board.card-moved":
        return event.payload.toStage === "building"
          ? beginCardBuild(event.payload.card)
          : Effect.void;
      case "board.card-step-completed":
        return handleStepCompleted(event);
      case "board.card-input-requested":
        return handleInputRequested(event);
      case "board.card-archived":
        return handleArchived(event);
      default:
        return Effect.void;
    }
  };

  const processInput = (input: SupervisorInput) =>
    input.source === "domain"
      ? processDomainEvent(input.event)
      : input.event.type === "turn.completed"
        ? handleTurnCompleted(ThreadId.make(String(input.event.threadId)))
        : Effect.void;

  const processInputSafely = (input: SupervisorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("board supervisor failed to process input", {
              source: input.source,
              eventType: input.event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: SupervisorReactorShape["start"] = Effect.fn("board-supervisor-start")(function* () {
    // The server restarts mid-step: reconcile persisted step state first.
    yield* reconcile;
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (
          event.type !== "board.card-moved" &&
          event.type !== "board.card-step-completed" &&
          event.type !== "board.card-input-requested" &&
          event.type !== "board.card-archived"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.completed") return Effect.void;
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return { start, reconcile, drain: worker.drain } satisfies SupervisorReactorShape;
});

export const SupervisorReactorLive = Layer.effect(SupervisorReactor, make);
