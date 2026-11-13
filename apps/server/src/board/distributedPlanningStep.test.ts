/**
 * Planning runs on the board server (T3O-87): live supervisor, real router, remote gateway and
 * signal feed, an in-process worker behind the fake transport, and the card pinned to it. A
 * planning thread already under way on a worker carries on there.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  ProviderInstanceId,
  ThreadId,
  type BoardCardStepState,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  cardMoved,
  codexStep,
  makeBoardCard,
  settingsWith,
  stepCompleted,
  withGovernor,
} from "./supervisorHarness.testkit.ts";
import { makeThreadGatewayRouter } from "./ThreadGatewayRouter.ts";
import { aliveThread } from "./threadGateway.testkit.ts";
import type { BoardThreadState } from "./ThreadGateway.ts";
import { BoardRelayStoreLive } from "./workers/BoardRelayStore.ts";
import {
  CENTRAL_ID,
  makeInProcessWorker,
  placementOver,
  registeredWorker,
  REPOSITORY,
  waitOnline,
  WORKER_ID,
  WORKER_PROJECT_ID,
} from "./workers/distributed.testkit.ts";
import { makeRemoteThreadGateway } from "./workers/RemoteThreadGateway.ts";
import { WorkerConnections } from "./workers/WorkerConnections.ts";
import { makeWorkerSignalFeed } from "./workers/WorkerSignalFeed.ts";

const cardId = BoardCardId.make("card-1");
const PLANNING = String(BOARD_SEED_STAGE_IDS.planning);

const centralLayer = BoardRelayStoreLive.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-accept-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** A planning step the board started on the worker before this card shipped. */
const keptStep = (threadId: string): BoardCardStepState => ({
  cardId,
  stepId: PLANNING,
  stepLabel: "Planning",
  stageLabel: "Planning",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "plan it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "plan",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 60 * 60_000,
  status: "running",
  slotHeld: false,
  forceStart: false,
  queuedBy: null,
  queuedDetail: null,
  threadId: ThreadId.make(threadId),
  startedAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
});

/** The central board over one in-process worker, its threads routed by link. */
const distributed = Effect.fn("distributed")(function* (
  linked: ReadonlyMap<
    ThreadId,
    { readonly workerId: typeof WORKER_ID; readonly removed: boolean }
  > = new Map(),
) {
  const worker: { states?: Ref.Ref<ReadonlyMap<string, BoardThreadState>> } = {};
  const env = yield* makeInProcessWorker({
    onThreadCall: (call) =>
      call.type === "thread.spawn" && worker.states !== undefined
        ? Ref.update(worker.states, (states) =>
            new Map(states).set(
              call.threadId,
              aliveThread(call.threadId, { projectId: WORKER_PROJECT_ID }),
            ),
          )
        : Effect.void,
  });
  worker.states = env.threads.states;
  yield* env.connections.sync([registeredWorker]);
  yield* waitOnline(env.connections);
  const feed = yield* makeWorkerSignalFeed.pipe(
    Effect.provideService(WorkerConnections, env.connections),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const digest = yield* Digest.Digest;
  /** The step's thread, once spawned, and its read after the turn ends. */
  const watched = yield* Ref.make<string | null>(null);
  const turnEndRead = yield* Deferred.make<void>();
  const gateway = (local: Parameters<typeof makeThreadGatewayRouter>[0]["local"]) => {
    const router = makeThreadGatewayRouter({
      local,
      connections: env.connections,
      feed,
      linkedWorkers: () => Effect.succeed(linked),
      remote: (workerId) =>
        makeRemoteThreadGateway({
          workerId,
          connections: env.connections,
          local,
          centralEnvironmentId: CENTRAL_ID,
          fileSystem,
          digest,
        }),
    });
    // The supervisor reading the step's thread after its turn ended:
    // it is handling the signal, and `drain` waits for it to finish.
    return {
      ...router,
      threadState: (id: Parameters<typeof router.threadState>[0]) =>
        router
          .threadState(id)
          .pipe(
            Effect.tap(() =>
              Ref.get(watched).pipe(
                Effect.flatMap((target) =>
                  target === id ? Deferred.succeed(turnEndRead, undefined) : Effect.void,
                ),
              ),
            ),
          ),
    };
  };
  return { env, gateway, watched, turnEndRead };
});

const settings = settingsWith({
  building: [codexStep],
  planning: codexStep,
  globalMaxConcurrent: 3,
});

it.effect("a new planning step runs on the board server, pinned or not, with no placement", () =>
  Effect.gen(function* () {
    const { env, gateway } = yield* distributed();
    const pinned = makeBoardCard({
      id: "card-1",
      stage: "sprint",
      orderKey: "m",
      pinnedWorkerId: WORKER_ID,
    });
    yield* withGovernor(
      {
        board: { cards: [pinned], nextCardNumberByProject: {}, workers: [registeredWorker] },
        settings,
        projectRepository: REPOSITORY,
        gateway,
        placement: placementOver(env.connections),
      },
      ({ pumpDomain, board, commands }) =>
        Effect.gen(function* () {
          yield* pumpDomain(
            cardMoved({ ...pinned, stage: BOARD_SEED_STAGE_IDS.planning }, "sprint", "planning", 1),
          );
          const state = boardCardStepState(yield* board, cardId);
          assert.strictEqual(state?.status, "running");
          // Nothing spawned on the worker; the spawn names no worker.
          assert.isFalse((yield* env.threads.calls).some((call) => call.type === "thread.spawn"));
          const spawn = (yield* commands).find((command) => command.type === "thread.spawn");
          assert.isTrue(spawn?.type === "thread.spawn" && spawn.workerId === undefined);
          const card = (yield* board).cards.find((candidate) => candidate.id === cardId)!;
          assert.isUndefined(card.threadLinks[0]?.workerId);
          assert.isNull(card.placedWorkerId);
        }),
    );
  }).pipe(Effect.scoped, Effect.provide(centralLayer)),
);

it.effect("planning already under way on a worker carries on there to the end", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-kept");
    const { env, gateway } = yield* distributed(
      new Map([[threadId, { workerId: WORKER_ID, removed: false }]]),
    );
    // Mid-turn on the worker.
    yield* Ref.update(env.threads.states, (states) =>
      new Map(states).set(
        threadId,
        aliveThread(threadId, { projectId: WORKER_PROJECT_ID, activeTurnRef: "run-1" }),
      ),
    );
    const planning = {
      ...makeBoardCard({ id: "card-1", stage: PLANNING, orderKey: "m" }),
      threadLinks: [
        {
          threadId,
          role: PLANNING,
          linkedAt: "1970-01-01T00:00:00.000Z",
          tombstonedAt: null,
          workerId: WORKER_ID,
        },
      ],
    };
    yield* withGovernor(
      {
        board: {
          cards: [planning],
          stepStates: [keptStep(threadId)],
          nextCardNumberByProject: {},
          workers: [registeredWorker],
        },
        settings,
        projectRepository: REPOSITORY,
        gateway,
        placement: placementOver(env.connections),
      },
      ({ pumpDomain, board, reactor, commands }) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* reactor.reconcile;
            yield* reactor.drain;
            // Not respawned here: the thread on the worker is still the step's.
            assert.strictEqual(boardCardStepState(yield* board, cardId)?.threadId, threadId);

            // A scheduling pass (another card arriving) starts nothing new for it.
            yield* pumpDomain(
              cardMoved(
                makeBoardCard({ id: "card-2", stage: "sprint", orderKey: "z" }),
                "backlog",
                "sprint",
                2,
              ),
            );
            yield* reactor.drain;
            const kept = boardCardStepState(yield* board, cardId);
            assert.strictEqual(kept?.status, "running");
            assert.strictEqual(kept?.threadId, threadId);
            assert.isFalse((yield* env.threads.calls).some((call) => call.type === "thread.spawn"));
            assert.isFalse((yield* commands).some((command) => command.type === "thread.spawn"));

            // The agent reports (relayed to this board: `relay.test.ts`).
            yield* pumpDomain(stepCompleted(cardId, "succeeded", 3, PLANNING));
            const completed = boardCardStepState(yield* board, cardId);
            assert.notStrictEqual(completed?.status, "running");
          }),
        ),
    );
  }).pipe(Effect.scoped, Effect.provide(centralLayer)),
);
