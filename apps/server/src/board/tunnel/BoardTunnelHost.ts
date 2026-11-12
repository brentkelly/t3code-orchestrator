// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off tryCatchInEffectGen:off globalDateInEffect:off - owns the plain-Node tunnel and a file watch; Effect is the service wrapper.
/**
 * The board's tunnel host as a service (T3O-84). Owns `TunnelBoard`, registers the
 * HTTP seam handler, and decides each worker's hello: a session the worker just handed
 * over (or the one the board already holds) is proved by probing through the tunnel
 * before the worker is `ready`. `WorkerConnections` dials a worker only once it is.
 */
import * as NodeHttp from "node:http";

import {
  BOARD_WORKER_JOIN_CODE_TTL_MINUTES,
  type BoardWorkerJoinMilestone,
  type EnvironmentId,
  type WorkerTunnelHello,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  decodeWorkerToken,
  encodeWorkerToken,
  readWorkerSnapshot,
  workerSecretName,
} from "../workers/WorkerConnections.ts";
import { WorkerTransport } from "../workers/WorkerTransport.ts";
import { BoardWorkerJoinStore, hashSecret } from "./BoardWorkerJoinStore.ts";
import { TunnelBoard, type TunnelPhase, type TunnelSessionDecision } from "./tunnelBoard.ts";
import type { BoardTunnelSeamHandler } from "./upgradeSeam.ts";
import { handleWorkerProxyRequest, handleWorkerProxyUpgrade } from "./workerProxy.ts";

export interface TunnelEntry {
  readonly phase: TunnelPhase;
  /** Bumped each time the worker reaches `ready`, so a waiter sees a fresh handoff. */
  readonly readyEpoch: number;
  readonly hello: WorkerTunnelHello | null;
}

/** Join progress, by worker: what Add worker ticks off. */
export type JoinMilestones = ReadonlyMap<string, ReadonlyArray<BoardWorkerJoinMilestone>>;

export interface BoardTunnelHostShape {
  /** Open the worker's stable loopback listener (once); its URL for `WorkerTransport`. */
  readonly ensure: (workerId: EnvironmentId) => Effect.Effect<string>;
  /** Close the worker's listener and tunnel (Remove). */
  readonly close: (workerId: EnvironmentId) => Effect.Effect<void>;
  readonly entries: Effect.Effect<ReadonlyMap<string, TunnelEntry>>;
  /** Every entry now, then after each change. Each access subscribes. */
  readonly states: Stream.Stream<ReadonlyMap<string, TunnelEntry>>;
  readonly milestones: SubscriptionRef.SubscriptionRef<JoinMilestones>;
  /** A code was just used by this worker: its milestones start over. */
  readonly beginJoin: (workerId: EnvironmentId) => Effect.Effect<void>;
  readonly markMilestone: (
    workerId: EnvironmentId,
    milestone: BoardWorkerJoinMilestone,
  ) => Effect.Effect<void>;
  /** Drop the worker's current tunnel; it redials. */
  readonly disconnect: (workerId: EnvironmentId) => Effect.Effect<void>;
  /** The byte-pipe handlers the HTTP seam routes to. */
  readonly seam: Omit<BoardTunnelSeamHandler, "join">;
}

export class BoardTunnelHost extends Context.Service<BoardTunnelHost, BoardTunnelHostShape>()(
  "t3/board/tunnel/BoardTunnelHost",
) {}

const DOWN: TunnelEntry = { phase: "down", readyEpoch: 0, hello: null };

/** Milestones are kept only while Add worker could still be watching. */
export const JOIN_PROGRESS_TTL_MS = BOARD_WORKER_JOIN_CODE_TTL_MINUTES * 60_000 * 2;

const withMilestone = (
  map: JoinMilestones,
  workerId: string,
  milestone: BoardWorkerJoinMilestone,
): JoinMilestones => {
  const current = map.get(workerId);
  if (current === undefined || current.includes(milestone)) return map;
  return new Map(map).set(workerId, [...current, milestone]);
};

/** Fetch the worker's descriptor through its listener, for the proxy's `.well-known`. */
function fetchDescriptor(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const request = NodeHttp.get(
      {
        host: "127.0.0.1",
        port,
        path: "/.well-known/t3/environment",
        agent: false,
        timeout: 10_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => {
          try {
            resolve(response.statusCode === 200 ? JSON.parse(body) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("error", () => resolve(null));
    request.on("timeout", () => request.destroy());
  });
}

export const makeBoardTunnelHost = Effect.gen(function* () {
  const store = yield* BoardWorkerJoinStore;
  const secrets = yield* ServerSecretStore;
  const transport = yield* WorkerTransport;
  const sessions = yield* Effect.serviceOption(SessionStore);
  const settings = yield* Effect.serviceOption(ServerSettingsService);

  const entries = yield* SubscriptionRef.make<ReadonlyMap<string, TunnelEntry>>(new Map());
  const milestones = yield* SubscriptionRef.make<JoinMilestones>(new Map());
  const descriptors = new Map<string, unknown>();
  const context = yield* Effect.context<never>();
  const run = <A>(effect: Effect.Effect<A>) => Effect.runPromiseWith(context)(effect);

  const markMilestone: BoardTunnelHostShape["markMilestone"] = (workerId, milestone) =>
    SubscriptionRef.update(milestones, (map) => withMilestone(map, workerId, milestone));

  const urlOf = (port: number) => `http://127.0.0.1:${port}`;

  const readToken = (workerId: string) =>
    secrets.get(workerSecretName(workerId as EnvironmentId)).pipe(
      Effect.map(Option.map(decodeWorkerToken)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  /** Prove a session through the tunnel: unauthorized, or the worker answered. */
  const probe = (port: number, token: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const link = yield* transport.connect({ url: urlOf(port), accessToken: token });
        yield* link.rpc.hello;
        yield* readWorkerSnapshot(link.rpc);
        return "ok" as const;
      }),
    ).pipe(
      Effect.catchTags({
        WorkerConnectError: (error) =>
          Effect.succeed(
            error.reason === "unauthorized" ? ("unauthorized" as const) : ("failed" as const),
          ),
        // A worker below the gateway floor still keeps its tunnel: it shows Needs update.
        WorkerRpcError: (error) =>
          Effect.succeed(error.unsupported === true ? ("ok" as const) : ("failed" as const)),
      }),
    );

  const liveBoardSessionIds = Option.isNone(sessions)
    ? Effect.succeed([] as ReadonlyArray<string>)
    : sessions.value.listActive().pipe(
        Effect.map((active) => active.map((session) => session.sessionId as string)),
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
      );

  const boardAddress = Option.isNone(settings)
    ? Effect.succeed<string | undefined>(undefined)
    : settings.value.getSettings.pipe(
        Effect.map((value) => value.board?.workers.boardAddress ?? undefined),
        Effect.orElseSucceed(() => undefined),
      );

  const decide = Effect.fn("BoardTunnelHost.decide")(function* (
    workerId: string,
    hello: WorkerTunnelHello,
    port: number,
  ) {
    yield* markMilestone(workerId as EnvironmentId, "connected");
    yield* markMilestone(workerId as EnvironmentId, "reading");
    const handed = hello.boardSession;
    const token = handed ?? Option.getOrUndefined(yield* readToken(workerId));
    if (token === undefined) return { status: "needs-session" } satisfies TunnelSessionDecision;
    const proved = yield* probe(port, token);
    if (proved === "unauthorized") {
      return { status: "needs-session" } satisfies TunnelSessionDecision;
    }
    if (proved === "failed") {
      return { status: "retry" } satisfies TunnelSessionDecision;
    }
    if (handed !== undefined) {
      yield* secrets
        .set(workerSecretName(workerId as EnvironmentId), encodeWorkerToken(handed))
        .pipe(Effect.orDie);
    }
    yield* markMilestone(workerId as EnvironmentId, "checking");
    const address = yield* boardAddress;
    return {
      status: "ok",
      liveBoardSessionIds: yield* liveBoardSessionIds,
      ...(address === undefined ? {} : { boardAddress: address }),
    } satisfies TunnelSessionDecision;
  });

  const publish = (board: TunnelBoard) =>
    SubscriptionRef.update(entries, (previous) => {
      const next = new Map<string, TunnelEntry>();
      for (const workerId of new Set([...previous.keys(), ...board.workerIds()])) {
        const endpoint = board.endpoint(workerId);
        if (endpoint === null) continue;
        const before = previous.get(workerId) ?? DOWN;
        const phase = endpoint.phase;
        const readyEpoch =
          phase === "ready" && before.phase !== "ready" ? before.readyEpoch + 1 : before.readyEpoch;
        next.set(workerId, { phase, readyEpoch, hello: board.hello(workerId) });
      }
      return next;
    });

  const board: TunnelBoard = new TunnelBoard({
    verifyCredential: (credential) => run(store.verifyCredential(hashSecret(credential))),
    onHello: (workerId, hello) => {
      const endpoint = board.endpoint(workerId);
      if (endpoint === null)
        return Promise.resolve({ status: "refused", message: "Not registered." });
      return run(decide(workerId, hello, endpoint.port));
    },
    onReady: (workerId, _hello, credential) => {
      void run(
        Effect.gen(function* () {
          // A re-join's old credential goes only once the new one is proved.
          yield* store.revokeCredentials({
            workerId,
            at: DateTime.formatIso(yield* DateTime.now),
            keep: hashSecret(credential),
          });
          yield* markMilestone(workerId as EnvironmentId, "joined");
        }),
      );
      const endpoint = board.endpoint(workerId);
      if (endpoint !== null) {
        void fetchDescriptor(endpoint.port).then((descriptor) => {
          if (descriptor !== null) descriptors.set(workerId, descriptor);
        });
      }
    },
    onGoodbye: (workerId) => {
      void run(Effect.logInfo("A worker left this board from its side.", { workerId }));
    },
    onChange: () => {
      void run(publish(board));
    },
  });

  yield* Effect.addFinalizer(() => Effect.sync(() => board.close()));

  const proxyTarget = {
    endpoint: (workerId: string) => {
      const endpoint = board.endpoint(workerId);
      return endpoint === null ? null : { port: endpoint.port, ready: endpoint.phase === "ready" };
    },
    descriptor: (workerId: string) => descriptors.get(workerId) ?? null,
  };

  const service: BoardTunnelHostShape = {
    ensure: (workerId) =>
      Effect.promise(() => board.ensureListener(workerId)).pipe(
        Effect.tap(() => publish(board)),
        Effect.map(urlOf),
      ),
    close: (workerId) =>
      Effect.sync(() => {
        board.closeListener(workerId);
        descriptors.delete(workerId);
      }).pipe(Effect.andThen(publish(board))),
    entries: SubscriptionRef.get(entries),
    states: SubscriptionRef.changes(entries),
    milestones,
    beginJoin: (workerId) =>
      SubscriptionRef.update(milestones, (map) => new Map(map).set(workerId, ["code-accepted"])),
    markMilestone,
    seam: {
      control: (request, socket, head) => board.handleControl(request, socket, head),
      stream: (request, socket, head) => board.handleStream(request, socket, head),
      proxyUpgrade: (request, socket, head) =>
        handleWorkerProxyUpgrade(proxyTarget, request, socket, head),
      proxyRequest: (request, response) => handleWorkerProxyRequest(proxyTarget, request, response),
    },
    disconnect: (workerId) => Effect.sync(() => board.disconnect(workerId)),
  };
  return service;
});

export const BoardTunnelHostLive = Layer.effect(BoardTunnelHost, makeBoardTunnelHost);
