// @effect-diagnostics nodeBuiltinImport:off - the worker is a real local HTTP and WebSocket server.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import {
  BOARD_WORKER_PROTOCOL_VERSION,
  BOARD_WORKER_RPCS,
  EnvironmentId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { makeBoardTunnelHost } from "../tunnel/BoardTunnelHost.ts";
import {
  BoardWorkerJoinStore,
  hashSecret,
  makeMemoryBoardWorkerJoinStore,
} from "../tunnel/BoardWorkerJoinStore.ts";
import { TunnelWorker } from "../tunnel/tunnelWorker.ts";
import { decodeWorkerToken, workerSecretName } from "./WorkerConnections.ts";
import { WorkerTransport, WorkerTransportLive } from "./WorkerTransport.ts";
import { makeFakeWorkerLayer } from "./workers.testkit.ts";

/** Just the worker side of the board protocol, served the way a T3o worker
    serves its whole RPC group: JSON over `/ws`, behind a ticket. */
const group = RpcGroup.make(...BOARD_WORKER_RPCS);

const handlers = group.toLayer({
  "boardWorker.hello": () =>
    Effect.succeed({
      protocolVersion: BOARD_WORKER_PROTOCOL_VERSION,
      environmentId: EnvironmentId.make("env-worker"),
      t3oVersion: "0.0.45",
      sessionExpiresAt: null,
    }),
  "boardWorker.projects": () => Effect.succeed({ projects: [] }),
  "boardWorker.providers": () => Effect.succeed({ providers: [], projectsFolder: null }),
  "boardWorker.release": () => Effect.void,
  "boardWorker.renew": () => Effect.succeed({ accessToken: "token-2" }),
  "boardWorker.mintUserSession": (input) =>
    Effect.succeed({
      bearerToken: `user-${input.boardSessionId}`,
      expiresAt: "2026-11-13T00:00:00.000Z",
      scopes: input.scopes,
    }),
  "boardWorker.revokeUserSessions": (input) =>
    Effect.succeed({ revoked: input.boardSessionIds.length }),
});

/** An upstream server: the same socket, but no `boardWorker.hello`. */
const [, projectsRpc, providersRpc, releaseRpc] = BOARD_WORKER_RPCS;
const upstreamGroup = RpcGroup.make(projectsRpc, providersRpc, releaseRpc);
const upstreamHandlers = upstreamGroup.toLayer({
  "boardWorker.projects": () => Effect.succeed({ projects: [] }),
  "boardWorker.providers": () => Effect.succeed({ providers: [], projectsFolder: null }),
  "boardWorker.release": () => Effect.void,
});

/** A path prefix, as `HttpRouter` routes need it. */
type Prefix = "" | `/${string}`;

const ticketRoute = (prefix: Prefix) =>
  HttpRouter.add(
    "POST",
    `${prefix}/api/auth/websocket-ticket`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.authorization !== "Bearer good-token") {
        return HttpServerResponse.text("revoked", { status: 401 });
      }
      return yield* HttpServerResponse.json({
        ticket: "ticket-1",
        expiresAt: "2026-10-21T10:05:00.000Z",
      });
    }),
  );

const routes = (options: { readonly prefix: Prefix; readonly upstream: boolean }) =>
  Layer.mergeAll(
    ticketRoute(options.prefix),
    options.upstream
      ? RpcServer.layerHttp({
          group: upstreamGroup,
          path: `${options.prefix}/ws`,
          protocol: "websocket",
        }).pipe(Layer.provide(upstreamHandlers), Layer.provide(RpcSerialization.layerJson))
      : RpcServer.layerHttp({ group, path: `${options.prefix}/ws`, protocol: "websocket" }).pipe(
          Layer.provide(handlers),
          Layer.provide(RpcSerialization.layerJson),
        ),
  ).pipe(Layer.provide(NodeHttpPlatform.layer));

/** A worker on a local port. `prefix` serves it under a path, as behind a
    reverse proxy; `upstream` leaves out the board-worker handshake. */
const serveWorker = (options: { readonly prefix?: Prefix; readonly upstream?: boolean } = {}) =>
  Effect.gen(function* () {
    const prefix = options.prefix ?? "";
    const server = yield* Layer.build(
      HttpRouter.serve(routes({ prefix, upstream: options.upstream ?? false }), {
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
        ),
      ),
    );
    const address = Context.get(server, HttpServer.HttpServer).address;
    if (!("port" in address)) return yield* Effect.die("Expected a TCP server");
    return `http://127.0.0.1:${address.port}${prefix}`;
  });

const transport = WorkerTransportLive.pipe(Layer.provide(FetchHttpClient.layer));

it.live("dials a worker with a ticket and speaks the board-worker protocol", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* serveWorker();
      const workers = yield* WorkerTransport;
      const link = yield* workers.connect({ url, accessToken: "good-token" });
      const hello = yield* link.rpc.hello;
      assert.strictEqual(hello.environmentId, "env-worker");
      assert.strictEqual(hello.protocolVersion, BOARD_WORKER_PROTOCOL_VERSION);
      assert.deepStrictEqual(yield* link.rpc.projects, { projects: [] });
    }),
  ).pipe(Effect.provide(transport)),
);

it.live("a refused session is unauthorized, not unreachable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* serveWorker();
      const workers = yield* WorkerTransport;
      const failure = yield* Effect.flip(workers.connect({ url, accessToken: "revoked-token" }));
      assert.strictEqual(failure.reason, "unauthorized");
    }),
  ).pipe(Effect.provide(transport)),
);

it.live("nothing listening is unreachable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workers = yield* WorkerTransport;
      const failure = yield* Effect.flip(
        workers.connect({ url: "http://127.0.0.1:9", accessToken: "good-token" }),
      );
      assert.strictEqual(failure.reason, "unreachable");
    }),
  ).pipe(Effect.provide(transport)),
);

it.live("a worker served under a path prefix is dialed under that prefix", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* serveWorker({ prefix: "/t3" });
      const workers = yield* WorkerTransport;
      const link = yield* workers.connect({ url, accessToken: "good-token" });
      assert.strictEqual((yield* link.rpc.hello).environmentId, "env-worker");
    }),
  ).pipe(Effect.provide(transport)),
);

it.live("a server with no board-worker handshake fails hello as unsupported", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* serveWorker({ upstream: true });
      const workers = yield* WorkerTransport;
      const link = yield* workers.connect({ url, accessToken: "good-token" });
      const failure = yield* Effect.flip(link.rpc.hello);
      assert.isTrue(failure.unsupported);
      // A call it does have still works on the same connection.
      assert.deepStrictEqual(yield* link.rpc.projects, { projects: [] });
    }),
  ).pipe(Effect.provide(transport)),
);

// ── End to end over an outbound tunnel (T3O-84) ──────────────────────

it.live("a worker joined over its tunnel: session handoff, probe, then the board's calls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerUrl = yield* serveWorker();
      const workerPort = Number(new URL(workerUrl).port);
      const kit = yield* makeFakeWorkerLayer;
      const joinStore = yield* makeMemoryBoardWorkerJoinStore;
      yield* joinStore.issueCredential({
        workerId: "env-worker",
        credentialHash: hashSecret("tunnel-credential"),
        issuedAt: "2026-11-12T10:00:00.000Z",
      });
      const host = yield* makeBoardTunnelHost.pipe(
        Effect.provideService(BoardWorkerJoinStore, joinStore),
        Effect.provideService(ServerSecretStore, kit.secrets.store),
      );
      // The board's HTTP server, routing tunnel upgrades the way the seam does.
      const board = NodeHttp.createServer();
      board.on("upgrade", (request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer) => {
        if ((request.url ?? "").startsWith("/api/t3o/worker-tunnel/stream")) {
          host.seam.stream(request, socket, head);
        } else {
          host.seam.control(request, socket, head);
        }
      });
      const boardPort = yield* Effect.callback<number>((resume) => {
        board.listen(0, "127.0.0.1", () =>
          resume(Effect.succeed((board.address() as NodeNet.AddressInfo).port)),
        );
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          board.closeAllConnections();
          board.close();
        }),
      );
      const endpoint = yield* host.ensure(EnvironmentId.make("env-worker"));

      const minted: Array<string> = [];
      const tunnel = new TunnelWorker({
        boardUrl: `http://127.0.0.1:${boardPort}`,
        credential: "tunnel-credential",
        environmentId: EnvironmentId.make("env-worker"),
        label: "linux-box",
        t3oRelease: "t3o0.1.8.3",
        gatewayProtocol: BOARD_WORKER_PROTOCOL_VERSION,
        local: { host: "127.0.0.1", port: workerPort },
        mintBoardSession: async () => {
          minted.push("good-token");
          return "good-token";
        },
      });
      tunnel.start();
      yield* Effect.addFinalizer(() => Effect.sync(() => tunnel.stop()));

      // The board held no session, asked for one, proved it through the tunnel, stored it.
      yield* host.states.pipe(
        Stream.filter((entries) => entries.get("env-worker")?.phase === "ready"),
        Stream.runHead,
      );
      assert.deepStrictEqual(minted, ["good-token"]);
      const stored = yield* kit.secrets.store.get(workerSecretName(EnvironmentId.make("env-worker")));
      assert.strictEqual(Option.map(stored, decodeWorkerToken).pipe(Option.getOrNull), "good-token");

      // The gateway's own transport dials the loopback endpoint, through the tunnel.
      const workers = yield* WorkerTransport;
      const link = yield* workers.connect({ url: endpoint, accessToken: "good-token" });
      assert.strictEqual((yield* link.rpc.hello).environmentId, "env-worker");
      assert.deepStrictEqual(yield* link.rpc.projects, { projects: [] });
    }),
  ).pipe(Effect.provide(transport)),
);
