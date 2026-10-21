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
  /** When each session expires (epoch millis), by token; a token missing
      here reports `hello.sessionExpiresAt` as scripted. Renewing issues a
      successor that lives 30 days from then. */
  readonly sessionExpiry: Map<string, number>;
  /** The open link's close signal, while one is open. */
  link: Deferred.Deferred<void> | null;
}

/** Upstream's fixed session lifetime. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export const helloFor = (environmentId: string, protocolVersion = BOARD_WORKER_PROTOCOL_VERSION) =>
  ({
    protocolVersion,
    environmentId: EnvironmentId.make(environmentId),
    t3oVersion: "0.0.45",
    sessionExpiresAt: null,
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
        sessionExpiry: new Map(),
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
      renew: Clock.currentTimeMillis.pipe(
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
        return { rpc: rpcFor(worker, closed, accessToken), closed: Deferred.await(closed) };
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
