/**
 * The board's thread gateway on a central server (T3O-63, D9/D19): one
 * `ThreadGateway` over this server's own threads and every worker's.
 *
 * The supervisor keeps calling one gateway. Each call goes where its thread
 * lives: a spawn to the worker it names (absent means here), every other
 * thread call to the worker its card's thread link names, and anything
 * without a thread — projects, the todo log — to this server. The supervisor
 * names the card's worker (T3O-65); on a local-only board that is always this
 * server, so everything routes here exactly as before.
 *
 * `observe` merges this server's signals with every worker's
 * (`WorkerSignalFeed`). Each worker's todo signals are applied by the feed,
 * so the todo log here is this server's alone.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  EnvironmentId,
  ThreadId,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  LocalThreadGateway,
  ThreadCommandFailedError,
  ThreadGateway,
  ThreadReadError,
  type BoardThreadRecord,
  type ThreadCommandError,
  type LocalThreadGatewayShape,
  type ThreadGatewayShape,
} from "./ThreadGateway.ts";
import {
  makeRemoteThreadGateway,
  type RemoteThreadGatewayShape,
} from "./workers/RemoteThreadGateway.ts";
import { WorkerConnections, type WorkerConnectionsShape } from "./workers/WorkerConnections.ts";
import { WorkerSignalFeed, type WorkerSignalFeedShape } from "./workers/WorkerSignalFeed.ts";

/** How many spawns the router remembers the worker of, for the moment between
    a spawn and its thread link landing. */
const SPAWNED_MEMORY = 1024;

/** Where a linked thread lives, and whether that worker has since been
    removed from the board. */
export interface LinkedThreadWorker {
  readonly workerId: BoardWorkerId;
  readonly removed: boolean;
}

export interface ThreadGatewayRouterDeps {
  readonly local: LocalThreadGatewayShape;
  readonly connections: WorkerConnectionsShape;
  readonly feed: WorkerSignalFeedShape;
  /** Where each linked thread lives, in one read. Ids no card links are
      absent: they are this server's. */
  readonly linkedWorkers: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyMap<ThreadId, LinkedThreadWorker>, Error>;
  /** One worker's gateway. */
  readonly remote: (workerId: EnvironmentId) => RemoteThreadGatewayShape;
}

export const makeThreadGatewayRouter = (deps: ThreadGatewayRouterDeps): ThreadGatewayShape => {
  const { local } = deps;
  const spawnedOn = new Map<ThreadId, EnvironmentId>();
  const remember = (threadId: ThreadId, workerId: EnvironmentId) => {
    spawnedOn.set(threadId, workerId);
    if (spawnedOn.size > SPAWNED_MEMORY) {
      const oldest = spawnedOn.keys().next().value;
      if (oldest !== undefined) spawnedOn.delete(oldest);
    }
  };

  /** Where each thread lives, in one query for every id the spawn memory
      does not answer. A thread no card links is this server's. */
  const workersOf = (
    threadIds: ReadonlyArray<ThreadId>,
  ): Effect.Effect<ReadonlyMap<ThreadId, LinkedThreadWorker>, ThreadReadError> => {
    const found = new Map<ThreadId, LinkedThreadWorker>();
    const unknown: Array<ThreadId> = [];
    for (const threadId of threadIds) {
      const spawned = spawnedOn.get(threadId);
      if (spawned === undefined) unknown.push(threadId);
      else found.set(threadId, { workerId: spawned, removed: false });
    }
    if (unknown.length === 0) return Effect.succeed(found);
    return deps.linkedWorkers(unknown).pipe(
      Effect.map((linked) => {
        for (const threadId of unknown) {
          found.set(
            threadId,
            linked.get(threadId) ?? { workerId: BOARD_LOCAL_WORKER_ID, removed: false },
          );
        }
        return found;
      }),
      Effect.mapError(
        (cause) =>
          new ThreadReadError({
            operation: "threadWorker",
            detail:
              unknown.length === 1
                ? `Couldn't read which worker thread ${unknown[0]} lives on.`
                : `Couldn't read which workers ${unknown.length} threads live on.`,
            cause,
          }),
      ),
    );
  };

  const workerOf = (threadId: ThreadId): Effect.Effect<BoardWorkerId, ThreadReadError> =>
    workersOf([threadId]).pipe(
      Effect.map((workers) => workers.get(threadId)?.workerId ?? BOARD_LOCAL_WORKER_ID),
    );

  const gatewayFor = (workerId: BoardWorkerId): RemoteThreadGatewayShape =>
    workerId === BOARD_LOCAL_WORKER_ID ? local : deps.remote(workerId);

  /** A thread command, sent to the thread's worker. A worker that cannot be
      read is a failed command, never one silently sent here instead. */
  const routed =
    <I extends { readonly threadId: ThreadId }, A>(
      name: string,
      pick: (
        gateway: RemoteThreadGatewayShape,
      ) => (input: I) => Effect.Effect<A, ThreadCommandError>,
    ) =>
    (input: I): Effect.Effect<A, ThreadCommandError> =>
      workerOf(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadCommandFailedError({
              command: name,
              threadId: input.threadId,
              detail: cause.detail,
              cause,
            }),
        ),
        Effect.flatMap((workerId) => pick(gatewayFor(workerId))(input)),
      );

  const routedRead =
    <A>(
      pick: (
        gateway: RemoteThreadGatewayShape,
      ) => (threadId: ThreadId) => Effect.Effect<A, ThreadReadError>,
    ) =>
    (threadId: ThreadId) =>
      workerOf(threadId).pipe(Effect.flatMap((workerId) => pick(gatewayFor(workerId))(threadId)));

  const registeredWorkers = deps.connections.current.pipe(
    Effect.map((runtime) => [...runtime.keys()]),
  );

  return {
    spawn: (input) => {
      const workerId = input.workerId;
      if (workerId === undefined) return local.spawn(input);
      remember(input.threadId, workerId);
      return deps.remote(workerId).spawn(input);
    },
    send: routed("send", (gateway) => gateway.send),
    interrupt: routed("interrupt", (gateway) => gateway.interrupt),
    stopSession: routed("stopSession", (gateway) => gateway.stopSession),
    settle: routed("settle", (gateway) => gateway.settle),
    delete: routed("delete", (gateway) => gateway.delete),
    armLimitRecovery: routed("armLimitRecovery", (gateway) => gateway.armLimitRecovery),
    threadState: routedRead((gateway) => gateway.threadState),
    latestAssistantMessage: routedRead((gateway) => gateway.latestAssistantMessage),
    lastSignalAt: routedRead((gateway) => gateway.lastSignalAt),
    pendingTurnStartAt: routedRead((gateway) => gateway.pendingTurnStartAt),

    // Best-effort per worker, because the release sweep asks about every
    // link on the board at once: a removed worker's threads are left out (no
    // one can answer for them again), and so are those of a worker that
    // cannot answer right now, so one offline worker never stalls releases
    // everywhere else. The read fails only when no worker named answered, so
    // a single thread's lookup (the engine's link and unlink checks) still
    // fails rather than reading an unreachable thread as one that never
    // existed.
    threadRecords: (threadIds) =>
      Effect.gen(function* () {
        const byWorker = new Map<BoardWorkerId, Array<ThreadId>>();
        for (const [threadId, { workerId, removed }] of yield* workersOf(threadIds)) {
          if (removed) continue;
          const ids = byWorker.get(workerId);
          if (ids === undefined) byWorker.set(workerId, [threadId]);
          else ids.push(threadId);
        }
        const found = new Map<ThreadId, BoardThreadRecord>();
        let failure: ThreadReadError | null = null;
        let answered = false;
        for (const [workerId, ids] of byWorker) {
          if (workerId === BOARD_LOCAL_WORKER_ID) {
            for (const [threadId, record] of yield* local.threadRecords(ids)) {
              found.set(threadId, record);
            }
            answered = true;
            continue;
          }
          const remote = yield* Effect.result(deps.remote(workerId).threadRecords(ids));
          if (remote._tag === "Failure") {
            failure = remote.failure;
            continue;
          }
          for (const [threadId, record] of remote.success) found.set(threadId, record);
          answered = true;
        }
        if (failure !== null && !answered) return yield* failure;
        return found;
      }),
    // Every live thread anywhere. A registered worker that cannot answer
    // fails the read, so a sweep keyed on it never mistakes that worker's
    // threads for deleted ones.
    listLiveThreadIds: () =>
      Effect.gen(function* () {
        const ids = [...(yield* local.listLiveThreadIds())];
        for (const workerId of yield* registeredWorkers) {
          ids.push(...(yield* deps.remote(workerId).listLiveThreadIds()));
        }
        return ids;
      }),

    // Worktree retirement on a worker is T3O-64's: worktrees are this server's.
    threadsInWorktree: local.threadsInWorktree,
    projects: local.projects,
    project: local.project,

    observe: Stream.merge(
      local.observe,
      Stream.unwrap(
        Effect.map(
          deps.feed.subscribeSignals,
          Stream.map((tagged) => tagged.signal),
        ),
      ),
    ),
    todoLogHead: local.todoLogHead,
    readTodoLog: local.readTodoLog,
    subscribeTodoLog: local.subscribeTodoLog,
  };
};

/** The `linkedWorkers` read over the board's thread links: one query for the
    whole batch. Tombstoned links included, since a deleted thread still
    answers where it was. */
export const makeLinkedThreadWorkers = (sql: SqlClient.SqlClient) => {
  const find = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      threadId: ThreadId,
      workerId: Schema.NullOr(EnvironmentId),
      removed: Schema.Number,
    }),
    execute: (threadIdsJson) => sql`
      SELECT
        links.thread_id AS "threadId",
        links.worker_id AS "workerId",
        (links.worker_id IS NOT NULL AND workers.worker_id IS NULL) AS "removed"
      FROM board_card_thread_links AS links
      LEFT JOIN board_workers AS workers ON workers.worker_id = links.worker_id
      WHERE links.thread_id IN (SELECT value FROM json_each(${threadIdsJson}))
    `,
  });
  return (
    threadIds: ReadonlyArray<ThreadId>,
  ): Effect.Effect<ReadonlyMap<ThreadId, LinkedThreadWorker>, Error> =>
    find(JSON.stringify(threadIds)).pipe(
      Effect.map(
        (rows) =>
          new Map(
            rows.map((row): [ThreadId, LinkedThreadWorker] => [
              row.threadId,
              { workerId: row.workerId ?? BOARD_LOCAL_WORKER_ID, removed: row.removed !== 0 },
            ]),
          ),
      ),
    );
};

/** The router as the board's `ThreadGateway`, over this server's own gateway,
    its worker connections and their signal feed. */
export const ThreadGatewayRouterLive = Layer.effect(
  ThreadGateway,
  Effect.gen(function* () {
    const local = yield* LocalThreadGateway;
    const connections = yield* WorkerConnections;
    const feed = yield* WorkerSignalFeed;
    const linkedWorkers = makeLinkedThreadWorkers(yield* SqlClient.SqlClient);
    const centralEnvironmentId = yield* Effect.flatMap(
      ServerEnvironment,
      (environment) => environment.getEnvironmentId,
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const remotes = new Map<EnvironmentId, RemoteThreadGatewayShape>();
    return makeThreadGatewayRouter({
      local,
      connections,
      feed,
      linkedWorkers,
      remote: (workerId) => {
        const existing = remotes.get(workerId);
        if (existing !== undefined) return existing;
        const created = makeRemoteThreadGateway({
          workerId,
          connections,
          local,
          centralEnvironmentId,
          fileSystem,
          crypto,
        });
        remotes.set(workerId, created);
        return created;
      },
    });
  }),
);
