// @effect-diagnostics nodeBuiltinImport:off - the worker is a real local HTTP and WebSocket server.
import * as NodeHttp from "node:http";

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
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

import { WorkerTransport, WorkerTransportLive } from "./WorkerTransport.ts";

/** Just the worker side of the board protocol, served the way a T3o worker
    serves its whole RPC group: JSON over `/ws`, behind a ticket. */
const group = RpcGroup.make(...BOARD_WORKER_RPCS);

const handlers = group.toLayer({
  "boardWorker.hello": () =>
    Effect.succeed({
      protocolVersion: BOARD_WORKER_PROTOCOL_VERSION,
      environmentId: EnvironmentId.make("env-worker"),
      t3oVersion: "0.0.45",
    }),
  "boardWorker.projects": () => Effect.succeed({ projects: [] }),
  "boardWorker.providers": () => Effect.succeed({ providers: [], projectsFolder: null }),
  "boardWorker.release": () => Effect.void,
});

const ticketRoute = HttpRouter.add(
  "POST",
  "/api/auth/websocket-ticket",
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

const routes = Layer.mergeAll(
  ticketRoute,
  RpcServer.layerHttp({ group, path: "/ws", protocol: "websocket" }).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcSerialization.layerJson),
  ),
).pipe(Layer.provide(NodeHttpPlatform.layer));

const serveWorker = Effect.gen(function* () {
  const server = yield* Layer.build(
    HttpRouter.serve(routes, { disableListenLog: true }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
      ),
    ),
  );
  const address = Context.get(server, HttpServer.HttpServer).address;
  if (!("port" in address)) return yield* Effect.die("Expected a TCP server");
  return `http://127.0.0.1:${address.port}`;
});

const transport = WorkerTransportLive.pipe(Layer.provide(FetchHttpClient.layer));

it.live("dials a worker with a ticket and speaks the board-worker protocol", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* serveWorker;
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
      const url = yield* serveWorker;
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
