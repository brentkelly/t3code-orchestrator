/**
 * T3o (T3O-63) acceptance: the board runs a planning step on a worker.
 *
 * The live supervisor, over the real router, remote gateway and signal feed,
 * with an in-process worker behind the fake transport and the card pinned to
 * it (T3O-65). The step's
 * thread is spawned in the worker's checkout, a turn ending there reaches the
 * supervisor, which decides on the thread as the worker reports it, and the
 * step completes.
 */
import { BOARD_SEED_STAGE_IDS, BoardCardId, boardCardStepState } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  cardMoved,
  codexStep,
  makeBoardCard,
  settingsWith,
  stepCompleted,
  turnCompleted,
  withGovernor,
} from "./supervisorHarness.testkit.ts";
import { makeThreadGatewayRouter } from "./ThreadGatewayRouter.ts";
import { aliveThread, idleThread } from "./threadGateway.testkit.ts";
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
  WORKER_ROOT,
} from "./workers/distributed.testkit.ts";
import { makeRemoteThreadGateway } from "./workers/RemoteThreadGateway.ts";
import { WorkerConnections } from "./workers/WorkerConnections.ts";
import { makeWorkerSignalFeed } from "./workers/WorkerSignalFeed.ts";

const cardId = BoardCardId.make("card-1");
const PLANNING = String(BOARD_SEED_STAGE_IDS.planning);

const centralLayer = BoardRelayStoreLive.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-accept-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("the board spawns, drives and completes a planning step on a worker", () =>
  Effect.gen(function* () {
    // The worker's engine: a spawned thread comes up running its first turn.
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
      Effect.provide(Layer.succeed(WorkerConnections, env.connections)),
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;

    yield* withGovernor(
      {
        board: {
          cards: [
            makeBoardCard({
              id: "card-1",
              stage: "sprint",
              orderKey: "m",
              pinnedWorkerId: WORKER_ID,
            }),
          ],
          nextCardNumberByProject: {},
          workers: [registeredWorker],
        },
        settings: settingsWith({
          building: [codexStep],
          planning: codexStep,
          globalMaxConcurrent: 3,
        }),
        projectRepository: REPOSITORY,
        gateway: (local) =>
          makeThreadGatewayRouter({
            local,
            connections: env.connections,
            feed,
            linkedWorker: () => Effect.succeed(null),
            remote: (workerId) =>
              makeRemoteThreadGateway({
                workerId,
                connections: env.connections,
                local,
                centralEnvironmentId: CENTRAL_ID,
                fileSystem,
                crypto,
              }),
          }),
        placement: placementOver(env.connections),
      },
      ({ pumpDomain, board, reactor }) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* pumpDomain(
              cardMoved(
                makeBoardCard({
                  id: "card-1",
                  stage: "planning",
                  orderKey: "m",
                  pinnedWorkerId: WORKER_ID,
                }),
                "sprint",
                "planning",
                1,
              ),
            );

            // Spawned on the worker, in its checkout, and linked as such.
            const state = boardCardStepState(yield* board, cardId);
            assert.strictEqual(state?.status, "running");
            const threadId = state?.threadId ?? null;
            assert.isNotNull(threadId);
            if (threadId === null) return;
            const spawn = (yield* env.threads.calls).find((call) => call.type === "thread.spawn");
            assert.isTrue(spawn?.type === "thread.spawn" && spawn.threadId === threadId);
            if (spawn?.type !== "thread.spawn") return;
            assert.strictEqual(spawn.projectId, WORKER_PROJECT_ID);
            assert.strictEqual(spawn.worktreePath, WORKER_ROOT);
            const link = (yield* board).cards
              .find((card) => card.id === cardId)
              ?.threadLinks.find((entry) => entry.threadId === threadId);
            assert.strictEqual(link?.workerId, WORKER_ID);

            // The agent stops without reporting. The turn's end travels from the
            // worker to the supervisor, which reads the thread there and parks
            // the step for a human, as it would a local one.
            yield* Ref.update(env.threads.states, (states) =>
              new Map(states).set(threadId, {
                ...idleThread(threadId),
                projectId: WORKER_PROJECT_ID,
              }),
            );
            const signals = yield* feed.subscribeSignals;
            yield* env.threads.emit(turnCompleted(threadId, "run-1"));
            // The feed publishes to every subscriber at once: once this one has
            // it, the supervisor's has too.
            yield* Stream.runHead(signals);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* reactor.drain;
            assert.strictEqual(boardCardStepState(yield* board, cardId)?.status, "awaiting-input");

            // The agent reports (relayed to this board: `relay.test.ts`).
            yield* pumpDomain(stepCompleted(cardId, "succeeded", 2, PLANNING));
            const completed = boardCardStepState(yield* board, cardId);
            assert.notStrictEqual(completed?.status, "running");
          }),
        ),
    );
  }).pipe(Effect.scoped, Effect.provide(centralLayer)),
);
