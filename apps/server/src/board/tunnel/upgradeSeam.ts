// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - plain Node sockets and files: a byte pipe below Effect, also used by the CLI.
/**
 * T3o's one hook into upstream's Node HTTP server (T3O-84): the worker tunnel, the join
 * endpoint and the browser proxy to workers are byte pipes, which Effect's router can't
 * be (its upgrade hides the socket and terminates WebSockets itself). `server.ts` calls
 * `installBoardTunnelSeam` on the server it creates; requests and upgrades under T3o's
 * paths come here, everything else reaches Effect untouched.
 *
 * This wraps `emit` rather than adding listeners: Effect's own listener would otherwise
 * see the same events. The board's services register a handler once their layer is
 * built; until then T3o's paths answer 503.
 */
import type * as Http from "node:http";
import type * as Net from "node:net";

import {
  BOARD_WORKER_JOIN_PATH,
  BOARD_WORKER_PROXY_PREFIX,
  BOARD_WORKER_TUNNEL_PATH,
  BOARD_WORKER_TUNNEL_STREAM_PATH,
} from "@t3tools/contracts";

import { refuseUpgrade } from "./lineChannel.ts";

export interface BoardTunnelSeamHandler {
  readonly control: (request: Http.IncomingMessage, socket: Net.Socket, head: Buffer) => void;
  readonly stream: (request: Http.IncomingMessage, socket: Net.Socket, head: Buffer) => void;
  readonly proxyUpgrade: (request: Http.IncomingMessage, socket: Net.Socket, head: Buffer) => void;
  readonly proxyRequest: (request: Http.IncomingMessage, response: Http.ServerResponse) => void;
  readonly join: (request: Http.IncomingMessage, response: Http.ServerResponse) => void;
}

let current: BoardTunnelSeamHandler | null = null;

/** Register (or with null, withdraw) the board's handler. Returns the withdrawal. */
export function setBoardTunnelSeamHandler(handler: BoardTunnelSeamHandler | null): () => void {
  current = handler;
  return () => {
    if (current === handler) current = null;
  };
}

type Route =
  | "control"
  | "stream"
  | "proxy"
  | "join"
  | null;

export function routeOf(url: string | undefined): Route {
  const queryAt = (url ?? "/").indexOf("?");
  const pathname = queryAt === -1 ? (url ?? "/") : (url ?? "/").slice(0, queryAt);
  if (pathname === BOARD_WORKER_TUNNEL_STREAM_PATH) return "stream";
  if (pathname === BOARD_WORKER_TUNNEL_PATH) return "control";
  if (pathname === BOARD_WORKER_JOIN_PATH) return "join";
  if (pathname.startsWith(BOARD_WORKER_PROXY_PREFIX)) return "proxy";
  return null;
}

/** Route one upgrade; false when it isn't T3o's, so upstream handles it. */
export function routeBoardTunnelUpgrade(
  handler: BoardTunnelSeamHandler | null,
  request: Http.IncomingMessage,
  socket: Net.Socket,
  head: Buffer,
): boolean {
  const route = routeOf(request.url);
  if (route === null || route === "join") return false;
  if (handler === null) {
    refuseUpgrade(socket, 503, "Service Unavailable");
    return true;
  }
  if (route === "control") handler.control(request, socket, head);
  else if (route === "stream") handler.stream(request, socket, head);
  else handler.proxyUpgrade(request, socket, head);
  return true;
}

/** Route one request; false when it isn't T3o's. */
export function routeBoardTunnelRequest(
  handler: BoardTunnelSeamHandler | null,
  request: Http.IncomingMessage,
  response: Http.ServerResponse,
): boolean {
  const route = routeOf(request.url);
  if (route !== "join" && route !== "proxy") return false;
  if (handler === null) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "board-starting" }));
    return true;
  }
  if (route === "join") handler.join(request, response);
  else handler.proxyRequest(request, response);
  return true;
}

export function installBoardTunnelSeam<S extends Http.Server>(server: S): S {
  const emit = server.emit.bind(server) as (event: string | symbol, ...args: unknown[]) => boolean;
  server.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === "upgrade") {
      const [request, socket, head] = args as [Http.IncomingMessage, Net.Socket, Buffer];
      if (routeBoardTunnelUpgrade(current, request, socket, head)) return true;
    } else if (event === "request") {
      const [request, response] = args as [Http.IncomingMessage, Http.ServerResponse];
      if (routeBoardTunnelRequest(current, request, response)) return true;
    }
    return emit(event, ...args);
  }) as S["emit"];
  return server;
}
