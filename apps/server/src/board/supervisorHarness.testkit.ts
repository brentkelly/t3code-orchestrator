/**
 * Shared supervisor-reactor test harness (t3o-11 governor + t3o-12 building
 * acceptance).
 *
 * `withGovernor` drives the LIVE reactor against a stateful engine double: its
 * `dispatch` runs the real board decider + projector to evolve a `Ref`-held read
 * model, so the reactor's own `schedule`/`driveNextStep`/`advanceStage` passes
 * see their own selects/admits/settles/moves exactly as in production. Domain and
 * runtime events are fed through buffered `Queue`s (no subscribe-before-publish
 * race), and `reactor.drain` gates each assertion — no sleeps, no polling.
 *
 * This is `.testkit.ts`, not `.test.ts`: it exports fixtures only and is imported
 * by the actual test files (`supervisorGovernor.test.ts`,
 * `buildingStageAutomation.test.ts`), so the runner never collects it as an empty
 * suite and the app bundle never pulls it (only tests import it).
 */
import {
  BoardCardId,
  boardCardStepState,
  BOARD_SEED_STAGE_IDS,
  BoardStageId,
  DEFAULT_BOARD_BUILD_PROMPT,
  DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
  DEFAULT_BOARD_STEP_TIMEOUT_MS,
  DEFAULT_TEXT_GENERATION_MODEL,
  isBoardCommand,
  isBoardEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardWorktree,
  type BoardSettings,
  type BoardStageExecution,
  type BoardState,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { BoardStepSlots, BoardStepSlotsLive } from "./BoardStepSlots.ts";
import { boardDecidedEvents, decideBoardCommand } from "./decider.ts";
import { projectBoardEvent } from "./projector.ts";
import { SupervisorReactor, SupervisorReactorLive } from "./supervisorReactor.ts";

export const NOW = "2026-01-01T00:00:00.000Z";
export const projectId = ProjectId.make("project-1");

/** The single build step a stage runs, in the t3o-15 stage-owned model: the
    provider instance the frozen run row spawns on, and the prompt the stage
    injects on first entry. `settingsWith` folds it into a Building stage's
    `BoardStageExecution`. */
export interface TestBuildStep {
  readonly providerInstanceId: ProviderInstanceId;
  readonly prompt: string;
}

export const codexStep: TestBuildStep = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  prompt: DEFAULT_BOARD_BUILD_PROMPT,
};

/** A ready worktree — the state right after "Begin build" provisioned it. */
export const readyWorktree = (id: string): BoardCardWorktree => ({
  branch: `board/${id}`,
  baseRefName: "main",
  path: `/tmp/wt/${id}`,
  status: "ready",
  attempts: 1,
  lastError: null,
  reclaimBlockedReason: null,
});

/** A board card in an arbitrary stage. `worktree` defaults to null (no worktree
    before Building, per D6); pass one for a card the "Begin build" gate has
    already provisioned. */
export const makeBoardCard = (input: {
  readonly id: string;
  readonly stage: string;
  readonly orderKey: string;
  readonly worktree?: BoardCardWorktree | null;
}): BoardCard => ({
  id: BoardCardId.make(input.id),
  key: input.id.toUpperCase(),
  cardNumber: 1,
  projectId,
  labels: [],
  stage: BoardStageId.make(input.stage),
  orderKey: input.orderKey,
  title: `Card ${input.id}`,
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  threadLinks: [],
  externalRef: null,
  humanInLoop: null,
  worktree: input.worktree ?? null,
  blocked: false,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

/** A card sitting in Building with a ready worktree and no step yet — the state
    right after "Begin build" provisioned the worktree; the reactor selects and
    admits the step. */
export const buildingCard = (id: string, orderKey: string): BoardCard =>
  makeBoardCard({ id, stage: "building", orderKey, worktree: readyWorktree(id) });

export const readModel = (board: BoardState): OrchestrationReadModel => ({
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
});

/** Build a `BoardStageExecution` for the Building stage from a single test
    build step (t3o-15): Building auto-executes unattended in `build` mode and
    auto-advances to the next stage on success — the behaviour the governor /
    building-automation suites drive. Human-in-the-loop is off (both defaults
    false), so a plan-less card runs unattended and the completion advances it. */
const buildingStageExecution = (step: TestBuildStep): BoardStageExecution => ({
  autoExecute: true,
  prompt: step.prompt,
  model: { instanceId: step.providerInstanceId, model: DEFAULT_TEXT_GENERATION_MODEL },
  mode: "build",
  humanInLoop: false,
  humanInLoopWithPlan: false,
  humanInLoopWithoutPlan: false,
  autoAdvance: true,
  timeoutMs: DEFAULT_BOARD_STEP_TIMEOUT_MS,
  maxAttempts: DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
});

/** `building` is the single build step the Building stage runs (a one-element
    array in every caller, mirroring the retired single-step recipe). It is
    folded into the Building stage's execution config keyed by the Building stage
    id, so the reactor resolves and freezes it exactly as in production. */
export const settingsWith = (input: {
  readonly building: ReadonlyArray<TestBuildStep>;
  readonly globalMaxConcurrent: number;
  readonly perInstance?: Record<string, number | null>;
}): BoardSettings => ({
  projects: {},
  pipeline: {
    [BOARD_SEED_STAGE_IDS.building]: buildingStageExecution(input.building[0]!),
  },
  concurrency: {
    perInstance: input.perInstance ?? {},
    globalMaxConcurrent: input.globalMaxConcurrent,
  },
  lifecycle: { archiveAfterDays: 7, worktreeRetention: "reclaim-on-archive" },
});

export type Harness = {
  readonly slots: BoardStepSlots["Service"];
  readonly reactor: SupervisorReactor["Service"];
  readonly model: Ref.Ref<OrchestrationReadModel>;
  readonly shells: Ref.Ref<ReadonlyMap<string, OrchestrationThreadShell>>;
  readonly pumpDomain: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly pumpRuntime: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly board: Effect.Effect<BoardState>;
};

/** Run `body` against a live reactor wired to the stateful engine double. */
export function withGovernor(
  input: { readonly board: BoardState; readonly settings: BoardSettings },
  body: (h: Harness) => Effect.Effect<void>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const model = yield* Ref.make(readModel(input.board));
    const shells = yield* Ref.make<ReadonlyMap<string, OrchestrationThreadShell>>(new Map());
    const seq = yield* Ref.make(0);
    const domainQueue = yield* Queue.unbounded<OrchestrationEvent>();
    const runtimeQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    // Apply a decided (planned) event to the model exactly as the projection
    // pipeline would, so `getCommandReadModel` reflects prior dispatches.
    const applyDecided = (planned: Omit<OrchestrationEvent, "sequence">) =>
      Effect.gen(function* () {
        const sequence = yield* Ref.updateAndGet(seq, (n) => n + 1);
        const event = { ...planned, sequence } as OrchestrationEvent;
        if (isBoardEvent(event)) {
          const next = yield* projectBoardEvent(yield* Ref.get(model), event);
          yield* Ref.set(model, next);
        }
      });

    const engineStub = {
      dispatch: (command: OrchestrationCommand) =>
        (isBoardCommand(command)
          ? Ref.get(model).pipe(
              Effect.flatMap((rm) => decideBoardCommand({ command, readModel: rm })),
              Effect.flatMap((decided) =>
                Effect.forEach(boardDecidedEvents(decided), applyDecided, { discard: true }),
              ),
            )
          : Effect.void
        ).pipe(Effect.andThen(Ref.get(seq).pipe(Effect.map((sequence) => ({ sequence }))))),
      streamDomainEvents: Stream.fromQueue(domainQueue),
      latestSequence: Ref.get(seq),
    } as unknown as OrchestrationEngineService["Service"];

    const snapshotStub = {
      getCommandReadModel: () => Ref.get(model),
      getThreadShellById: (threadId: ThreadId) =>
        Ref.get(shells).pipe(
          Effect.map((m) => {
            const shell = m.get(String(threadId));
            return shell === undefined ? Option.none() : Option.some(shell);
          }),
        ),
    } as unknown as ProjectionSnapshotQuery["Service"];

    const providerStub = {
      streamEvents: Stream.fromQueue(runtimeQueue),
    } as unknown as ProviderService["Service"];

    const settingsStub = {
      getSettings: Effect.succeed({ board: input.settings }),
    } as unknown as ServerSettingsService["Service"];

    const gitStub = {
      execute: () => Effect.succeed({ stdout: "main", stderr: "", exitCode: 0 }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];

    const setupStub = {
      runForThread: () => Effect.void,
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

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* SupervisorReactor;
        const slots = yield* BoardStepSlots;
        yield* reactor.start();
        // Buffered queue → published events are never lost to a late
        // subscriber; a cooperative yield lets the worker enqueue before we
        // drain, and `drain` (a transactional wait on the outstanding count)
        // blocks until processing settles — no sleeps, no polling.
        const pump = <A>(offer: Effect.Effect<A>) =>
          offer.pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(reactor.drain),
          );
        // In production the projection pipeline folds the completion into the
        // read model BEFORE the reactor's stream observes it, so `driveNextStep`
        // sees the finished step and advances rather than re-selecting it. Only
        // the completion needs replaying here: the model already holds the card,
        // and re-projecting a card-carrying trigger (move / archive) would
        // clobber the recipe snapshot the reactor stamped, whereas the reactor
        // reads those triggers from the event payload / the live model.
        const projectExternal = (event: OrchestrationEvent) =>
          isBoardEvent(event) && event.type === "board.card-step-completed"
            ? Ref.get(model).pipe(
                Effect.flatMap((m) => projectBoardEvent(m, event)),
                Effect.flatMap((next) => Ref.set(model, next)),
                // A projector decode error in a test fixture is a defect, not a
                // handled outcome — keep the pump's signature error-free.
                Effect.orDie,
              )
            : Effect.void;
        yield* body({
          slots,
          reactor,
          model,
          shells,
          pumpDomain: (event) =>
            projectExternal(event).pipe(Effect.andThen(pump(Queue.offer(domainQueue, event)))),
          pumpRuntime: (event) => pump(Queue.offer(runtimeQueue, event)),
          board: Ref.get(model).pipe(
            Effect.map(
              (m) => m.board ?? ({ cards: [], nextCardNumberByProject: {} } satisfies BoardState),
            ),
          ),
        });
      }).pipe(Effect.provide(SupervisorReactorLive.pipe(Layer.provideMerge(deps)))),
    );
  }).pipe(Effect.provide(NodeServices.layer));
}

/** A generic stage-crossing event. The reactor keys on `toStage`, so this is how
    every human gate (approve → ready, begin build → building) is delivered. */
export const cardMoved = (
  card: BoardCard,
  fromStage: string,
  toStage: string,
  sequence: number,
): OrchestrationEvent =>
  ({
    type: "board.card-moved",
    sequence,
    payload: {
      cardId: card.id,
      fromStage: BoardStageId.make(fromStage),
      toStage: BoardStageId.make(toStage),
      card,
    },
  }) as unknown as OrchestrationEvent;

/** The "Begin build" gate (D18): Ready → Building carrying the provisioned card. */
export const movedToBuilding = (card: BoardCard, sequence: number): OrchestrationEvent =>
  cardMoved(card, "ready", "building", sequence);

export const stepCompleted = (
  cardId: BoardCardId,
  outcome: "succeeded" | "failed" | "blocked",
  sequence: number,
): OrchestrationEvent =>
  ({
    type: "board.card-step-completed",
    sequence,
    payload: {
      cardId,
      completion: {
        cardId,
        stepId: String(BOARD_SEED_STAGE_IDS.building),
        outcome,
        summary: `report ${outcome}`,
        payload: null,
        threadId: null,
        completedAt: NOW,
      },
    },
  }) as unknown as OrchestrationEvent;

export const cardArchived = (card: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-archived",
    sequence,
    payload: { cardId: card.id, archivedAt: NOW, card },
  }) as unknown as OrchestrationEvent;

export const turnCompleted = (threadId: ThreadId): ProviderRuntimeEvent =>
  ({ type: "turn.completed", threadId }) as unknown as ProviderRuntimeEvent;

export const stepStatus = (board: BoardState, cardId: BoardCardId) =>
  boardCardStepState(board, cardId)?.status ?? null;

/** The stage a card currently sits in, per the live read model. */
export const cardStage = (board: BoardState, cardId: BoardCardId): BoardStageId | null =>
  board.cards.find((candidate) => candidate.id === cardId)?.stage ?? null;
