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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
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
  released: number;
  /** The open link's close signal, while one is open. */
  link: Deferred.Deferred<void> | null;
}

export const helloFor = (environmentId: string, protocolVersion = BOARD_WORKER_PROTOCOL_VERSION) =>
  ({
    protocolVersion,
    environmentId: EnvironmentId.make(environmentId),
    t3oVersion: "0.0.45",
  }) satisfies BoardWorkerHello;

export const makeFakeWorkers = Effect.sync(() => {
  const workers = new Map<string, FakeWorker>();

  const add = (url: string, environmentId: string) =>
    Effect.gen(function* () {
      const clones = yield* SubscriptionRef.make<ProjectCloneListEvent>([]);
      const worker: FakeWorker = {
        url,
        mode: "ok",
        hello: helloFor(environmentId),
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
        released: 0,
        link: null,
      };
      workers.set(url, worker);
      return worker;
    });

  /** Drop a worker's open link, as a network blip would. */
  const drop = (worker: FakeWorker) =>
    Effect.suspend(() =>
      worker.link === null ? Effect.void : Deferred.succeed(worker.link, undefined),
    ).pipe(Effect.asVoid);

  const rpcFor = (worker: FakeWorker, closed: Deferred.Deferred<void>): WorkerRpc => {
    const gone = new WorkerRpcError({ message: "The connection dropped." });
    return {
      hello: Effect.suspend(() =>
        worker.hello === null
          ? Effect.fail(new WorkerRpcError({ message: "Unknown request tag boardWorker.hello" }))
          : Effect.succeed(worker.hello),
      ),
      projects: Effect.sync(() => ({ projects: worker.projects })),
      providers: Effect.sync(() => ({
        providers: worker.providers,
        projectsFolder: worker.projectsFolder,
      })),
      release: Effect.sync(() => {
        worker.released += 1;
      }),
      startProjectClone: (input) =>
        Effect.suspend(() => {
          worker.cloneStarts.push(input);
          return worker.startClone(input);
        }),
      retryProjectClone: (projectId) =>
        Effect.sync(() => {
          worker.cloneRetries.push(projectId);
          return true;
        }),
      // Ends with a failure when the link drops, as a real subscription does.
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
        return { rpc: rpcFor(worker, closed), closed: Deferred.await(closed) };
      }),
  });

  return { workers, add, drop, transport };
});

/** An in-memory secret store. */
export const makeMemorySecretStore = Effect.sync(() => {
  const secrets = new Map<string, Uint8Array>();
  const store = ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
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
  return { secrets, store };
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
