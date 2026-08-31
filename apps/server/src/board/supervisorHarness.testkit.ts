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
  DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY,
  DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
  DEFAULT_BOARD_STEP_TIMEOUT_MS,
  DEFAULT_TEXT_GENERATION_MODEL,
  isBoardCommand,
  isBoardEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  DEFAULT_BOARD_MERGE_STAGE_EXECUTION,
  type BoardCardPullRequest,
  type BoardStageExecutionMerge,
  type VcsStatusChangeRequest,
  type BoardCardWorktree,
  type BoardSettings,
  type BoardStageExecution,
  type BoardState,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
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
import {
  BoardPullRequestGateway,
  BoardPullRequestGatewayError,
} from "./BoardPullRequestGateway.ts";
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
  readonly pullRequest?: BoardCardPullRequest | null;
  readonly pullRequestHistory?: ReadonlyArray<BoardCardPullRequest>;
  readonly pullRequestFloor?: number | null;
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
  sourcePlanId: null,
  threadLinks: [],
  externalRef: null,
  humanInLoop: null,
  reviewOverrides: null,
  worktree: input.worktree ?? null,
  pullRequest: input.pullRequest ?? null,
  pullRequestHistory: input.pullRequestHistory ?? [],
  pullRequestFloor: (input.pullRequestFloor ?? null) as BoardCard["pullRequestFloor"],
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

/** The read-model row a `thread.create` produces — only the fields the board
    decider reads (existence, `deletedAt`) carry meaning; the rest is inert
    filler so the row satisfies `OrchestrationThread`. */
const threadRow = (
  command: Extract<OrchestrationCommand, { readonly type: "thread.create" }>,
): OrchestrationThread => ({
  id: command.threadId,
  projectId: command.projectId,
  title: command.title,
  modelSelection: command.modelSelection,
  runtimeMode: command.runtimeMode,
  interactionMode: command.interactionMode,
  branch: command.branch,
  worktreePath: command.worktreePath,
  latestTurn: null,
  createdAt: command.createdAt,
  updatedAt: command.createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

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
  kind: "simple",
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
  maxInvocationsPerStageEntry: DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY,
});

/** The Planning stage configured to auto-execute (t3o-15): `plan` mode, so its
    run holds no concurrency slot and needs no worktree — the shape a card
    dropped into an auto-executing Planning column runs under. */
const planningStageExecution = (step: TestBuildStep): BoardStageExecution => ({
  kind: "simple",
  autoExecute: true,
  prompt: step.prompt,
  model: { instanceId: step.providerInstanceId, model: DEFAULT_TEXT_GENERATION_MODEL },
  mode: "plan",
  humanInLoop: false,
  humanInLoopWithPlan: false,
  humanInLoopWithoutPlan: false,
  autoAdvance: false,
  timeoutMs: DEFAULT_BOARD_STEP_TIMEOUT_MS,
  maxAttempts: DEFAULT_BOARD_STEP_MAX_ATTEMPTS,
  maxInvocationsPerStageEntry: DEFAULT_BOARD_MAX_INVOCATIONS_PER_STAGE_ENTRY,
});

/** `building` is the single build step the Building stage runs (a one-element
    array in every caller, mirroring the retired single-step recipe). It is
    folded into the Building stage's execution config keyed by the Building stage
    id, so the reactor resolves and freezes it exactly as in production. */
export const settingsWith = (input: {
  readonly building: ReadonlyArray<TestBuildStep>;
  readonly globalMaxConcurrent: number;
  readonly perInstance?: Record<string, number | null>;
  /** Pass a step to make Planning auto-execute too — the plan-mode counterpart
      of `building`, for the suites that drive a card into Planning. */
  readonly planning?: TestBuildStep;
  /** Overrides for the merge stage's config (strategy, branch cleanup, the
      conflict prompt). Absent leaves it at the compiled-in defaults, which is
      what a board nobody has configured actually resolves to. */
  readonly merge?: Partial<BoardStageExecutionMerge>;
  /** Whether a card reaching Done with a merged pull request has its worktree
      reclaimed there rather than at archive. Defaults to the shipped default
      (on), so a suite that says nothing exercises what users actually run. */
  readonly reclaimWorktreeOnDone?: boolean;
}): BoardSettings => ({
  projects: {},
  pipeline: {
    [BOARD_SEED_STAGE_IDS.building]: buildingStageExecution(input.building[0]!),
    ...(input.planning === undefined
      ? {}
      : { [BOARD_SEED_STAGE_IDS.planning]: planningStageExecution(input.planning) }),
    ...(input.merge === undefined
      ? {}
      : {
          [BOARD_SEED_STAGE_IDS.merge]: {
            ...DEFAULT_BOARD_MERGE_STAGE_EXECUTION,
            ...input.merge,
          },
        }),
  },
  concurrency: {
    perInstance: input.perInstance ?? {},
    globalMaxConcurrent: input.globalMaxConcurrent,
  },
  lifecycle: { reclaimWorktreeOnDone: input.reclaimWorktreeOnDone ?? true },
});

export type Harness = {
  readonly slots: BoardStepSlots["Service"];
  readonly reactor: SupervisorReactor["Service"];
  readonly model: Ref.Ref<OrchestrationReadModel>;
  readonly shells: Ref.Ref<ReadonlyMap<string, OrchestrationThreadShell>>;
  readonly pumpDomain: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly pumpRuntime: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly board: Effect.Effect<BoardState>;
  /** Every command the reactor dispatched, in order — including the non-board
      ones the engine double otherwise treats as no-ops, so a test can assert
      HOW a thread was spawned, not just that a step went running. */
  readonly commands: Effect.Effect<ReadonlyArray<OrchestrationCommand>>;
  /** Every board event the double DECIDED, in order. `commands` records what
      the reactor asked for; this records what the decider accepted — the
      difference is a rejected command, which the reactor swallows into a log
      line. A test asserting an outcome the card state does not carry (a pure
      report, e.g. a pre-provision worktree failure) reads it here. */
  readonly decided: Effect.Effect<ReadonlyArray<OrchestrationEvent>>;
  /** Every merge the reactor asked the forge for, in order. */
  readonly mergeAttempts: Effect.Effect<ReadonlyArray<{ readonly number: number }>>;
  /** Every worktree path the reactor removed, in order. */
  readonly removedWorktrees: Effect.Effect<ReadonlyArray<string>>;
};

/** Run `body` against a live reactor wired to the stateful engine double. */
export function withGovernor(
  input: {
    readonly board: BoardState;
    readonly settings: BoardSettings;
    /** Thread shells present BEFORE the reactor starts, so boot reconcile sees
        the threads a seeded step-state fixture references as alive. */
    readonly initialShells?: ReadonlyMap<string, OrchestrationThreadShell>;
    /** What `git log -1 --format=%cI` answers in the stubbed driver — the
        commit-liveness signal the timeout sweep reads. Defaults to "" (no
        commit history). */
    readonly latestCommitIso?: string;
    /** Make every git call answer as it does outside a repository: empty
        stdout, exit 128. The driver runs with `allowNonZeroExit`, so this is
        what the reactor's base-branch probes really see when a project's
        workspace root is not a git checkout. */
    readonly notAGitRepo?: boolean;
    /** Reject every `thread.create`, so a test can drive the spawn-failure path
        (a thread the engine refuses to create) without a provider double. */
    readonly rejectThreadCreate?: boolean;
    /** What a branch pull-request lookup answers. `undefined` (the default) is
        "no pull request"; a `detail` string makes the lookup FAIL, which is a
        different answer the reactor must not confuse with "there is none". */
    readonly pullRequest?: VcsStatusChangeRequest | { readonly failWith: string } | null;
    /** What a merge attempt answers: `undefined` succeeds, a string is the
        forge's refusal detail (a conflict when it reads like one). */
    readonly mergeFailure?: string;
    /** Make the stubbed `statusDetails` report uncommitted changes, so a test
        can drive the reclaim refusal — the case where the checkout holds work
        that exists nowhere else and must NOT be deleted to save disk. */
    readonly worktreeDirty?: boolean;
    /** The cached todo state per thread id (t3o-18): the reactor reads
        `advancedAt` for the stall-reset / timeout-liveness signal and `hasList`
        for the recovery nudge. Absent threads answer "no list". */
    readonly threadTodos?: ReadonlyMap<
      string,
      { readonly advancedAt: string | null; readonly hasList: boolean }
    >;
  },
  body: (h: Harness) => Effect.Effect<void>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const model = yield* Ref.make(readModel(input.board));
    const shells = yield* Ref.make<ReadonlyMap<string, OrchestrationThreadShell>>(
      input.initialShells ?? new Map(),
    );
    const seq = yield* Ref.make(0);
    const domainQueue = yield* Queue.unbounded<OrchestrationEvent>();
    const runtimeQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    // Apply a decided (planned) event to the model exactly as the projection
    // pipeline would, so `getCommandReadModel` reflects prior dispatches.
    const decided = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);
    const applyDecided = (planned: Omit<OrchestrationEvent, "sequence">) =>
      Effect.gen(function* () {
        const sequence = yield* Ref.updateAndGet(seq, (n) => n + 1);
        const event = { ...planned, sequence } as OrchestrationEvent;
        yield* Ref.update(decided, (current) => [...current, event]);
        if (isBoardEvent(event)) {
          const next = yield* projectBoardEvent(yield* Ref.get(model), event);
          yield* Ref.set(model, next);
        }
      });

    // The thread aggregate is not modelled here, but its ONE invariant that the
    // board depends on is: a turn cannot start on a thread that was never
    // created. The real engine rejects that (`thread.turn.start` requires the
    // thread), and a double that quietly accepted it hid a spawn path which
    // created no thread at all — every board run failed in production while the
    // suite stayed green.
    // Seeded from the fixture's shells, not empty: `initialShells` IS the set of
    // threads that exist before the reactor starts (a seeded step-state row's
    // thread), so a nudge sent to one must be accepted here. Starting empty
    // would have the double deny a turn the real engine allows — the same
    // double-vs-reality gap this invariant exists to close.
    const threads = yield* Ref.make<ReadonlySet<string>>(
      new Set(input.initialShells === undefined ? [] : [...input.initialShells.keys()]),
    );
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const dispatchThreadCommand = (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        if (command.type === "thread.create") {
          if (input.rejectThreadCreate === true) {
            return yield* Effect.fail(
              new Error(`Refusing to create thread '${String(command.threadId)}'.`),
            );
          }
          yield* Ref.update(threads, (current) => new Set(current).add(String(command.threadId)));
          // The board decider reads `readModel.threads` to decide whether a
          // thread may be linked to a card, so a created thread has to land in
          // the model too — otherwise every spawn's link-thread is refused here
          // while it lands in production, and a test asserting the card's links
          // could never pass.
          yield* Ref.update(model, (current) => ({
            ...current,
            threads: [...current.threads, threadRow(command)],
          }));
          return;
        }
        if (command.type === "thread.delete") {
          yield* Ref.update(threads, (current) => {
            const next = new Set(current);
            next.delete(String(command.threadId));
            return next;
          });
          yield* Ref.update(model, (current) => ({
            ...current,
            threads: current.threads.filter((thread) => thread.id !== command.threadId),
          }));
          return;
        }
        if (command.type !== "thread.turn.start") return;
        const known = yield* Ref.get(threads).pipe(
          Effect.map((current) => current.has(String(command.threadId))),
        );
        if (known) return;
        return yield* Effect.fail(
          new Error(
            `Thread '${String(command.threadId)}' does not exist for command '${command.type}'.`,
          ),
        );
      });

    const engineStub = {
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(commands, (current) => [...current, command])
          .pipe(
            Effect.andThen(
              isBoardCommand(command)
                ? Ref.get(model).pipe(
                    Effect.flatMap((rm) => decideBoardCommand({ command, readModel: rm })),
                    Effect.flatMap((decided) =>
                      Effect.forEach(boardDecidedEvents(decided), applyDecided, { discard: true }),
                    ),
                  )
                : dispatchThreadCommand(command),
            ),
          )
          .pipe(Effect.andThen(Ref.get(seq).pipe(Effect.map((sequence) => ({ sequence }))))),
      streamDomainEvents: Stream.fromQueue(domainQueue),
      latestSequence: Ref.get(seq),
    } as unknown as OrchestrationEngineService["Service"];

    const threadTodos = input.threadTodos ?? new Map();
    const snapshotStub = {
      getCommandReadModel: () => Ref.get(model),
      getThreadShellById: (threadId: ThreadId) =>
        Ref.get(shells).pipe(
          Effect.map((m) => {
            const shell = m.get(String(threadId));
            return shell === undefined ? Option.none() : Option.some(shell);
          }),
        ),
      // The board-owned method set (t3o-04/08/18): present so
      // `boardSnapshotQueryMethodsOf` resolves the stub and the reactor's todo
      // signal + boot sweep have something to call. Only `boardThreadTodo` is
      // fixture-driven; the rest are inert.
      boardCardDetail: () => Effect.succeed(null),
      boardCardActivity: () => Effect.succeed([]),
      boardPlanBody: () => Effect.succeed(null),
      boardCardThreads: () => Effect.succeed([]),
      boardCardIdForThread: () => Effect.succeed(null),
      boardThreadTodo: (threadId: ThreadId) => {
        const todo = threadTodos.get(String(threadId));
        return Effect.succeed(
          todo === undefined
            ? null
            : {
                hasList: todo.hasList,
                doneCount: 0,
                totalCount: todo.hasList ? 1 : 0,
                advancedAt: todo.advancedAt,
              },
        );
      },
      boardSweepThreadTodos: () => Effect.void,
    } as unknown as ProjectionSnapshotQuery["Service"];

    const providerStub = {
      streamEvents: Stream.fromQueue(runtimeQueue),
    } as unknown as ProviderService["Service"];

    const settingsStub = {
      getSettings: Effect.succeed({ board: input.settings }),
    } as unknown as ServerSettingsService["Service"];

    // Every worktree the reactor removed, so a test can assert that a card
    // reaching Done gave its checkout back — and, just as importantly, that a
    // card whose tree is dirty did not.
    const removedWorktrees = yield* Ref.make<ReadonlyArray<string>>([]);
    const gitStub = {
      // Branch cleanup's first call. Its absence used to make
      // `deleteCardBranch` throw straight into the reactor's catch-all,
      // so the cleanup at Done silently did nothing in every test that reached
      // it — which is why nothing in these suites asserted that it fires.
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      // Reclaim's clean-and-pushed gate. Clean and pushed by default, since
      // that is what a card whose pull request has merged looks like; a suite
      // testing the refusal sets `worktreeDirty`.
      statusDetails: () =>
        Effect.succeed({
          hasWorkingTreeChanges: input.worktreeDirty === true,
          hasUpstream: true,
          aheadCount: 0,
        }),
      removeWorktree: (request: { readonly path: string }) =>
        Ref.update(removedWorktrees, (paths) => [...paths, request.path]),
      // Worktree provisioning (t3o-23): fixtures that pre-provide a `ready`
      // worktree never reach these — `ensureWorktree` early-returns — but a
      // card carrying a non-ready slice (a split parent's `branch-only`
      // integration branch reaching its own review) provisions here. No branch
      // is locally present in the stub, so `createWorktree` cuts a fresh one at
      // a synthetic path.
      listLocalBranchNames: () => Effect.succeed([] as string[]),
      createWorktree: (request: { readonly branch?: string; readonly refName?: string }) =>
        Effect.succeed({
          worktree: {
            path: `/tmp/worktrees/${request.branch ?? request.refName ?? "wt"}`,
            refName: request.branch ?? request.refName ?? "board/wt",
          },
        }),
      execute: (request: { readonly args?: ReadonlyArray<string> }) =>
        input.notAGitRepo === true
          ? Effect.succeed({
              stdout: "",
              stderr: "fatal: not a git repository (or any of the parent directories): .git",
              exitCode: 128,
            })
          : Effect.succeed({
              // `git log -1 --format=%cI` answers the configured commit time (the
              // sweep's commit-liveness signal); every other call answers "main".
              stdout: request.args?.[0] === "log" ? (input.latestCommitIso ?? "") : "main",
              stderr: "",
              exitCode: 0,
            }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];

    const setupStub = {
      runForThread: () => Effect.void,
    } as unknown as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];

    // Every merge attempt the reactor makes, so a test can assert that a
    // refusal did NOT silently retry and that a conflict fix did.
    const mergeAttempts = yield* Ref.make<ReadonlyArray<{ readonly number: number }>>([]);
    const pullRequestStub = BoardPullRequestGateway.of({
      find: () => {
        const configured = input.pullRequest;
        if (configured !== undefined && configured !== null && "failWith" in configured) {
          return Effect.fail(
            new BoardPullRequestGatewayError({ operation: "find", detail: configured.failWith }),
          );
        }
        return Effect.succeed(configured ?? null);
      },
      merge: (request) =>
        Ref.update(mergeAttempts, (attempts) => [...attempts, { number: request.number }]).pipe(
          Effect.andThen(
            input.mergeFailure === undefined
              ? Effect.void
              : Effect.fail(
                  new BoardPullRequestGatewayError({
                    operation: "merge",
                    detail: input.mergeFailure,
                  }),
                ),
          ),
        ),
    });

    const deps = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, engineStub),
      Layer.succeed(ProjectionSnapshotQuery, snapshotStub),
      Layer.succeed(ProviderService, providerStub),
      Layer.succeed(ServerSettingsService, settingsStub),
      Layer.succeed(GitVcsDriver.GitVcsDriver, gitStub),
      Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, setupStub),
      Layer.succeed(BoardPullRequestGateway, pullRequestStub),
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
          commands: Ref.get(commands),
          decided: Ref.get(decided),
          mergeAttempts: Ref.get(mergeAttempts),
          removedWorktrees: Ref.get(removedWorktrees),
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

/** A card DELETE. Unlike archive, the reactor cannot re-read anything — the
    card is gone by the time this arrives — so the payload has to carry the
    step state whose slot is being released and the threads being deleted. The
    caller passes the step state it wants released; `null` is a card with no
    live step. */
export const cardDeleted = (
  card: BoardCard,
  sequence: number,
  stepState: BoardCardStepState | null,
): OrchestrationEvent =>
  ({
    type: "board.card-deleted",
    sequence,
    payload: {
      cardId: card.id,
      deletedAt: NOW,
      card,
      threadIds: card.threadLinks.map((link) => link.threadId),
      stepState,
    },
  }) as unknown as OrchestrationEvent;

export const turnCompleted = (threadId: ThreadId): ProviderRuntimeEvent =>
  ({ type: "turn.completed", threadId }) as unknown as ProviderRuntimeEvent;

/** An ORDINARY agent question (t3o-18, D13): the runtime event every provider
    emits when it asks a human, with no board tool call behind it. This is what
    re-sourced `handleInputRequested` now watches. */
export const userInputRequested = (threadId: ThreadId): ProviderRuntimeEvent =>
  ({ type: "user-input.requested", threadId }) as unknown as ProviderRuntimeEvent;

export const stepStatus = (board: BoardState, cardId: BoardCardId) =>
  boardCardStepState(board, cardId)?.status ?? null;

/** The stage a card currently sits in, per the live read model. */
export const cardStage = (board: BoardState, cardId: BoardCardId): BoardStageId | null =>
  board.cards.find((candidate) => candidate.id === cardId)?.stage ?? null;
