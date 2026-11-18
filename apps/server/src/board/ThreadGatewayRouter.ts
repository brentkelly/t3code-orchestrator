/**
 * The board's thread gateway on a central server: each call goes where its thread lives (a spawn
 * to the worker it names, other thread calls to the worker the card's link names), and calls
 * without a thread to this server. `observe` merges every worker's signals; the todo log is local.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  EnvironmentId,
  ThreadId,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
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
  isOpenThreadRecord,
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
import { WorkerConnections } from "./workers/WorkerConnections.ts";
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
    answerPendingInput: routed("answerPendingInput", (gateway) => gateway.answerPendingInput),
    linkPullRequest: routed("linkPullRequest", (gateway) => gateway.linkPullRequest),
    unlinkPullRequest: routed("unlinkPullRequest", (gateway) => gateway.unlinkPullRequest),
    threadState: routedRead((gateway) => gateway.threadState),
    latestAssistantMessage: routedRead((gateway) => gateway.latestAssistantMessage),
    lastSignalAt: routedRead((gateway) => gateway.lastSignalAt),
    pendingTurnStartAt: routedRead((gateway) => gateway.pendingTurnStartAt),
    subagentAwaitingApproval: routedRead((gateway) => gateway.subagentAwaitingApproval),

    // Best-effort per worker: removed and unreachable workers' threads are left out, so one offline
    // worker never stalls the release sweep. Fails only when no worker named answered, so a single
    // thread's lookup never reads an unreachable thread as one that never existed.
    threadRecords: Effect.fn("ThreadGatewayRouter.threadRecords")(function* (threadIds) {
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
    // Never fails on a worker: an unreachable or removed worker's threads come back unanswered,
    // so the sweep keeps them for a later pass. A worker is asked over the existing
    // `threadRecords` call and filtered here, which needs no protocol bump.
    openThreadIds: Effect.fn("ThreadGatewayRouter.openThreadIds")(function* (threadIds) {
      const byWorker = new Map<BoardWorkerId, Array<ThreadId>>();
      const unanswered = new Set<ThreadId>();
      for (const [threadId, { workerId, removed }] of yield* workersOf(threadIds)) {
        if (removed) {
          unanswered.add(threadId);
          continue;
        }
        const ids = byWorker.get(workerId);
        if (ids === undefined) byWorker.set(workerId, [threadId]);
        else ids.push(threadId);
      }
      const open = new Set<ThreadId>();
      const deleted = new Set<ThreadId>();
      for (const [workerId, ids] of byWorker) {
        if (workerId === BOARD_LOCAL_WORKER_ID) {
          const answer = yield* local.openThreadIds(ids);
          for (const threadId of answer.open) open.add(threadId);
          for (const threadId of answer.deleted) deleted.add(threadId);
          continue;
        }
        const remote = yield* Effect.result(deps.remote(workerId).threadRecords(ids));
        if (remote._tag === "Failure") {
          for (const threadId of ids) unanswered.add(threadId);
          continue;
        }
        for (const record of remote.success.values()) {
          if (isOpenThreadRecord(record)) open.add(record.threadId);
          else if (record.deleted) deleted.add(record.threadId);
        }
      }
      return { open, unanswered, deleted };
    }),
    // Worktree retirement on a worker is not routed: worktrees are this server's.
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
    answers where it was. T3o: a t3o.json schedule's run on a worker has no card, so its
    recorded run answers too (T3O-118); a run on this server stays this server's. */
export const makeLinkedThreadWorkers = (
  sql: SqlClient.SqlClient,
  serverEnvironmentId: EnvironmentId,
) => {
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
      UNION ALL
      SELECT
        runs.thread_id AS "threadId",
        runs.environment_id AS "workerId",
        (workers.worker_id IS NULL) AS "removed"
      FROM boards.schedule_run_threads AS runs
      LEFT JOIN board_workers AS workers ON workers.worker_id = runs.environment_id
      WHERE runs.thread_id IN (SELECT value FROM json_each(${threadIdsJson}))
        AND runs.environment_id <> ${serverEnvironmentId}
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
    const centralEnvironmentId = yield* Effect.flatMap(
      ServerEnvironment,
      (environment) => environment.getEnvironmentId,
    );
    const linkedWorkers = makeLinkedThreadWorkers(yield* SqlClient.SqlClient, centralEnvironmentId);
    const fileSystem = yield* FileSystem.FileSystem;
    const digest = yield* Digest.Digest;
    const remotes = new Map<EnvironmentId, RemoteThreadGatewayShape>();
    return makeThreadGatewayRouter({
      local,
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
          digest,
        });
        remotes.set(workerId, created);
        return created;
      },
    });
  }),
);
