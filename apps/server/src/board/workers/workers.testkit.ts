/**
 * T3o (T3O-62): test doubles for the worker suites — a scripted worker per
 * URL behind a fake `WorkerTransport`, and an in-memory `ServerSecretStore`.
 * Each fake worker's link can be dropped on demand, so connection tests drive
 * status changes without any socket.
 */
import {
  BOARD_WORKER_PROTOCOL_VERSION,
  EnvironmentId,
  type BoardWorkerHello,
  type BoardWorkerProject,
  type BoardWorkerProvider,
  type ProjectCloneListEvent,
  type ProjectCloneStartInput,
  type ProjectCloneStartResult,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { SecretStorePersistError, ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import type { WorkerGatewayRpc } from "./gatewayWire.ts";
import { WorkerSnapshotStore, makeMemoryWorkerSnapshotStore } from "./WorkerSnapshotStore.ts";
import {
  WorkerConnectError,
  WorkerRpcError,
  WorkerTransport,
  type WorkerRpc,
} from "./WorkerTransport.ts";

export interface FakeWorker {
  readonly url: string;
  /** How the next dial goes. */
  mode: "ok" | "unreachable" | "unauthorized";
  /** Null: a server with no `boardWorker.hello` at all (upstream). */
  hello: BoardWorkerHello | null;
  /** The handshake fails on the wire, as a dropped worker's would. */
  helloFails: boolean;
  projects: ReadonlyArray<BoardWorkerProject>;
  providers: ReadonlyArray<BoardWorkerProvider>;
  projectsFolder: string | null;
  /** What `projectClone.start` does; defaults to accepting. */
  startClone: (
    input: ProjectCloneStartInput,
  ) => Effect.Effect<ProjectCloneStartResult, WorkerRpcError>;
  readonly clones: SubscriptionRef.SubscriptionRef<ProjectCloneListEvent>;
  readonly dialedTokens: Array<string>;
  readonly cloneStarts: Array<ProjectCloneStartInput>;
  readonly cloneRetries: Array<ProjectId>;
  /** Whether `projectClone.retry` finds the clone; false once it forgot it. */
  retryApplied: boolean;
  released: number;
  /** Runs as each release arrives, before it is counted. */
  onRelease: Effect.Effect<void>;
  /** The session each release gave back. */
  readonly releasedTokens: Array<string>;
  /** The session each renew was asked by, in order; its successor is
      `<old>-renewed`. */
  readonly renewedTokens: Array<string>;
  /** How many renewals fail on the wire before one succeeds. */
  renewFailures: number;
  /** When each session expires (epoch millis), by token; a token missing
      here reports `hello.sessionExpiresAt` as scripted. Renewing issues a
      successor that lives 30 days from then. */
  readonly sessionExpiry: Map<string, number>;
  /** The open link's close signal, while one is open. */
  link: Deferred.Deferred<void> | null;
  /** What the worker's thread gateway answers (T3O-63): an in-process
      worker's own host, or a worker that has none. */
  gateway: WorkerGatewayRpc;
  /** How the worker answers `boardWorker.git.*`; by default it has no such
      calls, as a T3o before T3O-64 does not. */
  git: WorkerRpc["git"];
}

/** A worker without the T3O-63 gateway: every call is unsupported. */
export const unsupportedGateway: WorkerGatewayRpc = (() => {
  const unsupported = new WorkerRpcError({
    message: "The worker doesn't support this board call.",
    unsupported: true,
  });
  const fail = () => Effect.fail(unsupported);
  const failStream = () => Stream.fail(unsupported);
  return {
    spawn: fail,
    send: fail,
    interrupt: fail,
    stopSession: fail,
    settle: fail,
    delete: fail,
    armLimitRecovery: fail,
    threadState: fail,
    threadRecords: fail,
    threadsInWorktree: fail,
    listLiveThreadIds: Effect.fail(unsupported),
    latestAssistantMessage: fail,
    lastSignalAt: fail,
    pendingTurnStartAt: fail,
    projects: Effect.fail(unsupported),
    project: fail,
    subscribeSignals: failStream,
    todoLogHead: Effect.fail(unsupported),
    readTodoLog: failStream,
    subscribeTodoLog: Stream.fail(unsupported),
    subscribeMcpRelay: failStream,
    mcpRelayRespond: fail,
    stageAttachments: fail,
  };
})();

/** Upstream's fixed session lifetime. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export const helloFor = (environmentId: string, protocolVersion = BOARD_WORKER_PROTOCOL_VERSION) =>
  ({
    protocolVersion,
    environmentId: EnvironmentId.make(environmentId),
    t3oVersion: "0.0.45",
    sessionExpiresAt: null,
  }) satisfies BoardWorkerHello;

/** A gateway bound to one link: its streams end with `gone` when the link
    drops, and its calls fail once it has. */
const linkedGateway = (
  gateway: WorkerGatewayRpc,
  closed: Deferred.Deferred<void>,
  gone: WorkerRpcError,
): WorkerGatewayRpc => {
  const guard = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | WorkerRpcError> =>
    Deferred.isDone(closed).pipe(
      Effect.flatMap((done): Effect.Effect<A, E | WorkerRpcError> =>
        done ? Effect.fail(gone) : effect,
      ),
    );
  const live = <A, E>(stream: Stream.Stream<A, E>): Stream.Stream<A, E | WorkerRpcError> =>
    stream.pipe(Stream.interruptWhen(Deferred.await(closed)), Stream.concat(Stream.fail(gone)));
  return {
    spawn: (input) => guard(gateway.spawn(input)),
    send: (input) => guard(gateway.send(input)),
    interrupt: (input) => guard(gateway.interrupt(input)),
    stopSession: (input) => guard(gateway.stopSession(input)),
    settle: (input) => guard(gateway.settle(input)),
    delete: (input) => guard(gateway.delete(input)),
    armLimitRecovery: (input) => guard(gateway.armLimitRecovery(input)),
    threadState: (threadId) => guard(gateway.threadState(threadId)),
    threadRecords: (threadIds) => guard(gateway.threadRecords(threadIds)),
    threadsInWorktree: (path) => guard(gateway.threadsInWorktree(path)),
    listLiveThreadIds: guard(gateway.listLiveThreadIds),
    latestAssistantMessage: (threadId) => guard(gateway.latestAssistantMessage(threadId)),
    lastSignalAt: (threadId) => guard(gateway.lastSignalAt(threadId)),
    pendingTurnStartAt: (threadId) => guard(gateway.pendingTurnStartAt(threadId)),
    projects: guard(gateway.projects),
    project: (projectId) => guard(gateway.project(projectId)),
    subscribeSignals: (after) => live(gateway.subscribeSignals(after)),
    todoLogHead: guard(gateway.todoLogHead),
    readTodoLog: (after, upTo) => gateway.readTodoLog(after, upTo),
    subscribeTodoLog: live(gateway.subscribeTodoLog),
    subscribeMcpRelay: (central) => live(gateway.subscribeMcpRelay(central)),
    mcpRelayRespond: (response) => guard(gateway.mcpRelayRespond(response)),
    stageAttachments: (input) => guard(gateway.stageAttachments(input)),
  };
};

export const makeFakeWorkers = Effect.sync(() => {
  const workers = new Map<string, FakeWorker>();

  const add = (url: string, environmentId: string) =>
    Effect.gen(function* () {
      const clones = yield* SubscriptionRef.make<ProjectCloneListEvent>([]);
      const worker: FakeWorker = {
        url,
        mode: "ok",
        hello: helloFor(environmentId),
        helloFails: false,
        projects: [],
        providers: [],
        projectsFolder: "~/projects",
        startClone: (input) =>
          Effect.succeed({
            projectId: input.projectId,
            cwd: input.destinationPath,
            remoteUrl: input.remoteUrl ?? "",
            repository: null,
          }),
        clones,
        dialedTokens: [],
        cloneStarts: [],
        cloneRetries: [],
        retryApplied: true,
        released: 0,
        onRelease: Effect.void,
        releasedTokens: [],
        renewedTokens: [],
        renewFailures: 0,
        sessionExpiry: new Map(),
        link: null,
        gateway: unsupportedGateway,
        git: () =>
          Effect.fail(
            new WorkerRpcError({
              message: "The worker doesn't support this board call.",
              unsupported: true,
            }),
          ),
      };
      workers.set(url, worker);
      return worker;
    });

  /** Drop a worker's open link, as a network blip would. */
  const drop = (worker: FakeWorker) =>
    Effect.suspend(() =>
      worker.link === null ? Effect.void : Deferred.succeed(worker.link, undefined),
    ).pipe(Effect.asVoid);

  const rpcFor = (
    worker: FakeWorker,
    closed: Deferred.Deferred<void>,
    accessToken: string,
  ): WorkerRpc => {
    const gone = new WorkerRpcError({ message: "The connection dropped." });
    return {
      hello: Effect.suspend(() =>
        worker.helloFails
          ? Effect.fail(gone)
          : worker.hello === null
            ? Effect.fail(
                new WorkerRpcError({
                  message: "Unknown request tag boardWorker.hello",
                  unsupported: true,
                }),
              )
            : Effect.succeed(
                worker.sessionExpiry.has(accessToken)
                  ? {
                      ...worker.hello,
                      sessionExpiresAt: DateTime.formatIso(
                        DateTime.makeUnsafe(worker.sessionExpiry.get(accessToken)!),
                      ),
                    }
                  : worker.hello,
              ),
      ),
      projects: Effect.sync(() => ({ projects: worker.projects })),
      providers: Effect.sync(() => ({
        providers: worker.providers,
        projectsFolder: worker.projectsFolder,
      })),
      release: Effect.suspend(() => worker.onRelease).pipe(
        Effect.andThen(
          Effect.sync(() => {
            worker.released += 1;
            worker.releasedTokens.push(accessToken);
          }),
        ),
      ),
      renew: Effect.suspend(() => {
        if (worker.renewFailures === 0) return Effect.void;
        worker.renewFailures -= 1;
        return Effect.fail(gone);
      }).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.map((now) => {
          worker.renewedTokens.push(accessToken);
          const successor = `${accessToken}-renewed`;
          worker.sessionExpiry.set(successor, now + SESSION_LIFETIME_MS);
          return { accessToken: successor };
        }),
      ),
      startProjectClone: (input) =>
        Effect.suspend(() => {
          worker.cloneStarts.push(input);
          return worker.startClone(input);
        }),
      retryProjectClone: (projectId) =>
        Effect.sync(() => {
          worker.cloneRetries.push(projectId);
          return worker.retryApplied;
        }),
      git: (method, payload) => Effect.suspend(() => worker.git(method, payload)),
      // Ends with a failure when the link drops, as a real subscription does.
      // The gateway lives as long as the link: a dropped link ends its
      // streams with a failure and fails its calls, as a real socket does.
      gateway: linkedGateway(worker.gateway, closed, gone),
      projectClones: SubscriptionRef.changes(worker.clones).pipe(
        Stream.interruptWhen(Deferred.await(closed)),
        Stream.concat(Stream.fail(gone)),
      ),
    };
  };

  const transport = WorkerTransport.of({
    connect: ({ url, accessToken }) =>
      Effect.gen(function* () {
        const worker = workers.get(url);
        if (worker === undefined || worker.mode === "unreachable") {
          return yield* new WorkerConnectError({ reason: "unreachable", message: "unreachable" });
        }
        if (worker.mode === "unauthorized") {
          return yield* new WorkerConnectError({ reason: "unauthorized", message: "401" });
        }
        worker.dialedTokens.push(accessToken);
        const closed = yield* Deferred.make<void>();
        worker.link = closed;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (worker.link === closed) worker.link = null;
          }),
        );
        return { rpc: rpcFor(worker, closed, accessToken), closed: Deferred.await(closed) };
      }),
  });

  return { workers, add, drop, transport };
});

/** An in-memory secret store. */
export const makeMemorySecretStore = Effect.sync(() => {
  const secrets = new Map<string, Uint8Array>();
  /** While true, every `set` fails, as a full or read-only disk would. */
  const control = { failSets: false };
  const store = ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) =>
      control.failSets
        ? Effect.fail(
            new SecretStorePersistError({ resource: name, cause: new Error("disk full") }),
          )
        : Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = secrets.get(name);
        if (existing !== undefined) return existing;
        const created = new Uint8Array(bytes);
        secrets.set(name, created);
        return created;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
  return { secrets, store, control };
});

/** Fake transport, memory secrets and memory snapshots, as one layer. */
export const makeFakeWorkerLayer = Effect.gen(function* () {
  const fake = yield* makeFakeWorkers;
  const secrets = yield* makeMemorySecretStore;
  const snapshots = yield* makeMemoryWorkerSnapshotStore;
  const layer = Layer.mergeAll(
    Layer.succeed(WorkerTransport, fake.transport),
    Layer.succeed(ServerSecretStore, secrets.store),
    Layer.succeed(WorkerSnapshotStore, snapshots),
  );
  return { fake, secrets, snapshots, layer };
});
