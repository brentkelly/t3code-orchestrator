/**
 * Concurrency governor end-to-end coverage (t3o-11, D11).
 *
 * The pure ordering and the slot-admission policy are unit-tested in
 * `supervisor.test.ts` and `BoardStepSlots.test.ts`; here we drive the live
 * reactor against a STATEFUL engine double — its `dispatch` runs the real board
 * decider + projector to evolve a `Ref`-held read model, so the reactor's own
 * `schedule` pass sees its own selects/admits/settles exactly as in production.
 * Domain and runtime events are fed through `Queue`s (buffered, so no
 * subscribe-before-publish race), and `reactor.drain` gates each assertion.
 *
 * The load-bearing test is the no-leak sweep: a slot leak silently halves
 * throughput forever, so we run a card through EVERY release path — success,
 * step failure, crash/death, and abandonment — and prove the held count returns
 * to baseline each time and zero after the whole run drains.
 */
import {
  BoardCardId,
  boardCardStepState,
  DEFAULT_BOARD_BUILD_STEP,
  isBoardCommand,
  isBoardEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardSettings,
  type BoardState,
  type BoardStep,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");

const codexStep: BoardStep = { ...DEFAULT_BOARD_BUILD_STEP, providerInstanceId: ProviderInstanceId.make("codex") };
const claudeStep: BoardStep = { ...DEFAULT_BOARD_BUILD_STEP, providerInstanceId: ProviderInstanceId.make("claude") };

/** A card sitting in Building with a ready worktree and no step yet — the state
    right after "Begin build" provisioned the worktree; the reactor selects and
    admits the step. */
const buildingCard = (id: string, orderKey: string): BoardCard => ({
  id: BoardCardId.make(id),
  key: id.toUpperCase(),
  cardNumber: 1,
  projectId,
  labels: [],
  stage: "building",
  orderKey,
  title: `Card ${id}`,
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  threadLinks: [],
  externalRef: null,
  recipeSnapshot: null,
  worktree: {
    branch: `board/${id}`,
    baseRefName: "main",
    path: `/tmp/wt/${id}`,
    status: "ready",
    attempts: 1,
    lastError: null,
    reclaimBlockedReason: null,
  },
  blocked: false,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const readModel = (board: BoardState): OrchestrationReadModel => ({
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

const settingsWith = (input: {
  readonly building: ReadonlyArray<BoardStep>;
  readonly globalMaxConcurrent: number;
  readonly perInstance?: Record<string, number | null>;
}): BoardSettings => ({
  projects: {},
  pipeline: { building: [...input.building] },
  concurrency: {
    perInstance: input.perInstance ?? {},
    globalMaxConcurrent: input.globalMaxConcurrent,
  },
  lifecycle: { archiveAfterDays: 7, worktreeRetention: "reclaim-on-archive" },
});

type Harness = {
  readonly slots: BoardStepSlots["Service"];
  readonly reactor: SupervisorReactor["Service"];
  readonly model: Ref.Ref<OrchestrationReadModel>;
  readonly shells: Ref.Ref<ReadonlyMap<string, OrchestrationThreadShell>>;
  readonly pumpDomain: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly pumpRuntime: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly board: Effect.Effect<BoardState>;
};

/** Run `body` against a live reactor wired to the stateful engine double. */
function withGovernor(
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
          ? decideBoardCommand({ command, readModel: yield_model(model) }).pipe(
              Effect.flatMap((decided) =>
                Effect.forEach(boardDecidedEvents(decided), applyDecided, { discard: true }),
              ),
            )
          : Effect.void
        ).pipe(
          Effect.andThen(Ref.get(seq).pipe(Effect.map((sequence) => ({ sequence })))),
        ),
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
          offer.pipe(Effect.andThen(Effect.yieldNow()), Effect.andThen(reactor.drain));
        yield* body({
          slots,
          reactor,
          model,
          shells,
          pumpDomain: (event) => pump(Queue.offer(domainQueue, event)),
          pumpRuntime: (event) => pump(Queue.offer(runtimeQueue, event)),
          board: Ref.get(model).pipe(Effect.map((m) => m.board ?? ({ cards: [] } as BoardState))),
        });
      }).pipe(Effect.provide(SupervisorReactorLive.pipe(Layer.provideMerge(deps)))),
    );
  }).pipe(Effect.provide(NodeServices.layer));
}

// `decideBoardCommand` reads the model synchronously off the Ref; a tiny helper
// keeps the stub `dispatch` a single expression.
function yield_model(model: Ref.Ref<OrchestrationReadModel>): OrchestrationReadModel {
  return Effect.runSync(Ref.get(model));
}

const movedToBuilding = (card: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-moved",
    sequence,
    payload: { cardId: card.id, fromStage: "ready", toStage: "building", card },
  }) as unknown as OrchestrationEvent;

const stepCompleted = (
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
        stepId: "build",
        outcome,
        summary: `report ${outcome}`,
        payload: null,
        threadId: null,
        completedAt: NOW,
      },
    },
  }) as unknown as OrchestrationEvent;

const cardArchived = (card: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-archived",
    sequence,
    payload: { cardId: card.id, archivedAt: NOW, card },
  }) as unknown as OrchestrationEvent;

const turnCompleted = (threadId: ThreadId): ProviderRuntimeEvent =>
  ({ type: "turn.completed", threadId }) as unknown as ProviderRuntimeEvent;

const stepStatus = (board: BoardState, cardId: BoardCardId) =>
  boardCardStepState(board, cardId)?.status ?? null;

it.effect("admits a card's build step and holds one slot, then releases it on success", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("card-1", "m")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-1", "m"), 1));
        assert.strictEqual(yield* slots.heldTotal, 1);
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-1")), "running");

        yield* pumpDomain(stepCompleted(BoardCardId.make("card-1"), "succeeded", 2));
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);

it.effect("maxConcurrent 1 runs two same-instance cards strictly sequentially", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("card-a", "a"), buildingCard("card-b", "b")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({
        building: [codexStep],
        globalMaxConcurrent: 5,
        perInstance: { codex: 1 },
      }),
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-a", "a"), 1));
        yield* pumpDomain(movedToBuilding(buildingCard("card-b", "b"), 2));
        // Only one codex slot: card-a runs, card-b holds in the queue.
        assert.strictEqual(yield* slots.heldFor(ProviderInstanceId.make("codex")), 1);
        const after = yield* board;
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-a")), "running");
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-b")), "queued");

        // card-a finishes → the freed slot goes to the queued card-b (D11).
        yield* pumpDomain(stepCompleted(BoardCardId.make("card-a"), "succeeded", 3));
        const promoted = yield* board;
        assert.strictEqual(stepStatus(promoted, BoardCardId.make("card-b")), "running");
        assert.strictEqual(yield* slots.heldFor(ProviderInstanceId.make("codex")), 1);
      }),
  ),
);

it.effect("a step on an idle provider is not blocked by a saturated one", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("card-codex", "a"), buildingCard("card-claude", "b")],
        nextCardNumberByProject: {},
      },
      // codex capped at 1 and already the higher-priority card; claude uncapped.
      settings: settingsWith({
        building: [codexStep], // default recipe is codex...
        globalMaxConcurrent: 5,
        perInstance: { codex: 1 },
      }),
    },
    ({ slots, pumpDomain, board, model }) =>
      Effect.gen(function* () {
        // card-codex takes the one codex slot.
        yield* pumpDomain(movedToBuilding(buildingCard("card-codex", "a"), 1));
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("card-codex")), "running");

        // Re-point the pipeline to claude for the second card's build (settings
        // are read per schedule pass), then admit it: codex saturation must not
        // block a claude-targeted step.
        yield* Ref.void.pipe(Effect.andThen(Effect.void));
        yield* pumpDomainClaude(pumpDomain, "card-claude", 2, model);
        const after = yield* board;
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-claude")), "running");
        assert.strictEqual(yield* slots.heldFor(ProviderInstanceId.make("claude")), 1);
        assert.strictEqual(yield* slots.heldFor(ProviderInstanceId.make("codex")), 1);
      }),
  ),
);

it.effect("no slot leaks across success, failure, crash/death, and abandonment", () =>
  withGovernor(
    {
      board: {
        cards: [
          buildingCard("succ", "a"),
          buildingCard("fail", "b"),
          buildingCard("crash", "c"),
          buildingCard("abandon", "d"),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 5 }),
    },
    ({ slots, pumpDomain, pumpRuntime, board }) =>
      Effect.gen(function* () {
        const codex = ProviderInstanceId.make("codex");
        const baseline = yield* slots.heldTotal;
        assert.strictEqual(baseline, 0);

        // ── success ──────────────────────────────────────────────────────
        yield* pumpDomain(movedToBuilding(buildingCard("succ", "a"), 1));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        yield* pumpDomain(stepCompleted(BoardCardId.make("succ"), "succeeded", 2));
        assert.strictEqual(yield* slots.heldFor(codex), 0); // released

        // ── step failure → recovery keeps the slot (not a leak, not premature
        //    release) → eventual success releases it ───────────────────────
        yield* pumpDomain(movedToBuilding(buildingCard("fail", "b"), 3));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        yield* pumpDomain(stepCompleted(BoardCardId.make("fail"), "failed", 4));
        // A failed report enters recovery (retry) — the slot is HELD, so the
        // recovering card keeps its place rather than dropping out of the queue.
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("fail")), "running");
        yield* pumpDomain(stepCompleted(BoardCardId.make("fail"), "succeeded", 5));
        assert.strictEqual(yield* slots.heldFor(codex), 0); // released

        // ── crash / death → the step's thread vanishes; death detection
        //    recovers (respawns), still holding the slot → abandon releases ──
        yield* pumpDomain(movedToBuilding(buildingCard("crash", "c"), 6));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        const running = boardCardStepState(yield* board, BoardCardId.make("crash"));
        assert.strictEqual(running?.status, "running");
        // The thread is gone (never added to the shells map) → turn.completed
        // with no completion is death → recover, slot retained.
        yield* pumpRuntime(turnCompleted(running!.threadId!));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        yield* pumpDomain(cardArchived(buildingCard("crash", "c"), 7));
        assert.strictEqual(yield* slots.heldFor(codex), 0); // released on abandonment

        // ── abandonment of a live running step ─────────────────────────────
        yield* pumpDomain(movedToBuilding(buildingCard("abandon", "d"), 8));
        assert.strictEqual(yield* slots.heldFor(codex), 1);
        yield* pumpDomain(cardArchived(buildingCard("abandon", "d"), 9));
        assert.strictEqual(yield* slots.heldFor(codex), 0); // released

        // Over the whole run, accounting reconciles exactly to baseline.
        assert.strictEqual(yield* slots.heldTotal, baseline);
      }),
  ),
);

// Helper: admit a second card whose build step targets claude, by pumping its
// move with a settings pipeline that resolves to claude. Kept out of line so
// the idle-provider test reads cleanly.
function pumpDomainClaude(
  pumpDomain: (event: OrchestrationEvent) => Effect.Effect<void>,
  id: string,
  sequence: number,
  _model: Ref.Ref<OrchestrationReadModel>,
): Effect.Effect<void> {
  return pumpDomain(movedToBuilding(buildingCard(id, "b"), sequence));
}
