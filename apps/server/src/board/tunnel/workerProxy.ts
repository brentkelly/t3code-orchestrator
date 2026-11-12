// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - plain Node sockets and files: a byte pipe below Effect, also used by the CLI.
/**
 * The board's proxy from browsers to a worker at `/api/t3o/workers/<id>/…`, through its
 * tunnel. Only what a thread view needs is forwarded, never the web UI, bootstrap or
 * pairing. The worker shares the board's origin here, so it is bearer-only, cookies stripped.
 */
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import { BOARD_WORKER_PROXY_PREFIX } from "@t3tools/contracts";

import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "../../httpCors.ts";
import { joinSockets, refuseUpgrade } from "./lineChannel.ts";

export interface WorkerProxyTarget {
  /** The worker's loopback listener, or null when it isn't registered. */
  readonly endpoint: (
    workerId: string,
  ) => { readonly port: number; readonly ready: boolean } | null;
  /** The worker's `/.well-known/t3/environment`: the cached one, else fetched now. */
  readonly descriptor: (workerId: string) => unknown;
}

export interface ProxiedPath {
  readonly workerId: string;
  /** The path on the worker, with its query. */
  readonly path: string;
  readonly pathname: string;
}

function parseProxiedPath(url: string | undefined): ProxiedPath | null {
  const parsed = new URL(url ?? "/", "http://board");
  if (!parsed.pathname.startsWith(BOARD_WORKER_PROXY_PREFIX)) return null;
  const rest = parsed.pathname.slice(BOARD_WORKER_PROXY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let workerId: string;
  try {
    workerId = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return null;
  }
  const pathname = rest.slice(slash);
  return { workerId, pathname, path: `${pathname}${parsed.search}` };
}

const SIGNED_ASSET = /^\/api\/assets\/[^/]+\.[^/]+\/[^/]+/;

/**
 * Whether a thread view through the board may use this path on the worker. Never
 * `/api/auth/bootstrap*`, pairing, browser sessions, webhooks or the web UI.
 */
export function isProxyAllowed(method: string, pathname: string): boolean {
  if (pathname === "/ws" || pathname === "/ws/voice") return method === "GET";
  if (pathname.startsWith("/api/auth/websocket-ticket")) return true;
  if (pathname === "/api/auth/session") return true;
  if (pathname.startsWith("/api/assets/")) return true;
  if (pathname.startsWith("/api/attachments/") || pathname === "/api/attachments") return true;
  if (pathname === "/api/orchestration/shell") return true;
  if (pathname.startsWith("/api/orchestration/threads/")) return true;
  if (pathname === "/api/projects") return method === "GET";
  if (pathname === "/api/pull-requests/diff") return method === "POST";
  if (pathname.startsWith("/api/voice/")) return true;
  return false;
}

/** Whether a request is worth dialling: it carries a credential the worker will check. */
function carriesCredential(request: NodeHttp.IncomingMessage, pathname: string): boolean {
  if (/^Bearer\s+\S+/i.test(request.headers.authorization ?? "")) return true;
  if (pathname === "/ws" || pathname === "/ws/voice") {
    return new URL(request.url ?? "/", "http://board").searchParams.has("wsTicket");
  }
  return SIGNED_ASSET.test(pathname);
}

const STRIPPED_REQUEST_HEADERS = new Set([
  "cookie",
  "dpop",
  "forwarded",
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
]);

function forwardedRequestHeaders(
  request: NodeHttp.IncomingMessage,
  port: number,
  upgrade: boolean,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower) || lower.startsWith("x-forwarded-")) continue;
    if (!upgrade && lower === "upgrade") continue;
    headers[lower] = value;
  }
  headers.host = `127.0.0.1:${port}`;
  if (upgrade) headers.connection = "Upgrade";
  return headers;
}

function sendJson(response: NodeHttp.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function corsHeaders(request: NodeHttp.IncomingMessage): Record<string, string> {
  const origin = request.headers.origin;
  if (origin === undefined) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
    "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function handleWorkerProxyRequest(
  target: WorkerProxyTarget,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
): void {
  const proxied = parseProxiedPath(request.url);
  if (proxied === null) {
    sendJson(response, 404, { code: "not-found" });
    return;
  }
  const method = request.method ?? "GET";
  if (proxied.pathname === "/.well-known/t3/environment" && method === "GET") {
    void Promise.resolve(target.descriptor(proxied.workerId))
      .catch(() => null)
      .then((descriptor) => {
        if (descriptor === null || descriptor === undefined) {
          sendJson(response, 503, { code: "worker-offline" });
          return;
        }
        response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
        sendJson(response, 200, descriptor);
      });
    return;
  }
  if (method === "OPTIONS") {
    const requested = request.headers["access-control-request-method"] ?? "GET";
    if (!isProxyAllowed(requested, proxied.pathname)) {
      sendJson(response, 404, { code: "not-found" });
      return;
    }
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }
  if (!isProxyAllowed(method, proxied.pathname)) {
    sendJson(response, 404, { code: "not-found" });
    return;
  }
  if (!carriesCredential(request, proxied.pathname)) {
    sendJson(response, 401, { code: "unauthorized" });
    return;
  }
  const endpoint = target.endpoint(proxied.workerId);
  if (endpoint === null) {
    sendJson(response, 404, { code: "not-found" });
    return;
  }
  if (!endpoint.ready) {
    sendJson(response, 503, { code: "worker-offline" });
    return;
  }
  const upstream = NodeHttp.request(
    {
      host: "127.0.0.1",
      port: endpoint.port,
      method,
      path: proxied.path,
      headers: forwardedRequestHeaders(request, endpoint.port, false),
      agent: proxyAgent,
    },
    (answer) => {
      const headers = { ...answer.headers };
      delete headers["set-cookie"];
      delete headers.connection;
      delete headers["keep-alive"];
      response.writeHead(answer.statusCode ?? 502, headers);
      // `pipe` leaves the browser waiting forever if the tunnel drops mid-body.
      NodeStream.pipeline(answer, response, () => undefined);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) sendJson(response, 503, { code: "worker-offline" });
    else response.destroy();
  });
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
}

/** Keep-alive into the listener, so a thread view's requests reuse tunnel streams. */
const proxyAgent = new NodeHttp.Agent({ keepAlive: true, timeout: 20_000 });

/** A WebSocket upgrade through the proxy: the request head rewritten, then raw bytes. */
export function handleWorkerProxyUpgrade(
  target: WorkerProxyTarget,
  request: NodeHttp.IncomingMessage,
  socket: NodeNet.Socket,
  head: Buffer,
): void {
  socket.on("error", () => undefined);
  const proxied = parseProxiedPath(request.url);
  if (proxied === null || !isProxyAllowed(request.method ?? "GET", proxied.pathname)) {
    refuseUpgrade(socket, 404, "Not Found");
    return;
  }
  if (!carriesCredential(request, proxied.pathname)) {
    refuseUpgrade(socket, 401, "Unauthorized");
    return;
  }
  const endpoint = target.endpoint(proxied.workerId);
  if (endpoint === null || !endpoint.ready) {
    refuseUpgrade(socket, 503, "Service Unavailable", { code: "worker-offline" });
    return;
  }
  const headers = forwardedRequestHeaders(request, endpoint.port, true);
  const lines = [`${request.method ?? "GET"} ${proxied.path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  let joined = false;
  const upstream = NodeNet.connect({ host: "127.0.0.1", port: endpoint.port }, () => {
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    joined = true;
    joinSockets(socket, upstream);
  });
  upstream.on("error", () => {
    // Once joined the browser's socket carries the worker's bytes: an HTTP reply would corrupt it.
    if (joined) socket.destroy();
    else refuseUpgrade(socket, 503, "Service Unavailable", { code: "worker-offline" });
  });
}
