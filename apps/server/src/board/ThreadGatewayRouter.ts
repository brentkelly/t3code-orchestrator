/**
 * The board's thread gateway on a central server (T3O-63, D9/D19): one
 * `ThreadGateway` over this server's own threads and every worker's.
 *
 * The supervisor keeps calling one gateway. Each call goes where its thread
 * lives: a spawn to the worker it names (absent means here), every other
 * thread call to the worker its card's thread link names, and anything
 * without a thread — projects, the todo log — to this server. Until placement
 * exists (T3O-65) the supervisor names no worker, so everything routes here
 * and a local-only board behaves exactly as before.
 *
 * `observe` merges this server's signals with every worker's
 * (`WorkerSignalFeed`). Each worker's todo signals are applied by the feed,
 * so the todo log here is this server's alone.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  type BoardWorkerId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { makeBoardQueries } from "./projection.ts";
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

export interface ThreadGatewayRouterDeps {
  readonly local: LocalThreadGatewayShape;
  readonly connections: WorkerConnectionsShape;
  readonly feed: WorkerSignalFeedShape;
  /** The worker a linked thread lives on, or null for one no card links. */
  readonly linkedWorker: (threadId: ThreadId) => Effect.Effect<BoardWorkerId | null, Error>;
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

  /** Where a thread lives. A thread no card links is this server's. */
  const workerOf = (threadId: ThreadId): Effect.Effect<BoardWorkerId, ThreadReadError> => {
    const spawned = spawnedOn.get(threadId);
    if (spawned !== undefined) return Effect.succeed(spawned);
    return deps.linkedWorker(threadId).pipe(
      Effect.map((workerId) => workerId ?? BOARD_LOCAL_WORKER_ID),
      Effect.mapError(
        (cause) =>
          new ThreadReadError({
            operation: "threadWorker",
            detail: `Couldn't read which worker thread ${threadId} lives on.`,
            cause,
          }),
      ),
    );
  };

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

    threadRecords: (threadIds) =>
      Effect.gen(function* () {
        const byWorker = new Map<BoardWorkerId, Array<ThreadId>>();
        for (const threadId of threadIds) {
          const workerId = yield* workerOf(threadId);
          byWorker.set(workerId, [...(byWorker.get(workerId) ?? []), threadId]);
        }
        const found = new Map<ThreadId, BoardThreadRecord>();
        for (const [workerId, ids] of byWorker) {
          for (const [threadId, record] of yield* gatewayFor(workerId).threadRecords(ids)) {
            found.set(threadId, record);
          }
        }
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

/** The router as the board's `ThreadGateway`, over this server's own gateway,
    its worker connections and their signal feed. */
export const ThreadGatewayRouterLive = Layer.effect(
  ThreadGateway,
  Effect.gen(function* () {
    const local = yield* LocalThreadGateway;
    const connections = yield* WorkerConnections;
    const feed = yield* WorkerSignalFeed;
    const queries = makeBoardQueries(yield* SqlClient.SqlClient);
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
      linkedWorker: queries.boardThreadWorker,
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
