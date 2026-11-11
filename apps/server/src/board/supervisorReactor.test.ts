/**
 * Boot reconciliation for the reactor's effectful shell: drives `reconcile` against stub
 * services and a fake thread gateway, and asserts each decision reaches the right board
 * command or thread call. The pure decisions are covered in supervisor.test.ts.
 */
import {
  BoardCardId,
  BoardStageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardState,
  type BoardEvent,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { BoardSetupScriptRunner } from "./ports/BoardSetupScriptRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { ServerActivation } from "../serverActivation.ts";
import { BoardStepSlotsLive } from "./BoardStepSlots.ts";
import {
  BoardPullRequestGateway,
  BoardPullRequestGatewayError,
} from "./BoardPullRequestGateway.ts";
import { SupervisorReactor, SupervisorReactorLive } from "./supervisorReactor.ts";
import { WorkerConnectionsNoneTest } from "./workers/boardWorkers.testkit.ts";
import { BoardWorkspacesLive } from "./workspace/workspaceLayer.ts";
import { boardDecidedEvents, type BoardCommand } from "./decider.ts";
import { decideBoardCommandOnModel } from "./decisionContext.testkit.ts";
import { boardEngineDouble, boardServicesTestLayer } from "./boardServices.testkit.ts";
import { projectBoardEvent } from "./projector.ts";
import type { BoardOrchestrationReadModel } from "./decisionContext.testkit.ts";
import type { BoardThreadState } from "./ThreadGateway.ts";
import {
  aliveThread,
  failedThread,
  makeFakeThreadGateway,
  type ThreadGatewayCall,
} from "./threadGateway.testkit.ts";
import { worktreeRetirerTestLayer } from "./worktreeRetire.testkit.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const cardId = BoardCardId.make("card-1");

// The single step id per stage is the stage id: a card in Building
// runs a step keyed "building", and its completion is keyed the same.
const stepId = String(BoardStageId.make("building"));

const card: BoardCard = {
  id: cardId,
  pullRequest: null,
  pullRequestHistory: [],
  pullRequestFloor: null,
  key: "T3-1",
  cardNumber: 1,
  projectId,
  labels: [],
  stage: BoardStageId.make("building"),
  orderKey: "m",
  title: "Card",
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  sourcePlanId: null,
  group: null,
  threadLinks: [],
  attachments: [],
  externalRef: null,
  humanInLoop: null,
  reviewOverrides: null,
  modelOverrides: null,
  splitRationale: null,
  baseBranch: null,
  scheduledStartAt: null,
  autoPlanSetting: null,
  autoBuildSetting: null,
  autoMergeSetting: null,
  autoMergeHold: null,
  mergeStrategy: null,
  pinnedWorkerId: null,
  placedWorkerId: null,
  workerMove: null,
  placementOrphaned: null,
  ci: null,
  ciLastOutcome: null,
  ciRoundTrips: 0,
  worktree: {
    branch: "board/t3-1",
    baseRefName: "main",
    path: "/tmp/wt/t3-1",
    status: "ready",
    attempts: 1,
    lastError: null,
    reclaimBlockedReason: null,
  },
  blocked: false,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

// The frozen execution config the Building stage stamped onto the
// run row at entry: an unattended build-mode step on codex.
const runningState: BoardCardStepState = {
  cardId,
  stepId,
  stepLabel: "Build",
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question" as const,
  stalledReason: "gave-up" as const,
  retryAt: null,
  prompt: "do it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 1000,
  threadId: ThreadId.make("thread-1"),
  status: "running",
  slotHeld: true,
  forceStart: false,
  queuedBy: null,
  startedAt: NOW,
  updatedAt: NOW,
};

function readModel(board: BoardState): BoardOrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: projectId,
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [],
    board,
    updatedAt: NOW,
  };
}

const aliveShell: BoardThreadState = aliveThread("thread-1", { activeTurnRef: "turn-1" });

/** The shape a server restart leaves behind: the orphaned session is
    marked `error`, and the id of the turn that died with the process is still
    on the thread. */
const restartOrphanShell: BoardThreadState = failedThread("thread-1");

/** What reconcile did: a board command dispatched, or a call on a thread. */
type ReconcileCall = BoardCommand | ThreadGatewayCall;

/** Run `reconcile` against stub services and return what it dispatched and
    called, in order. `threadShells` maps a thread id to its live state; an
    absent id is "gone". */
function reconcileCommandObjects(input: {
  readonly board: BoardState;
  readonly threadShells?: ReadonlyMap<string, BoardThreadState>;
  /**
   * Provide a `ServerActivation` whose effect is this function, called with everything
   * dispatched so far, so "it read nothing before activation" is an observation, not a race.
   * Absent leaves reconcile waiting for nothing.
   */
  readonly gateOnActivation?: (
    dispatchedSoFar: Effect.Effect<ReadonlyArray<ReconcileCall>>,
  ) => Effect.Effect<void>;
  /**
   * Follow the reconcile with the backoff rung it just set. A recovery parks the step with a
   * `retryAt` rather than nudging, so a test about what a recovery does waits the rung out.
   */
  readonly throughRetry?: boolean;
}): Effect.Effect<ReadonlyArray<ReconcileCall>> {
  return Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<ReconcileCall>>([]);
    // Board commands fold back into the model through the real decider and projector: a
    // recovery parks the step and a later sweep acts on the parked row, so a frozen model would
    // leave the sweep reading a step boot had already moved on from.
    const model = yield* Ref.make(readModel(input.board));
    const foldBoardCommand = (command: BoardCommand) =>
      Effect.gen(function* () {
        const decided = yield* decideBoardCommandOnModel({
          command,
          readModel: yield* Ref.get(model),
        }).pipe(
          Effect.map(boardDecidedEvents),
          Effect.orElseSucceed(() => []),
        );
        for (const planned of decided) {
          const event = { ...planned, sequence: 0 } as BoardEvent;
          const next = yield* projectBoardEvent(yield* Ref.get(model), event).pipe(Effect.orDie);
          yield* Ref.set(model, next);
        }
      });

    const dispatchBoard = (command: BoardCommand) =>
      Ref.update(recorded, (all) => [...all, command]).pipe(
        Effect.andThen(foldBoardCommand(command)),
        Effect.as({ sequence: 0 }),
      );

    // The threads that exist at boot are exactly `threadShells`; every call on
    // one is recorded alongside the board's commands, in order.
    const threads = yield* makeFakeThreadGateway({
      ...(input.threadShells === undefined ? {} : { threads: input.threadShells }),
      onCall: (call) => Ref.update(recorded, (all) => [...all, call]),
    });

    const settingsStub = {
      getSettings: Effect.succeed({ board: undefined }),
    } as unknown as ServerSettingsService["Service"];

    const gitStub = {
      execute: () => Effect.succeed({ stdout: "main", stderr: "", exitCode: 0 }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];

    const setupStub = {
      runForThread: () => Effect.undefined,
    } as unknown as BoardSetupScriptRunner["Service"];

    const deps = Layer.mergeAll(
      boardServicesTestLayer({
        engine: boardEngineDouble({
          dispatch: dispatchBoard as never,
          board: Ref.get(model).pipe(Effect.map((current) => current.board)),
        }),
        threads: threads.gateway,
      }),
      Layer.succeed(ServerSettingsService, settingsStub),
      Layer.succeed(GitVcsDriver.GitVcsDriver, gitStub),
      worktreeRetirerTestLayer().pipe(
        Layer.provide(Layer.succeed(GitVcsDriver.GitVcsDriver, gitStub)),
      ),
      Layer.succeed(BoardSetupScriptRunner, setupStub),
      // Boot reconcile never looks a pull request up (it reconciles step state,
      // not forge state), so an always-empty gateway is the honest stub here.
      Layer.succeed(
        BoardPullRequestGateway,
        BoardPullRequestGateway.of({
          repository: () => Effect.succeed(null),
          find: () => Effect.succeed(null),
          get: () =>
            Effect.fail(
              new BoardPullRequestGatewayError({ operation: "get", detail: "No pull request." }),
            ),
          merge: () => Effect.void,
          markReady: () => Effect.succeed("not-draft" as const),
          close: () => Effect.succeed("not-open" as const),
          mergeState: () =>
            Effect.fail(
              new BoardPullRequestGatewayError({
                operation: "mergeState",
                detail: "No provider is registered.",
              }),
            ),
        }),
      ),
      BoardStepSlotsLive,
      Layer.succeed(
        ServerActivation,
        input.gateOnActivation === undefined
          ? undefined
          : input.gateOnActivation(Ref.get(recorded)),
      ),
    );

    // Run reconcile INSIDE the layer's scope so the reactor's worker fibers and
    // captured services stay live for the whole reconciliation.
    return yield* Effect.gen(function* () {
      const reactor = yield* SupervisorReactor;
      yield* reactor.reconcile;
      if (input.throughRetry === true) {
        yield* TestClock.adjust(Duration.minutes(5));
        yield* reactor.fireRetries;
        yield* reactor.drain;
      }
      const commands = yield* Ref.get(recorded);
      return commands;
    }).pipe(
      Effect.provide(
        SupervisorReactorLive.pipe(
          Layer.provide(
            BoardWorkspacesLive.pipe(
              Layer.provideMerge(deps),
              Layer.provide(WorkerConnectionsNoneTest),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
}

function reconcileCommands(input: {
  readonly board: BoardState;
  readonly threadShells?: ReadonlyMap<string, BoardThreadState>;
  readonly gateOnActivation?: (
    dispatchedSoFar: Effect.Effect<ReadonlyArray<ReconcileCall>>,
  ) => Effect.Effect<void>;
  readonly throughRetry?: boolean;
}): Effect.Effect<ReadonlyArray<string>> {
  return reconcileCommandObjects(input).pipe(
    Effect.map((commands) => commands.map((command) => command.type)),
  );
}

// The round cap holds the card. Completing the capped review `succeeded` would let
// `advanceStage` move it (review auto-advances by default), so a card with unresolved
// criticals would graduate. Asserted at the reactor: `board.card.move` must not happen.

const reviewCard: BoardCard = { ...card, stage: BoardStageId.make("review") };

const reviewStepState = (stepId: string): BoardCardStepState => ({
  ...runningState,
  stepId,
  stepLabel: "Review",
  stageLabel: "Code review",
});

const reviewCompletion = (stepId: string, payload: unknown) => ({
  cardId,
  stepId,
  outcome: "succeeded" as const,
  summary: `did ${stepId}`,
  payload: payload === null ? null : JSON.stringify(payload),
  threadId: ThreadId.make("thread-1"),
  completedAt: NOW,
});

/** A round that ran every phase and left a critical unresolved. */
const unconvergedRound = (round: number) => [
  reviewCompletion(`review@${round}`, {
    reviewedSha: `sha-${round}`,
    findings: [
      {
        id: `f${round}`,
        severity: "critical",
        file: "src/x.ts",
        line: 1,
        title: "still broken",
        detail: "",
      },
    ],
  }),
  reviewCompletion(`triage@${round}`, { fixedSha: `fix-${round}`, dispositions: [] }),
  reviewCompletion(`adjudicate@${round}`, { verdicts: [] }),
];

it.effect("t3o-22: a review loop that runs out of rounds does NOT advance the card", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: {
        cards: [
          {
            ...reviewCard,
            reviewOverrides: {
              rounds: 1,
              stopAfterRound: null,
              roundModels: {},
              runThroughRound: null,
              carriedFindings: {},
              stuckWaivedThrough: null,
              roundModes: {},
            },
          },
        ],
        stepStates: [reviewStepState("adjudicate@1")],
        stepCompletions: unconvergedRound(1),
        nextCardNumberByProject: {},
      },
    });
    assert.include(types, "board.card.settle-step");
    // The whole point: nothing converged, so the card holds where it is.
    assert.notInclude(types, "board.card.move");
    assert.notInclude(types, "board.card.pipeline-move");
    // ...and no round 2 is started either — the budget really is spent.
    assert.notInclude(types, "board.card.select-step");
  }),
);

it.effect("t3o-22: a review loop that CONVERGES still advances the card", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: {
        cards: [
          {
            ...reviewCard,
            reviewOverrides: {
              rounds: 1,
              stopAfterRound: null,
              roundModels: {},
              runThroughRound: null,
              carriedFindings: {},
              stuckWaivedThrough: null,
              roundModes: {},
            },
          },
        ],
        stepStates: [reviewStepState("review@1")],
        // Same budget, same round count, no blocking finding: this one passed.
        stepCompletions: [reviewCompletion("review@1", { reviewedSha: "sha-1", findings: [] })],
        nextCardNumberByProject: {},
      },
    });
    assert.include(types, "board.card.pipeline-move");
  }),
);

it.effect("t3o-22: a stopped loop holds even with budget remaining", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: {
        cards: [
          {
            ...reviewCard,
            reviewOverrides: {
              rounds: 5,
              stopAfterRound: 1,
              roundModels: {},
              runThroughRound: null,
              carriedFindings: {},
              stuckWaivedThrough: null,
              roundModes: {},
            },
          },
        ],
        stepStates: [reviewStepState("adjudicate@1")],
        stepCompletions: unconvergedRound(1),
        nextCardNumberByProject: {},
      },
    });
    assert.notInclude(types, "board.card.move");
    assert.notInclude(types, "board.card.pipeline-move");
    assert.notInclude(types, "board.card.select-step");
  }),
);

it.effect("boot: a running step whose thread is gone is recovered (respawned)", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: { cards: [card], stepStates: [runningState], nextCardNumberByProject: {} },
      // no shell for thread-1 → gone
      throughRetry: true,
    });
    assert.include(types, "board.card.recover-step");
    // A gone thread is respawned, not nudged into the void — through the
    // governor when the backoff rung arrives, which is also what
    // gets the step its slot back.
    assert.include(types, "thread.spawn");
    assert.notInclude(types, "thread.send");
    assert.include(types, "board.card.link-thread");
  }),
);

it.effect("respawn freezes the user-chosen access level, never forcing full-access (t3o-21)", () =>
  Effect.gen(function* () {
    // The run row was frozen at `auto` (a build-mode step no longer implies
    // full-access). The respawn must carry that posture verbatim.
    const commands = yield* reconcileCommandObjects({
      board: { cards: [card], stepStates: [runningState], nextCardNumberByProject: {} },
      // no shell for thread-1 → gone → respawn once the backoff rung arrives
      throughRetry: true,
    });
    const spawn = commands.find((command) => command.type === "thread.spawn");
    assert.isDefined(spawn);
    assert.strictEqual((spawn as { runtimeMode?: string }).runtimeMode, "auto");
    assert.notStrictEqual((spawn as { runtimeMode?: string }).runtimeMode, "full-access");
  }),
);

it.effect("boot: a running step with a live thread is left to resume watching", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: { cards: [card], stepStates: [runningState], nextCardNumberByProject: {} },
      threadShells: new Map([["thread-1", aliveShell]]),
    });
    assert.notInclude(types, "board.card.recover-step");
    assert.notInclude(types, "board.card.settle-step");
  }),
);

it.effect("boot: a running step with a gone thread and no worktree does not burn an attempt", () =>
  Effect.gen(function* () {
    const worktreelessCard: BoardCard = { ...card, worktree: null };
    const types = yield* reconcileCommands({
      board: { cards: [worktreelessCard], stepStates: [runningState], nextCardNumberByProject: {} },
      // no shell → gone; no worktree → cannot respawn
    });
    assert.notInclude(types, "board.card.recover-step");
    assert.notInclude(types, "thread.spawn");
    assert.notInclude(types, "thread.send");
  }),
);

it.effect(
  "boot: a stall-exhausted step escalates to the human without driving the agent (t3o-17)",
  () =>
    Effect.gen(function* () {
      // Consecutive stalls at the ceiling (stallCount 3 = maxAttempts 3): the next
      // recovery gives up rather than retrying.
      const exhausted: BoardCardStepState = {
        ...runningState,
        attempt: 3,
        maxAttempts: 3,
        stallCount: 3,
        stageEntryRecoveries: 0,
        humanTurnAt: null,
      };
      const types = yield* reconcileCommands({
        board: { cards: [card], stepStates: [exhausted], nextCardNumberByProject: {} },
        // no shell → thread gone, but escalation must not respawn/nudge it
      });
      // The step is parked stalled (its badge is the human-facing
      // signal; `board.card.request-input` is gone, so the question
      // itself goes to the server log)...
      assert.notInclude(types, "board.card.request-input");
      assert.include(types, "board.card.recover-step");
      // ...and the agent is NOT driven (no turn), so recovery never loops.
      assert.notInclude(types, "thread.spawn");
      assert.notInclude(types, "thread.send");
    }),
);

it.effect("boot: a step that completed while the server was down is settled and advanced", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: {
        cards: [card],
        stepStates: [runningState],
        stepCompletions: [
          {
            cardId,
            stepId,
            outcome: "succeeded",
            summary: "done",
            payload: null,
            threadId: ThreadId.make("thread-1"),
            completedAt: NOW,
          },
        ],
        nextCardNumberByProject: {},
      },
    });
    assert.include(types, "board.card.settle-step");
    // Every step succeeded → board-driven Building → Code review advance.
    assert.include(types, "board.card.pipeline-move");
  }),
);

it.effect("boot: a human-in-the-loop step that completed while down advances too (T3O-76)", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: {
        cards: [{ ...card, humanInLoop: true }],
        stepStates: [{ ...runningState, humanInLoop: true }],
        stepCompletions: [
          {
            cardId,
            stepId,
            outcome: "succeeded",
            summary: "done",
            payload: null,
            threadId: ThreadId.make("thread-1"),
            completedAt: NOW,
          },
        ],
        nextCardNumberByProject: {},
      },
    });
    assert.include(types, "board.card.settle-step");
    assert.include(types, "board.card.pipeline-move");
  }),
);

// After a restart upstream marks each orphaned session `error`, but the killed turn's
// `activeTurnRef` lingers. Liveness that read only the turn would resume-watch a corpse
// forever, holding its slot.

it.effect("boot: a session upstream marked `error` is dead even with a stale activeTurnRef", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: { cards: [card], stepStates: [runningState], nextCardNumberByProject: {} },
      threadShells: new Map([["thread-1", restartOrphanShell]]),
      throughRetry: true,
    });
    assert.include(types, "board.card.recover-step");
    // The thread still EXISTS, so recovery drives the thread it has rather than
    // respawning — which is upstream's own instruction on that error ("Send a
    // new message to continue"). It goes out when the backoff rung arrives
    // rather than on the spot.
    assert.include(types, "thread.send");
    assert.notInclude(types, "thread.spawn");
  }),
);

it.effect("boot reconcile reads nothing until server activation resolves (t3o-10, D3)", () =>
  Effect.gen(function* () {
    // What had been dispatched at the moment the activation boundary opened.
    const atBoundary = yield* Ref.make<ReadonlyArray<string> | null>(null);
    const types = yield* reconcileCommands({
      board: { cards: [card], stepStates: [runningState], nextCardNumberByProject: {} },
      threadShells: new Map([["thread-1", restartOrphanShell]]),
      gateOnActivation: (dispatchedSoFar) =>
        dispatchedSoFar.pipe(
          Effect.flatMap((commands) =>
            Ref.set(
              atBoundary,
              commands.map((command) => command.type),
            ),
          ),
        ),
    });
    // The reconcile ran (it recovered the orphan)...
    assert.include(types, "board.card.recover-step");
    // ...and every bit of that happened AFTER activation. Reading earlier is
    // the bug: the board's `reactors.start` phase runs before upstream's
    // `provider-sessions.reconcile`, so a shell read then still shows the
    // killed turn as active.
    assert.deepStrictEqual(yield* Ref.get(atBoundary), []);
  }),
);
