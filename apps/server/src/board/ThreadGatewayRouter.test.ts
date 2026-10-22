/**
 * T3o (T3O-63): the router's batch read across this server and its workers.
 *
 * The worker is in process (`distributed.testkit.ts`) behind the fake
 * transport; the thread links and the worker registry are rows in a real
 * board database, so the batch worker lookup runs its real query.
 */
import { CommandId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { fakeThreadState, makeFakeThreadGateway } from "./threadGateway.testkit.ts";
import { makeLinkedThreadWorkers, makeThreadGatewayRouter } from "./ThreadGatewayRouter.ts";
import {
  CENTRAL_ID,
  makeInProcessWorker,
  registeredWorker,
  waitOffline,
  waitOnline,
  WORKER_ID,
  WORKER_PROJECT_ID,
  WORKER_ROOT,
} from "./workers/distributed.testkit.ts";
import { makeRemoteThreadGateway } from "./workers/RemoteThreadGateway.ts";
import { emptyWorkerSignalFeed } from "./workers/WorkerSignalFeed.ts";

const database = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-router-" })),
  Layer.provideMerge(NodeServices.layer),
);

const LOCAL_THREAD = ThreadId.make("thread-local");
const WORKER_THREAD = ThreadId.make("thread-on-worker");
const REMOVED_THREAD = ThreadId.make("thread-on-removed-worker");

/** This server with one settled thread of its own, the in-process worker
    with one thread, and a link for each — plus one to a worker the board
    has since removed. */
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO board_workers (worker_id, label, url, added_at)
    VALUES (${WORKER_ID}, 'w1', 'http://w1:3773', '2026-01-01T00:00:00.000Z')
  `;
  for (const [threadId, workerId] of [
    [LOCAL_THREAD, null],
    [WORKER_THREAD, WORKER_ID],
    [REMOVED_THREAD, "env-removed"],
  ] as const) {
    yield* sql`
      INSERT INTO board_card_thread_links (thread_id, card_id, role, linked_at, worker_id)
      VALUES (${threadId}, 'card-1', 'building', '2026-01-01T00:00:00.000Z', ${workerId})
    `;
  }

  const env = yield* makeInProcessWorker();
  yield* env.threads.gateway.spawn({
    commandId: CommandId.make("server:board-spawn:worker"),
    threadId: WORKER_THREAD,
    projectId: WORKER_PROJECT_ID,
    title: "CARD-1 · Building",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: WORKER_ROOT,
    text: "Build the card.",
    attachments: [],
  });
  const central = yield* makeFakeThreadGateway({
    threads: new Map([[LOCAL_THREAD, fakeThreadState(LOCAL_THREAD, { settlementDecided: true })]]),
  });
  yield* env.connections.sync([registeredWorker]);
  yield* waitOnline(env.connections);
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const router = makeThreadGatewayRouter({
    local: central.gateway,
    connections: env.connections,
    feed: emptyWorkerSignalFeed,
    linkedWorkers: makeLinkedThreadWorkers(sql),
    remote: (workerId) =>
      makeRemoteThreadGateway({
        workerId,
        connections: env.connections,
        local: central.gateway,
        centralEnvironmentId: CENTRAL_ID,
        fileSystem,
        crypto,
      }),
  });
  return { ...env, router };
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(database));

describe("the thread gateway router's batch read", () => {
  it.effect("answers for every worker that can, in one batch", () =>
    run(
      Effect.gen(function* () {
        const { router } = yield* setup;
        const records = yield* router.threadRecords([LOCAL_THREAD, WORKER_THREAD, REMOVED_THREAD]);
        assert.deepStrictEqual([...records.keys()].toSorted(), [LOCAL_THREAD, WORKER_THREAD]);
        assert.isTrue(records.get(LOCAL_THREAD)?.settlementDecided);
        // A removed worker's thread is left out, never asked of a gone worker.
        assert.strictEqual((yield* router.threadRecords([REMOVED_THREAD])).size, 0);
      }),
    ),
  );

  it.effect("an offline worker leaves out only its own threads", () =>
    run(
      Effect.gen(function* () {
        const { router, kit, worker, connections } = yield* setup;
        yield* kit.fake.drop(worker);
        yield* waitOffline(connections);

        const records = yield* router.threadRecords([LOCAL_THREAD, WORKER_THREAD, REMOVED_THREAD]);
        assert.deepStrictEqual([...records.keys()], [LOCAL_THREAD]);
        assert.isTrue(records.get(LOCAL_THREAD)?.settlementDecided);

        // Asked about nothing but the offline worker's thread, the read fails
        // rather than reporting a thread that never existed.
        const error = yield* Effect.flip(router.threadRecords([WORKER_THREAD]));
        assert.strictEqual(error._tag, "ThreadReadError");
      }),
    ),
  );
});
