/**
 * T3o (T3O-62, D19): the central server's line to one worker.
 *
 * `WorkerRpc` is the narrow, typed slice of a worker's WebSocket RPC the
 * board uses. Later plans grow it (the remote thread gateway, the MCP relay,
 * the named git operations); it never becomes the whole `WsRpcGroup` client,
 * so a test transport can fake exactly what the board relies on.
 *
 * `WorkerTransport.connect` dials with the board's bearer token: a WebSocket
 * ticket from `/api/auth/websocket-ticket`, then `/ws`. It resolves once the
 * socket is open and hands back a `WorkerLink` whose `closed` completes when
 * the socket drops. Reconnecting is the connection manager's job, so the
 * socket itself never retries.
 */
import {
  BOARD_WORKER_WS_METHODS,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WS_METHODS,
  WsRpcGroup,
  type BoardWorkerHello,
  type BoardWorkerProjects,
  type BoardWorkerProviders,
  type ProjectCloneListEvent,
  type ProjectCloneStartInput,
  type ProjectCloneStartResult,
  type ProjectId,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

/** A worker RPC failed: refused, or the connection went. */
export class WorkerRpcError extends Data.TaggedError("WorkerRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Why a dial failed. `unauthorized` is the worker refusing the board's
    session — revoked on its side, or the worker was reset. */
export class WorkerConnectError extends Data.TaggedError("WorkerConnectError")<{
  readonly reason: "unreachable" | "unauthorized";
  readonly message: string;
}> {}

/** The slice of a worker's RPC the board uses. */
export interface WorkerRpc {
  readonly hello: Effect.Effect<BoardWorkerHello, WorkerRpcError>;
  readonly projects: Effect.Effect<BoardWorkerProjects, WorkerRpcError>;
  readonly providers: Effect.Effect<BoardWorkerProviders, WorkerRpcError>;
  /** Revoke the calling session on the worker (Remove). */
  readonly release: Effect.Effect<void, WorkerRpcError>;
  readonly startProjectClone: (
    input: ProjectCloneStartInput,
  ) => Effect.Effect<ProjectCloneStartResult, WorkerRpcError>;
  readonly retryProjectClone: (projectId: ProjectId) => Effect.Effect<boolean, WorkerRpcError>;
  /** Every tracked clone on the worker, once now and again on each change. */
  readonly projectClones: Stream.Stream<ProjectCloneListEvent, WorkerRpcError>;
}

export interface WorkerLink {
  readonly rpc: WorkerRpc;
  /** Completes when the connection drops. */
  readonly closed: Effect.Effect<void>;
}

export interface WorkerTransportShape {
  /** Dial a worker. The link lives as long as the scope. */
  readonly connect: (input: {
    readonly url: string;
    readonly accessToken: string;
  }) => Effect.Effect<WorkerLink, WorkerConnectError, Scope.Scope>;
}

export class WorkerTransport extends Context.Service<WorkerTransport, WorkerTransportShape>()(
  "t3/board/workers/WorkerTransport",
) {}

/** How long the socket may take to open, and how long without a frame before
    a worker counts as gone — client-runtime's own budgets. */
const SOCKET_OPEN_TIMEOUT = "10 seconds";
const PING_TIMEOUT = "15 seconds";
const TICKET_TIMEOUT = "10 seconds";

const TicketResponse = Schema.Struct({ ticket: Schema.String });
const decodeTicket = Schema.decodeUnknownEffect(TicketResponse);

const toWsUrl = (url: string, ticket: string): string => {
  const next = new URL("/ws", url);
  next.protocol = next.protocol === "https:" ? "wss:" : "ws:";
  next.searchParams.set("wsTicket", ticket);
  next.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return next.toString();
};

const requestTicket = (url: string, accessToken: string) =>
  Effect.gen(function* () {
    const unreachable = new WorkerConnectError({
      reason: "unreachable",
      message: `Couldn't reach ${url}.`,
    });
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.post(new URL("/api/auth/websocket-ticket", url).toString()).pipe(
          HttpClientRequest.bearerToken(accessToken),
        ),
      )
      .pipe(
        Effect.timeout(TICKET_TIMEOUT),
        Effect.mapError(() => unreachable),
      );
    if (response.status === 401 || response.status === 403) {
      return yield* new WorkerConnectError({
        reason: "unauthorized",
        message: "The worker no longer accepts this board's session.",
      });
    }
    if (response.status !== 200) return yield* unreachable;
    const body = yield* response.json.pipe(Effect.mapError(() => unreachable));
    const decoded = yield* decodeTicket(body).pipe(Effect.mapError(() => unreachable));
    return decoded.ticket;
  });

const rpcError = (message: string) => (cause: unknown) => new WorkerRpcError({ message, cause });

/** The live transport: a real socket and `RpcClient` over `WsRpcGroup`. */
export const WorkerTransportLive = Layer.effect(
  WorkerTransport,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return {
      connect: (input) =>
        connectWorker(input).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    } satisfies WorkerTransportShape;
  }),
);

const connectWorker = ({
  url,
  accessToken,
}: {
  readonly url: string;
  readonly accessToken: string;
}) =>
  Effect.gen(function* () {
    const ticket = yield* requestTicket(url, accessToken);
    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<void>();
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
    });
    const layerProtocol = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        pingTimeout: PING_TIMEOUT,
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(toWsUrl(url, ticket), { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
            Layer.provide(NodeSocket.layerWebSocketConstructor),
          ),
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const context = yield* Layer.build(layerProtocol);
    const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(context));
    // The socket opens lazily; ask for the handshake's first frame by waiting
    // for whichever comes first.
    const opened = yield* Effect.raceFirst(
      Deferred.await(connected).pipe(Effect.as(true)),
      Deferred.await(disconnected).pipe(Effect.as(false)),
    );
    if (!opened) {
      return yield* new WorkerConnectError({
        reason: "unreachable",
        message: `Couldn't open a connection to ${url}.`,
      });
    }
    const rpc: WorkerRpc = {
      hello: client[BOARD_WORKER_WS_METHODS.hello]({}).pipe(
        Effect.mapError(rpcError("The worker didn't answer the board's handshake.")),
      ),
      projects: client[BOARD_WORKER_WS_METHODS.projects]({}).pipe(
        Effect.mapError(rpcError("The worker didn't list its projects.")),
      ),
      providers: client[BOARD_WORKER_WS_METHODS.providers]({}).pipe(
        Effect.mapError(rpcError("The worker didn't list its providers.")),
      ),
      release: client[BOARD_WORKER_WS_METHODS.release]({}).pipe(
        Effect.mapError(rpcError("The worker didn't release the board's session.")),
      ),
      startProjectClone: (input) =>
        client[WS_METHODS.projectCloneStart](input).pipe(
          Effect.mapError(rpcError("The worker couldn't start the clone.")),
        ),
      retryProjectClone: (projectId) =>
        client[WS_METHODS.projectCloneRetry]({ projectId }).pipe(
          Effect.map((result) => result.applied),
          Effect.mapError(rpcError("The worker couldn't retry the clone.")),
        ),
      projectClones: client[WS_METHODS.subscribeProjectClones]({}).pipe(
        Stream.mapError(rpcError("The worker's clone progress stream ended.")),
      ),
    };
    return { rpc, closed: Deferred.await(disconnected) };
  });
