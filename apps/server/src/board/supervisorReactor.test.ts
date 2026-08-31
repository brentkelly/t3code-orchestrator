/**
 * Boot-reconciliation coverage for the supervisor reactor's effectful shell
 * (t3o-10). The pure decision logic is covered in supervisor.test.ts; here we
 * drive the exposed `reconcile` against stub services and assert the shell
 * wires each reconciliation decision to the right dispatched command — the
 * "restart the server mid-step" verification bullet.
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
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { BoardStepSlotsLive } from "./BoardStepSlots.ts";
import { BoardPullRequestGateway } from "./BoardPullRequestGateway.ts";
import { SupervisorReactor, SupervisorReactorLive } from "./supervisorReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const cardId = BoardCardId.make("card-1");

// The single step id per stage is the stage id (t3o-15, D1): a card in Building
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
  threadLinks: [],
  externalRef: null,
  humanInLoop: null,
  reviewOverrides: null,
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

// The frozen execution config (t3o-15, D12) the Building stage stamped onto the
// run row at entry: an unattended build-mode step on codex.
const runningState: BoardCardStepState = {
  cardId,
  stepId,
  stepLabel: "Build",
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
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
  startedAt: NOW,
  updatedAt: NOW,
};

function readModel(board: BoardState): OrchestrationReadModel {
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

const aliveShell: OrchestrationThreadShell = {
  id: ThreadId.make("thread-1"),
  session: { activeTurnId: "turn-1" },
  hasPendingUserInput: false,
} as unknown as OrchestrationThreadShell;

/** Run `reconcile` against stub services and return the dispatched command
    types. `threadShells` maps a thread id to its shell; an absent id is "gone". */
function reconcileCommandObjects(input: {
  readonly board: BoardState;
  readonly threadShells?: ReadonlyMap<string, OrchestrationThreadShell>;
}): Effect.Effect<ReadonlyArray<OrchestrationCommand>> {
  const shells = input.threadShells ?? new Map<string, OrchestrationThreadShell>();
  return Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const model = readModel(input.board);

    const engineStub = {
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(recorded, (all) => [...all, command]).pipe(Effect.as({ sequence: 0 })),
      streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
      latestSequence: Effect.succeed(0),
    } as unknown as OrchestrationEngineService["Service"];

    const snapshotStub = {
      getCommandReadModel: () => Effect.succeed(model),
      getThreadShellById: (threadId: ThreadId) => {
        const shell = shells.get(String(threadId));
        return Effect.succeed(shell === undefined ? Option.none() : Option.some(shell));
      },
    } as unknown as ProjectionSnapshotQuery["Service"];

    const providerStub = {
      streamEvents: Stream.empty,
    } as unknown as ProviderService["Service"];

    const settingsStub = {
      getSettings: Effect.succeed({ board: undefined }),
    } as unknown as ServerSettingsService["Service"];

    const gitStub = {
      execute: () => Effect.succeed({ stdout: "main", stderr: "", exitCode: 0 }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];

    const setupStub = {
      runForThread: () => Effect.succeed(undefined),
    } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];

    const deps = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, engineStub),
      Layer.succeed(ProjectionSnapshotQuery, snapshotStub),
      Layer.succeed(ProviderService, providerStub),
      Layer.succeed(ServerSettingsService, settingsStub),
      Layer.succeed(GitVcsDriver.GitVcsDriver, gitStub),
      Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, setupStub),
      // Boot reconcile never looks a pull request up (it reconciles step state,
      // not forge state), so an always-empty gateway is the honest stub here.
      Layer.succeed(
        BoardPullRequestGateway,
        BoardPullRequestGateway.of({
          find: () => Effect.succeed(null),
          merge: () => Effect.void,
        }),
      ),
      BoardStepSlotsLive,
    );

    // Run reconcile INSIDE the layer's scope so the reactor's worker fibers and
    // captured services stay live for the whole reconciliation.
    return yield* Effect.gen(function* () {
      const reactor = yield* SupervisorReactor;
      yield* reactor.reconcile;
      const commands = yield* Ref.get(recorded);
      return commands;
    }).pipe(Effect.provide(SupervisorReactorLive.pipe(Layer.provide(deps))));
  }).pipe(Effect.provide(NodeServices.layer));
}

function reconcileCommands(input: {
  readonly board: BoardState;
  readonly threadShells?: ReadonlyMap<string, OrchestrationThreadShell>;
}): Effect.Effect<ReadonlyArray<string>> {
  return reconcileCommandObjects(input).pipe(
    Effect.map((commands) => commands.map((command) => command.type)),
  );
}

// ── The round cap holds the card (t3o-22, D1) ─────────────────────────
//
// The regression this spec exists to fix: PR #40 made the cap complete
// `succeeded`, and `advanceStage` moves any successful stage whose
// `autoAdvance` is on — which the review stage's is BY DEFAULT. So a card whose
// reviewer raised criticals it never resolved graduated to the next stage,
// indistinguishable from one that passed. Asserted at the reactor, not just the
// executor, because `board.card.move` is the thing that must not happen.

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
          { ...reviewCard, reviewOverrides: { rounds: 1, stopAfterRound: null, roundModels: {} } },
        ],
        stepStates: [reviewStepState("adjudicate@1")],
        stepCompletions: unconvergedRound(1),
        nextCardNumberByProject: {},
      },
    });
    assert.include(types, "board.card.settle-step");
    // The whole point: nothing converged, so the card holds where it is.
    assert.notInclude(types, "board.card.move");
    // ...and no round 2 is started either — the budget really is spent.
    assert.notInclude(types, "board.card.select-step");
  }),
);

it.effect("t3o-22: a review loop that CONVERGES still advances the card", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: {
        cards: [
          { ...reviewCard, reviewOverrides: { rounds: 1, stopAfterRound: null, roundModels: {} } },
        ],
        stepStates: [reviewStepState("review@1")],
        // Same budget, same round count, no blocking finding: this one passed.
        stepCompletions: [reviewCompletion("review@1", { reviewedSha: "sha-1", findings: [] })],
        nextCardNumberByProject: {},
      },
    });
    assert.include(types, "board.card.move");
  }),
);

it.effect("t3o-22: a stopped loop holds even with budget remaining", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: {
        cards: [
          { ...reviewCard, reviewOverrides: { rounds: 5, stopAfterRound: 1, roundModels: {} } },
        ],
        stepStates: [reviewStepState("adjudicate@1")],
        stepCompletions: unconvergedRound(1),
        nextCardNumberByProject: {},
      },
    });
    assert.notInclude(types, "board.card.move");
    assert.notInclude(types, "board.card.select-step");
  }),
);

it.effect("boot: a running step whose thread is gone is recovered (respawned)", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: { cards: [card], stepStates: [runningState], nextCardNumberByProject: {} },
      // no shell for thread-1 → gone
    });
    assert.include(types, "board.card.recover-step");
    // A gone thread is respawned, not nudged into the void.
    assert.include(types, "thread.turn.start");
    assert.include(types, "board.card.link-thread");
  }),
);

it.effect("respawn freezes the user-chosen access level, never forcing full-access (t3o-21)", () =>
  Effect.gen(function* () {
    // The run row was frozen at `auto` (a build-mode step no longer implies
    // full-access). The respawn must carry that posture verbatim.
    const commands = yield* reconcileCommandObjects({
      board: { cards: [card], stepStates: [runningState], nextCardNumberByProject: {} },
      // no shell for thread-1 → gone → respawn
    });
    const turnStart = commands.find((command) => command.type === "thread.turn.start");
    assert.isDefined(turnStart);
    assert.strictEqual((turnStart as { runtimeMode?: string }).runtimeMode, "auto");
    assert.notStrictEqual((turnStart as { runtimeMode?: string }).runtimeMode, "full-access");
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
    assert.notInclude(types, "thread.turn.start");
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
      };
      const types = yield* reconcileCommands({
        board: { cards: [card], stepStates: [exhausted], nextCardNumberByProject: {} },
        // no shell → thread gone, but escalation must not respawn/nudge it
      });
      // D3 gate: the step is parked stalled (its badge is the human-facing
      // signal — t3o-18 D13 deleted `board.card.request-input`, so the question
      // itself now goes to the server log)...
      assert.notInclude(types, "board.card.request-input");
      assert.include(types, "board.card.recover-step");
      // ...and the agent is NOT driven (no turn), so recovery never loops.
      assert.notInclude(types, "thread.turn.start");
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
    // Every step succeeded → board-driven Building → Code review advance (D18).
    assert.include(types, "board.card.move");
  }),
);
