/**
 * T3o (T3O-62, D19/D22): the central server's live connection to each worker.
 *
 * One fiber per registered worker dials it with the board's own bearer token,
 * runs the `boardWorker.hello` handshake, reads the worker's providers and
 * checkouts, and then holds the connection until it drops — and dials again,
 * with backoff. Every change is published, so the board subscription can send
 * clients the new `workers` state.
 *
 * Status rules:
 * - a dial or handshake that fails on the network: `offline`, retried;
 * - a handshake below `BOARD_WORKER_PROTOCOL_FLOOR`, or a server with no
 *   `boardWorker.hello` at all: `incompatible`, retried (it may be upgraded);
 * - a 401/403, a missing token, or a different server answering at the URL:
 *   `unauthorized`, NOT retried — only a re-pair (`restart`) recovers it.
 *
 * Later plans build on `get` (a typed client, or `WorkerUnavailable`) and on
 * `changes`.
 */
import {
  BOARD_WORKER_PROTOCOL_FLOOR,
  boardRepositoryGroupingKey,
  type BoardWorker,
  type BoardWorkerConnectionState,
  type BoardWorkerHello,
  type BoardWorkerSnapshot,
  type BoardWorkerStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import {
  bootStatus,
  WorkerSnapshotStore,
  type WorkerSnapshotRecord,
} from "./WorkerSnapshotStore.ts";
import { WorkerTransport, type WorkerLink, type WorkerRpc } from "./WorkerTransport.ts";

/** A worker the board cannot use right now. */
export class WorkerUnavailable extends Data.TaggedError("WorkerUnavailable")<{
  readonly workerId: EnvironmentId;
  readonly state: BoardWorkerConnectionState | "unknown";
  readonly message: string;
}> {}

/** What the central server knows about one worker at runtime. */
export interface WorkerRuntime {
  readonly status: BoardWorkerStatus;
  readonly snapshot: BoardWorkerSnapshot | null;
}

export interface WorkerConnectionsShape {
  /** The worker's typed client while it is online. */
  readonly get: (workerId: EnvironmentId) => Effect.Effect<WorkerRpc, WorkerUnavailable>;
  /** Every registered worker's status and last-known snapshot. */
  readonly current: Effect.Effect<ReadonlyMap<EnvironmentId, WorkerRuntime>>;
  /** Every worker's runtime now, then again after each change. Each access
      subscribes, atomically with reading the current value. */
  readonly states: Stream.Stream<ReadonlyMap<EnvironmentId, WorkerRuntime>>;
  /** Ticks on every status or snapshot change. Each access subscribes. */
  readonly changes: Stream.Stream<void>;
  /** Match the running connections to the registry: dial new workers, drop
      removed ones, re-dial one whose URL changed. */
  readonly sync: (workers: ReadonlyArray<BoardWorker>) => Effect.Effect<void>;
  /** Dial a worker again now — after a re-pair, or a retry the human asked for. */
  readonly restart: (workerId: EnvironmentId) => Effect.Effect<void>;
  /** Re-read the worker's providers and checkouts over its live connection. */
  readonly refresh: (workerId: EnvironmentId) => Effect.Effect<void>;
  /** Record what a worker reported outside the loop (the add flow's probe). */
  readonly record: (
    workerId: EnvironmentId,
    hello: BoardWorkerHello,
    snapshot: BoardWorkerSnapshot,
  ) => Effect.Effect<void>;
}

export class WorkerConnections extends Context.Service<WorkerConnections, WorkerConnectionsShape>()(
  "t3/board/workers/WorkerConnections",
) {}

/** The secret holding the board's bearer token for a worker. */
export const workerSecretName = (workerId: EnvironmentId): string => `board-worker-${workerId}`;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
export const encodeWorkerToken = (token: string): Uint8Array => textEncoder.encode(token);
export const decodeWorkerToken = (bytes: Uint8Array): string => textDecoder.decode(bytes);

/** Redial delays: quick at first, then every 30 seconds. */
export function workerRedialDelay(failures: number): Duration.Duration {
  return Duration.seconds(Math.min(30, 2 ** Math.min(failures, 5)));
}

/** A worker's providers and checkouts, read over its connection. */
export const readWorkerSnapshot = (rpc: WorkerRpc) =>
  Effect.gen(function* () {
    const [providers, projects] = yield* Effect.all([rpc.providers, rpc.projects], {
      concurrency: 2,
    });
    const reportedAt = DateTime.formatIso(yield* DateTime.now);
    return {
      providers: providers.providers,
      projectsFolder: providers.projectsFolder,
      checkouts: projects.projects.map((project) => ({
        projectId: project.projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        repositoryKey: boardRepositoryGroupingKey(project.repositoryIdentity),
      })),
      reportedAt,
    } satisfies BoardWorkerSnapshot;
  });

type AttemptOutcome =
  | { readonly _tag: "dropped" }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "incompatible"; readonly hello: BoardWorkerHello | null }
  | { readonly _tag: "unauthorized" };

interface Entry extends WorkerRuntime {
  readonly worker: BoardWorker;
  readonly link: WorkerLink | null;
}

export const makeWorkerConnections = Effect.gen(function* () {
  const transport = yield* WorkerTransport;
  const secrets = yield* ServerSecretStore;
  const store = yield* WorkerSnapshotStore;

  const persisted = new Map<EnvironmentId, WorkerSnapshotRecord>(
    (yield* store.list).map((record) => [record.workerId, record]),
  );
  const entries = yield* SubscriptionRef.make(new Map<EnvironmentId, Entry>());
  const fibers = yield* FiberMap.make<EnvironmentId>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  /** Update a registered worker's entry. A worker removed meanwhile stays
      gone, and an entry `f` hands back unchanged is not published. */
  const update = (workerId: EnvironmentId, f: (entry: Entry) => Entry) =>
    SubscriptionRef.updateSome(entries, (map) => {
      const entry = map.get(workerId);
      if (entry === undefined) return Option.none();
      const next = f(entry);
      return next === entry ? Option.none() : Option.some(new Map(map).set(workerId, next));
    });

  const setState = (
    workerId: EnvironmentId,
    state: BoardWorkerConnectionState,
    patch: Partial<BoardWorkerStatus> = {},
  ) =>
    update(workerId, (entry) => {
      const link = state === "online" ? entry.link : null;
      const status = { ...entry.status, ...patch, state };
      const unchanged =
        link === entry.link &&
        (Object.keys(status) as Array<keyof BoardWorkerStatus>).every(
          (key) => status[key] === entry.status[key],
        );
      return unchanged ? entry : { ...entry, link, status };
    });

  /** A redial of a worker already known to be offline or incompatible keeps
      that status until it answers: blue `connecting` is for a first dial, or
      one after a re-pair, not every retry in the background. */
  const markDialing = (workerId: EnvironmentId) =>
    update(workerId, (entry) =>
      entry.status.state === "offline" || entry.status.state === "incompatible"
        ? entry
        : { ...entry, link: null, status: { ...entry.status, state: "connecting" } },
    );

  const persist = (workerId: EnvironmentId) =>
    SubscriptionRef.get(entries).pipe(
      Effect.flatMap((map) => {
        const entry = map.get(workerId);
        return entry === undefined
          ? Effect.void
          : store.write({
              workerId,
              t3oVersion: entry.status.t3oVersion,
              protocolVersion: entry.status.protocolVersion,
              lastSeenAt: entry.status.lastSeenAt,
              snapshot: entry.snapshot,
            });
      }),
    );

  const readToken = (workerId: EnvironmentId) =>
    secrets.get(workerSecretName(workerId)).pipe(
      Effect.map(Option.map(decodeWorkerToken)),
      Effect.catchCause(() => Effect.succeed(Option.none<string>())),
    );

  /** One dial, held until the connection drops. */
  const attempt = (worker: BoardWorker): Effect.Effect<AttemptOutcome> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* markDialing(worker.id);
        const token = yield* readToken(worker.id);
        if (Option.isNone(token)) return { _tag: "unauthorized" } as const;
        const connected = yield* transport
          .connect({ url: worker.url, accessToken: token.value })
          .pipe(Effect.result);
        if (connected._tag === "Failure") {
          return connected.failure.reason === "unauthorized"
            ? ({ _tag: "unauthorized" } as const)
            : ({ _tag: "unreachable" } as const);
        }
        const link = connected.success;
        // A server without the handshake does not speak the board-worker
        // protocol at all; one that fails to answer it is just unreachable.
        const helloResult = yield* link.rpc.hello.pipe(Effect.result);
        if (helloResult._tag === "Failure") {
          return helloResult.failure.unsupported === true
            ? ({ _tag: "incompatible", hello: null } as const)
            : ({ _tag: "unreachable" } as const);
        }
        const hello = helloResult.success;
        // Another server answering at this address: the board's token is not
        // for it, whatever it says.
        if (hello.environmentId !== worker.id) return { _tag: "unauthorized" } as const;
        if (hello.protocolVersion < BOARD_WORKER_PROTOCOL_FLOOR) {
          return { _tag: "incompatible", hello } as const;
        }
        const snapshot = yield* readWorkerSnapshot(link.rpc).pipe(Effect.option);
        if (Option.isNone(snapshot)) return { _tag: "unreachable" } as const;
        const seenAt = yield* nowIso;
        yield* update(worker.id, (entry) => ({
          ...entry,
          link,
          snapshot: snapshot.value,
          status: {
            state: "online",
            lastSeenAt: seenAt,
            t3oVersion: hello.t3oVersion,
            protocolVersion: hello.protocolVersion,
          },
        }));
        yield* persist(worker.id);
        yield* link.closed;
        return { _tag: "dropped" } as const;
      }),
    );

  /** A worker's loop: dial, hold, and dial again until it is unauthorized. */
  const runWorker = (worker: BoardWorker) =>
    Effect.gen(function* () {
      let failures = 0;
      while (true) {
        const outcome = yield* attempt(worker);
        switch (outcome._tag) {
          case "unauthorized":
            yield* setState(worker.id, "unauthorized");
            return;
          case "incompatible":
            yield* setState(
              worker.id,
              "incompatible",
              outcome.hello === null
                ? {}
                : {
                    t3oVersion: outcome.hello.t3oVersion,
                    protocolVersion: outcome.hello.protocolVersion,
                  },
            );
            yield* persist(worker.id);
            break;
          case "dropped":
            // It was online until this moment, which is when it was last seen.
            failures = 0;
            yield* setState(worker.id, "offline", { lastSeenAt: yield* nowIso });
            yield* persist(worker.id);
            break;
          case "unreachable":
            yield* setState(worker.id, "offline");
            break;
        }
        yield* Effect.sleep(workerRedialDelay(failures));
        failures += 1;
      }
    });

  const start = (worker: BoardWorker) => FiberMap.run(fibers, worker.id, runWorker(worker));

  const sync: WorkerConnectionsShape["sync"] = (workers) =>
    Effect.gen(function* () {
      const before = yield* SubscriptionRef.get(entries);
      const wanted = new Map(workers.map((worker) => [worker.id, worker]));
      for (const [workerId] of before) {
        if (wanted.has(workerId)) continue;
        // Removed from the registry: stop dialing, and forget what it reported.
        yield* FiberMap.remove(fibers, workerId);
        persisted.delete(workerId);
        yield* store.remove(workerId);
        yield* SubscriptionRef.update(entries, (map) => {
          const next = new Map(map);
          next.delete(workerId);
          return next;
        });
      }
      for (const worker of workers) {
        const existing = before.get(worker.id);
        if (existing !== undefined && existing.worker.url === worker.url) {
          if (existing.worker.label !== worker.label) {
            yield* SubscriptionRef.update(entries, (map) =>
              new Map(map).set(worker.id, { ...existing, worker }),
            );
          }
          continue;
        }
        yield* SubscriptionRef.update(entries, (map) =>
          new Map(map).set(worker.id, {
            worker,
            link: null,
            status: existing?.status ?? bootStatus(persisted.get(worker.id)),
            snapshot: existing?.snapshot ?? persisted.get(worker.id)?.snapshot ?? null,
          }),
        );
        yield* start(worker);
      }
    });

  const restart: WorkerConnectionsShape["restart"] = (workerId) =>
    SubscriptionRef.get(entries).pipe(
      Effect.flatMap((map) => {
        const entry = map.get(workerId);
        return entry === undefined ? Effect.void : start(entry.worker).pipe(Effect.asVoid);
      }),
    );

  const get: WorkerConnectionsShape["get"] = (workerId) =>
    SubscriptionRef.get(entries).pipe(
      Effect.flatMap((map) => {
        const entry = map.get(workerId);
        if (entry?.link != null && entry.status.state === "online") {
          return Effect.succeed(entry.link.rpc);
        }
        return Effect.fail(
          new WorkerUnavailable({
            workerId,
            state: entry?.status.state ?? "unknown",
            message:
              entry === undefined
                ? `Worker '${workerId}' is not registered.`
                : `${entry.worker.label} is ${entry.status.state}.`,
          }),
        );
      }),
    );

  const refresh: WorkerConnectionsShape["refresh"] = (workerId) =>
    get(workerId).pipe(
      Effect.flatMap(readWorkerSnapshot),
      Effect.flatMap((snapshot) =>
        update(workerId, (entry) => ({ ...entry, snapshot })).pipe(
          Effect.andThen(persist(workerId)),
        ),
      ),
      Effect.ignore,
    );

  const record: WorkerConnectionsShape["record"] = (workerId, hello, snapshot) =>
    Effect.gen(function* () {
      const seenAt = yield* nowIso;
      const next: WorkerSnapshotRecord = {
        workerId,
        t3oVersion: hello.t3oVersion,
        protocolVersion: hello.protocolVersion,
        lastSeenAt: seenAt,
        snapshot,
      };
      persisted.set(workerId, next);
      yield* store.write(next);
      yield* update(workerId, (entry) => ({
        ...entry,
        snapshot,
        status: {
          ...entry.status,
          lastSeenAt: seenAt,
          t3oVersion: hello.t3oVersion,
          protocolVersion: hello.protocolVersion,
        },
      }));
    });

  const runtimeOf = (map: ReadonlyMap<EnvironmentId, Entry>) =>
    new Map(
      [...map].map(([workerId, entry]): [EnvironmentId, WorkerRuntime] => [
        workerId,
        { status: entry.status, snapshot: entry.snapshot },
      ]),
    );
  const states = SubscriptionRef.changes(entries).pipe(Stream.map(runtimeOf));

  return {
    get,
    current: SubscriptionRef.get(entries).pipe(Effect.map(runtimeOf)),
    states,
    // The first item is the value now, which is not a change.
    changes: states.pipe(Stream.drop(1), Stream.as(undefined)),
    sync,
    restart,
    refresh,
    record,
  } satisfies WorkerConnectionsShape;
});

export const WorkerConnectionsLive = Layer.effect(WorkerConnections, makeWorkerConnections);
