/**
 * The board's live connection to each worker, over its tunnel's loopback endpoint once the
 * tunnel is ready. `offline` and below-floor `incompatible` retry; `unauthorized` drops the
 * tunnel so the worker's next handshake hands over a fresh session (T3O-84).
 */
import {
  BOARD_WORKER_PROTOCOL_FLOOR,
  boardRepositoryGroupingKey,
  type BoardWorker,
  BoardWorkerConnectionState,
  type BoardWorkerHello,
  type BoardWorkerSnapshot,
  type BoardWorkerStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { BoardTunnelHost, type TunnelEntry } from "../tunnel/BoardTunnelHost.ts";
import {
  bootStatus,
  WorkerSnapshotStore,
  type WorkerSnapshotRecord,
} from "./WorkerSnapshotStore.ts";
import { WorkerTransport, type WorkerLink, type WorkerRpc } from "./WorkerTransport.ts";

/** A worker the board cannot use right now. */
export class WorkerUnavailable extends Schema.TaggedError<WorkerUnavailable>()(
  "WorkerUnavailable",
  {
    workerId: EnvironmentId,
    state: Schema.Union([BoardWorkerConnectionState, Schema.Literal("unknown")]),
    message: Schema.String,
  },
) {}

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
  /** Match the running connections to the registry: open each new worker's tunnel
      endpoint and follow it, and close removed ones. */
  readonly sync: (workers: ReadonlyArray<BoardWorker>) => Effect.Effect<void>;
  /** Dial a worker again now — a retry the human asked for. */
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
function workerRedialDelay(failures: number): Duration.Duration {
  return Duration.seconds(Math.min(30, 2 ** Math.min(failures, 5)));
}

/** How long before the board's session on a worker expires that it is renewed.
    A board server down for longer than the rest of the lifetime comes back to
    an expired session, which only a re-pair recovers. */
const SESSION_RENEW_AHEAD = Duration.days(7);

/** How long to hold a connection before renewing its session; null for a
    session that never expires. */
function sessionRenewalDelay(
  sessionExpiresAt: string | null,
  nowMillis: number,
): Duration.Duration | null {
  if (sessionExpiresAt === null) return null;
  const expiresAt = Date.parse(sessionExpiresAt);
  if (Number.isNaN(expiresAt)) return null;
  return Duration.millis(
    Math.max(0, expiresAt - Duration.toMillis(SESSION_RENEW_AHEAD) - nowMillis),
  );
}

/** Delays between attempts at a renewal that failed: a minute at first,
    then hourly, well inside `SESSION_RENEW_AHEAD`. */
function sessionRenewalRetryDelay(failures: number): Duration.Duration {
  return Duration.minutes(Math.min(60, 2 ** Math.min(failures, 6)));
}

/** A worker's providers and checkouts, read over its connection. */
export const readWorkerSnapshot = Effect.fn("WorkerConnections.readWorkerSnapshot")(function* (
  rpc: WorkerRpc,
) {
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
  | { readonly _tag: "renewed" }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "incompatible"; readonly hello: BoardWorkerHello | null }
  | { readonly _tag: "unauthorized" };

interface Entry extends WorkerRuntime {
  readonly worker: BoardWorker;
  /** The worker's tunnel endpoint on this board's loopback. */
  readonly url: string;
  readonly link: WorkerLink | null;
}

/** How long a booting board waits for a worker's tunnel before calling it offline. */
const BOOT_GRACE = Duration.seconds(10);
/** How long an unauthorized worker reads as reconnecting while its fresh session is
    awaited: past it the worker is down, or can't mint one, and reads offline. */
const HANDOFF_GRACE = Duration.minutes(1);

export const makeWorkerConnections = Effect.gen(function* () {
  const transport = yield* WorkerTransport;
  const secrets = yield* ServerSecretStore;
  const store = yield* WorkerSnapshotStore;
  const host = yield* BoardTunnelHost;

  const tunnelOf = (workerId: EnvironmentId) =>
    host.entries.pipe(
      Effect.map(
        (map): TunnelEntry => map.get(workerId) ?? { phase: "down", readyEpoch: 0, hello: null },
      ),
    );
  /** The worker's tunnel once it is ready with an epoch past `after`. */
  const awaitReady = (workerId: EnvironmentId, after: number) =>
    host.states.pipe(
      Stream.map((map) => map.get(workerId)),
      Stream.filter(
        (entry): entry is TunnelEntry =>
          entry !== undefined && entry.phase === "ready" && entry.readyEpoch > after,
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  /** Resolves when the tunnel leaves the given epoch: dropped, or replaced. */
  const awaitTunnelChange = (workerId: EnvironmentId, epoch: number) =>
    host.states.pipe(
      Stream.map((map) => map.get(workerId)),
      Stream.filter(
        (entry) => entry === undefined || entry.phase !== "ready" || entry.readyEpoch !== epoch,
      ),
      Stream.runHead,
      Effect.asVoid,
    );

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
  const markDialing = (workerId: EnvironmentId, renewed: boolean) =>
    update(workerId, (entry) =>
      entry.status.state === "offline" || entry.status.state === "incompatible"
        ? entry
        : renewed
          ? // A redial onto a renewed session: still online, just between links.
            { ...entry, link: null }
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

  /** Give back a session the board was issued but couldn't keep, over a
      link of its own: `release` revokes the session that calls it. */
  const releaseUnstored = (url: string, accessToken: string) =>
    Effect.scoped(
      transport.connect({ url, accessToken }).pipe(Effect.flatMap((link) => link.rpc.release)),
    ).pipe(Effect.ignore);

  /** Swap the board's session for its successor: store the new token, then
      give the old one back. False when the swap didn't happen, which leaves
      the old token in place. */
  const renewSession = Effect.fn("WorkerConnections.renewSession")(
    function* (worker: BoardWorker, url: string, rpc: WorkerRpc) {
      const renewal = yield* rpc.renew;
      const stored = yield* secrets
        .set(workerSecretName(worker.id), encodeWorkerToken(renewal.accessToken))
        .pipe(Effect.result);
      if (stored._tag === "Failure") {
        // Unstored, the successor would linger on the worker until it expired.
        yield* releaseUnstored(url, renewal.accessToken);
        return false;
      }
      // Unreturned, the old session only lingers until it expires.
      yield* rpc.release.pipe(Effect.ignore);
      return true;
    },
    Effect.catchCause(() => Effect.succeed(false)),
  );

  /** Hold an online link until it drops — or until its session is due for
      renewal, when the link is let go for one on the successor. A failed
      renewal is retried while the link is up: upstream doesn't close a
      socket whose session expires, so the next redial would be refused. */
  // Untraced: a span here would stay open for the connection's lifetime.
  const hold = Effect.fnUntraced(function* (
    worker: BoardWorker,
    url: string,
    link: WorkerLink,
    hello: BoardWorkerHello,
  ) {
    const now = yield* DateTime.now;
    const delay = sessionRenewalDelay(hello.sessionExpiresAt, now.epochMilliseconds);
    if (delay === null) {
      yield* link.closed;
      return { _tag: "dropped" } as const;
    }
    let wait = delay;
    for (let failures = 0; ; failures++) {
      const due = yield* link.closed.pipe(
        Effect.as(false),
        Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.succeed(true) }),
      );
      if (!due) return { _tag: "dropped" } as const;
      if (yield* renewSession(worker, url, link.rpc)) return { _tag: "renewed" } as const;
      wait = sessionRenewalRetryDelay(failures);
    }
  });

  /** One dial, held until the connection drops or its session is renewed. */
  const attempt = (
    worker: BoardWorker,
    url: string,
    renewed: boolean,
  ): Effect.Effect<AttemptOutcome> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* markDialing(worker.id, renewed);
        const token = yield* readToken(worker.id);
        if (Option.isNone(token)) return { _tag: "unauthorized" } as const;
        const connected = yield* transport
          .connect({ url, accessToken: token.value })
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
        return yield* hold(worker, url, link, hello);
      }),
    );

  /** A worker's loop: wait for its tunnel, dial, hold, and dial again. */
  // Untraced: a span here would stay open for the worker's lifetime.
  const runWorker = Effect.fnUntraced(function* (worker: BoardWorker, url: string) {
    let failures = 0;
    let renewed = false;
    // The ready epoch a dial last ran on; an unauthorized one waits for a newer handoff.
    let waitPast = 0;
    let booting = true;
    while (true) {
      const ready = yield* tunnelOf(worker.id);
      let tunnel = ready;
      if (ready.phase !== "ready" || ready.readyEpoch <= waitPast) {
        // An unauthorized worker reads as reconnecting until its next handoff, for a while.
        const grace = booting ? BOOT_GRACE : waitPast !== 0 ? HANDOFF_GRACE : null;
        if (grace === null) yield* setState(worker.id, "offline");
        tunnel =
          grace === null
            ? yield* awaitReady(worker.id, waitPast)
            : yield* awaitReady(worker.id, waitPast).pipe(
                Effect.timeoutOrElse({
                  duration: grace,
                  orElse: () =>
                    setState(worker.id, "offline").pipe(
                      Effect.andThen(awaitReady(worker.id, waitPast)),
                    ),
                }),
              );
      }
      booting = false;
      const outcome: AttemptOutcome = yield* attempt(worker, url, renewed);
      renewed = outcome._tag === "renewed";
      switch (outcome._tag) {
        case "renewed":
          // Straight back on, with the successor.
          failures = 0;
          continue;
        case "unauthorized":
          // The board's session went on the worker. Drop the tunnel so its next hello
          // hands over a fresh one; until then this reads as reconnecting.
          yield* setState(worker.id, "unauthorized");
          waitPast = tunnel.readyEpoch;
          yield* host.disconnect(worker.id);
          continue;
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
      // A tunnel that went is waited for above; one still up is retried with backoff.
      yield* Effect.raceFirst(
        Effect.sleep(workerRedialDelay(failures)),
        awaitTunnelChange(worker.id, tunnel.readyEpoch),
      );
      failures += 1;
    }
  });

  const start = (worker: BoardWorker, url: string) =>
    FiberMap.run(fibers, worker.id, runWorker(worker, url));

  const sync: WorkerConnectionsShape["sync"] = Effect.fn("WorkerConnections.sync")(
    function* (workers) {
      const before = yield* SubscriptionRef.get(entries);
      const wanted = new Map(workers.map((worker) => [worker.id, worker]));
      for (const [workerId] of before) {
        if (wanted.has(workerId)) continue;
        // Removed from the registry: stop dialing, and forget what it reported.
        yield* FiberMap.remove(fibers, workerId);
        yield* host.close(workerId);
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
        if (existing !== undefined) {
          if (existing.worker !== worker) {
            yield* SubscriptionRef.update(entries, (map) =>
              new Map(map).set(worker.id, { ...existing, worker }),
            );
          }
          continue;
        }
        const url = yield* host.ensure(worker.id);
        yield* SubscriptionRef.update(entries, (map) =>
          new Map(map).set(worker.id, {
            worker,
            url,
            link: null,
            status: bootStatus(persisted.get(worker.id)),
            snapshot: persisted.get(worker.id)?.snapshot ?? null,
          }),
        );
        yield* start(worker, url);
      }
    },
  );

  const restart: WorkerConnectionsShape["restart"] = (workerId) =>
    SubscriptionRef.get(entries).pipe(
      Effect.flatMap((map) => {
        const entry = map.get(workerId);
        return entry === undefined
          ? Effect.void
          : start(entry.worker, entry.url).pipe(Effect.asVoid);
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

  const record: WorkerConnectionsShape["record"] = Effect.fn("WorkerConnections.record")(
    function* (workerId, hello, snapshot) {
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
    },
  );

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
