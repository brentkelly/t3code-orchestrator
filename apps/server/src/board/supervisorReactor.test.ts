/**
 * Boot-reconciliation coverage for the supervisor reactor's effectful shell
 * (t3o-10). The pure decision logic is covered in supervisor.test.ts; here we
 * drive the exposed `reconcile` against stub services and assert the shell
 * wires each reconciliation decision to the right dispatched command — the
 * "restart the server mid-step" verification bullet.
 */
import {
  BoardCardId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardResolvedRecipe,
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
import { SupervisorReactor, SupervisorReactorLive } from "./supervisorReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const cardId = BoardCardId.make("card-1");

const recipe: BoardResolvedRecipe = {
  stage: "building",
  steps: [
    {
      id: "build",
      label: "Build",
      promptTemplate: "do it",
      providerInstanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      timeoutMs: 1000,
      maxAttempts: 3,
    },
  ],
};

const card: BoardCard = {
  id: cardId,
  key: "T3-1",
  cardNumber: 1,
  projectId,
  labels: [],
  stage: "building",
  orderKey: "m",
  title: "Card",
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  threadLinks: [],
  externalRef: null,
  recipeSnapshot: recipe,
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

const runningState: BoardCardStepState = {
  cardId,
  stepId: "build",
  stepLabel: "Build",
  attempt: 1,
  maxAttempts: 3,
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
function reconcileCommands(input: {
  readonly board: BoardState;
  readonly threadShells?: ReadonlyMap<string, OrchestrationThreadShell>;
}): Effect.Effect<ReadonlyArray<string>> {
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
      BoardStepSlotsLive,
    );

    // Run reconcile INSIDE the layer's scope so the reactor's worker fibers and
    // captured services stay live for the whole reconciliation.
    return yield* Effect.gen(function* () {
      const reactor = yield* SupervisorReactor;
      yield* reactor.reconcile;
      const commands = yield* Ref.get(recorded);
      return commands.map((command) => command.type);
    }).pipe(Effect.provide(SupervisorReactorLive.pipe(Layer.provide(deps))));
  }).pipe(Effect.provide(NodeServices.layer));
}

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

it.effect("boot: a step that completed while the server was down is settled and advanced", () =>
  Effect.gen(function* () {
    const types = yield* reconcileCommands({
      board: {
        cards: [card],
        stepStates: [runningState],
        stepCompletions: [
          {
            cardId,
            stepId: "build",
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
