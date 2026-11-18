/**
 * T3o: the router's batch read across this server and its workers.
 *
 * The worker is in process (`distributed.testkit.ts`) behind the fake
 * transport; the thread links and the worker registry are rows in a real
 * board database, so the batch worker lookup runs its real query.
 */
import { CommandId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { aliveThread, fakeThreadState, makeFakeThreadGateway } from "./threadGateway.testkit.ts";
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
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const LOCAL_THREAD = ThreadId.make("thread-local");
const WORKER_THREAD = ThreadId.make("thread-on-worker");
const REMOVED_THREAD = ThreadId.make("thread-on-removed-worker");
const DELETED_WORKER_THREAD = ThreadId.make("thread-deleted-on-worker");

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
    [DELETED_WORKER_THREAD, WORKER_ID],
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
  yield* env.threads.gateway.spawn({
    commandId: CommandId.make("server:board-spawn:worker-deleted"),
    threadId: DELETED_WORKER_THREAD,
    projectId: WORKER_PROJECT_ID,
    title: "CARD-1 · Planning",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: WORKER_ROOT,
    text: "Plan the card.",
    attachments: [],
  });
  yield* env.threads.gateway.delete({
    commandId: CommandId.make("server:board-delete:worker-deleted"),
    threadId: DELETED_WORKER_THREAD,
  });
  const central = yield* makeFakeThreadGateway({
    threads: new Map([[LOCAL_THREAD, fakeThreadState(LOCAL_THREAD, { settlementDecided: true })]]),
  });
  yield* env.connections.sync([registeredWorker]);
  yield* waitOnline(env.connections);
  const fileSystem = yield* FileSystem.FileSystem;
  const digest = yield* Digest.Digest;
  const router = makeThreadGatewayRouter({
    local: central.gateway,
    feed: emptyWorkerSignalFeed,
    linkedWorkers: makeLinkedThreadWorkers(sql, CENTRAL_ID),
    remote: (workerId) =>
      makeRemoteThreadGateway({
        workerId,
        connections: env.connections,
        local: central.gateway,
        centralEnvironmentId: CENTRAL_ID,
        fileSystem,
        digest,
      }),
  });
  return { ...env, central, router };
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
        // A worker thread's title crosses the wire for the card's label; a deleted one has none.
        assert.strictEqual(records.get(WORKER_THREAD)?.title, "CARD-1 · Building");
        const withDeleted = yield* router.threadRecords([DELETED_WORKER_THREAD]);
        assert.isTrue(withDeleted.get(DELETED_WORKER_THREAD)?.deleted);
        assert.notProperty(withDeleted.get(DELETED_WORKER_THREAD), "title");
        // A removed worker's thread is left out, never asked of a gone worker.
        assert.strictEqual((yield* router.threadRecords([REMOVED_THREAD])).size, 0);

        // The release sweep's read: the settled local thread is finished, so it is in neither set.
        const sweep = yield* router.openThreadIds([
          LOCAL_THREAD,
          WORKER_THREAD,
          DELETED_WORKER_THREAD,
          REMOVED_THREAD,
        ]);
        assert.deepStrictEqual([...sweep.open], [WORKER_THREAD]);
        assert.deepStrictEqual([...sweep.unanswered], [REMOVED_THREAD]);
        // Only the deleted worker thread is deleted; the settled one can still be reopened.
        assert.deepStrictEqual([...sweep.deleted], [DELETED_WORKER_THREAD]);
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

        // The sweep's read never fails on a worker: its threads come back unanswered, so an
        // abandoned one there is kept rather than read as finished.
        const sweep = yield* router.openThreadIds([LOCAL_THREAD, WORKER_THREAD, REMOVED_THREAD]);
        assert.strictEqual(sweep.open.size, 0);
        assert.deepStrictEqual(
          [...sweep.unanswered].toSorted(),
          [REMOVED_THREAD, WORKER_THREAD].toSorted(),
        );
      }),
    ),
  );
});

describe("the thread gateway router's pull request links (T3O-75)", () => {
  const pullRequest = { host: "github.com", repository: "acme/repo", number: 7 };

  it.effect("links and unlinks on the worker the thread lives on", () =>
    run(
      Effect.gen(function* () {
        const { router, threads: worker, central } = yield* setup;
        yield* router.linkPullRequest({
          commandId: CommandId.make("server:board-pr-link:worker"),
          threadId: WORKER_THREAD,
          ...pullRequest,
          url: "https://github.com/acme/repo/pull/7",
        });
        yield* router.linkPullRequest({
          commandId: CommandId.make("server:board-pr-link:local"),
          threadId: LOCAL_THREAD,
          ...pullRequest,
          url: "https://github.com/acme/repo/pull/7",
        });
        const onWorker = yield* worker.pullRequestLinks;
        const onCentral = yield* central.pullRequestLinks;
        assert.deepStrictEqual(onWorker.get(WORKER_THREAD), ["github.com/acme/repo#7"]);
        assert.isFalse(onWorker.has(LOCAL_THREAD));
        assert.deepStrictEqual(onCentral.get(LOCAL_THREAD), ["github.com/acme/repo#7"]);
        assert.isFalse(onCentral.has(WORKER_THREAD));

        yield* router.unlinkPullRequest({
          commandId: CommandId.make("server:board-pr-unlink:worker"),
          threadId: WORKER_THREAD,
          ...pullRequest,
        });
        assert.deepStrictEqual((yield* worker.pullRequestLinks).get(WORKER_THREAD), []);
      }),
    ),
  );
});

describe("the thread gateway router's schedule runs (T3O-118)", () => {
  const SCHEDULE_THREAD = ThreadId.make("thread-schedule-on-worker");
  const LOCAL_SCHEDULE_THREAD = ThreadId.make("thread-schedule-local");
  const GONE_SCHEDULE_THREAD = ThreadId.make("thread-schedule-removed-worker");

  it.effect("routes a schedule run with no card to the worker its run is recorded on", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { router, threads: worker } = yield* setup;
        for (const [threadId, environmentId] of [
          [SCHEDULE_THREAD, WORKER_ID],
          [LOCAL_SCHEDULE_THREAD, CENTRAL_ID],
          [GONE_SCHEDULE_THREAD, "env-removed"],
        ] as const) {
          yield* sql`
            INSERT INTO boards.schedule_run_threads
              (thread_id, project_id, file_id, environment_id, started_at)
            VALUES (${threadId}, 'project-1', 'nightly', ${environmentId}, '2026-01-01T00:00:00.000Z')
          `;
        }
        yield* worker.gateway.spawn({
          commandId: CommandId.make("server:board-schedule:worker"),
          threadId: SCHEDULE_THREAD,
          projectId: WORKER_PROJECT_ID,
          title: "nightly",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "t3o/schedule-run-1",
          worktreePath: `${WORKER_ROOT}-run`,
          text: "Run the nightly.",
          attachments: [],
        });
        yield* Ref.update(worker.states, (states) =>
          new Map(states).set(SCHEDULE_THREAD, aliveThread(SCHEDULE_THREAD)),
        );
        // Never spawned through the router, so nothing in its memory: the database answers.
        const state = yield* router.threadState(SCHEDULE_THREAD);
        assert.strictEqual(
          state === null || state === "unknown" ? null : state.threadId,
          SCHEDULE_THREAD,
        );
        const sweep = yield* router.openThreadIds([
          SCHEDULE_THREAD,
          LOCAL_SCHEDULE_THREAD,
          GONE_SCHEDULE_THREAD,
        ]);
        assert.deepStrictEqual([...sweep.open], [SCHEDULE_THREAD]);
        // A run on this server stays this server's; a removed worker's is never asked.
        assert.deepStrictEqual([...sweep.unanswered], [GONE_SCHEDULE_THREAD]);
      }),
    ),
  );
});
