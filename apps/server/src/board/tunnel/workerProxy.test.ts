// @effect-diagnostics nodeBuiltinImport:off - the proxy and seam are real sockets end to end.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { installBoardTunnelSeam, routeOf, setBoardTunnelSeamHandler } from "./upgradeSeam.ts";
import {
  handleWorkerProxyRequest,
  handleWorkerProxyUpgrade,
  isProxyAllowed,
  type WorkerProxyTarget,
} from "./workerProxy.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
}

/** The worker's loopback server, as the board's listener would reach it. */
async function startWorker() {
  const seen: Seen[] = [];
  const server = NodeHttp.createServer((request, response) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    response.setHeader("set-cookie", "worker=1");
    response.setHeader("content-security-policy", "default-src 'none'");
    response.end("from-worker");
  });
  const upgrades: Seen[] = [];
  server.on(
    "upgrade",
    (request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer) => {
      upgrades.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
      });
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      if (head.length > 0) socket.write(head);
      socket.on("data", (chunk: Buffer) => socket.write(chunk));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as NodeNet.AddressInfo).port, seen, upgrades };
}

/** The board: every request through the seam, everything else a plain 200 "upstream". */
async function startBoard(target: WorkerProxyTarget) {
  const server = installBoardTunnelSeam(
    NodeHttp.createServer((_request, response) => response.end("upstream")),
  );
  server.on("upgrade", (_request: NodeHttp.IncomingMessage, socket: NodeNet.Socket) => {
    socket.end("HTTP/1.1 418 Upstream\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    setBoardTunnelSeamHandler(null);
    server.closeAllConnections();
    server.close();
  });
  const register = () =>
    setBoardTunnelSeamHandler({
      control: (_request, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"),
      stream: (_request, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"),
      proxyUpgrade: (request, socket, head) =>
        handleWorkerProxyUpgrade(target, request, socket, head),
      proxyRequest: (request, response) => handleWorkerProxyRequest(target, request, response),
      join: (_request, response) => response.end("join"),
    });
  return { port: (server.address() as NodeNet.AddressInfo).port, register };
}

function request(
  port: number,
  options: { path: string; method?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string; headers: NodeHttp.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const sent = NodeHttp.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );
    sent.on("error", reject);
    sent.end();
  });
}

const WORKER = "env-worker";
const base = `/api/t3o/workers/${WORKER}`;

function targetFor(port: number | null, ready = true): WorkerProxyTarget & { dials: number } {
  const target = {
    dials: 0,
    endpoint: (workerId: string) => {
      if (workerId !== WORKER || port === null) return null;
      target.dials += 1;
      return { port, ready };
    },
    descriptor: (workerId: string) =>
      workerId === WORKER ? { environmentId: WORKER, label: "linux-box" } : null,
  };
  return target;
}

describe("worker proxy", () => {
  it("answers .well-known and preflights without dialling", async () => {
    const target = targetFor(null);
    const board = await startBoard(target);
    board.register();
    const known = await request(board.port, { path: `${base}/.well-known/t3/environment` });
    expect(JSON.parse(known.body)).toEqual({ environmentId: WORKER, label: "linux-box" });
    const preflight = await request(board.port, {
      path: `${base}/api/orchestration/threads/x`,
      method: "OPTIONS",
      headers: { origin: "https://board.example", "access-control-request-method": "GET" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://board.example");
    expect(target.dials).toBe(0);
  });

  it("refuses an unauthenticated request with 401 and paths off the list with 404, undialled", async () => {
    const worker = await startWorker();
    const target = targetFor(worker.port);
    const board = await startBoard(target);
    board.register();
    expect((await request(board.port, { path: `${base}/api/orchestration/shell` })).status).toBe(
      401,
    );
    for (const path of [
      "/",
      "/api/auth/bootstrap",
      "/api/auth/browser-session",
      "/oauth/token",
      "/api/webhooks/x",
    ]) {
      const answered = await request(board.port, {
        path: `${base}${path}`,
        method: "POST",
        headers: { authorization: "Bearer t" },
      });
      expect(answered.status, path).toBe(404);
    }
    expect(target.dials).toBe(0);
    expect(worker.seen).toEqual([]);
  });

  it("forwards a bearer request, stripping cookies and forwarding headers both ways", async () => {
    const worker = await startWorker();
    const board = await startBoard(targetFor(worker.port));
    board.register();
    const answered = await request(board.port, {
      path: `${base}/api/orchestration/shell?x=1`,
      headers: {
        authorization: "Bearer user-token",
        cookie: "t3_session=board",
        dpop: "proof",
        "x-forwarded-for": "203.0.113.1",
        forwarded: "for=203.0.113.1",
        origin: "https://board.example",
      },
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toBe("from-worker");
    expect(answered.headers["set-cookie"]).toBeUndefined();
    expect(answered.headers["content-security-policy"]).toBe("default-src 'none'");
    const [seen] = worker.seen;
    expect(seen?.url).toBe("/api/orchestration/shell?x=1");
    expect(seen?.headers.authorization).toBe("Bearer user-token");
    expect(seen?.headers.origin).toBe("https://board.example");
    for (const header of ["cookie", "dpop", "x-forwarded-for", "forwarded"]) {
      expect(seen?.headers[header], header).toBeUndefined();
    }
  });

  it("lets a signed asset URL through without a bearer: the worker checks the signature", async () => {
    const worker = await startWorker();
    const board = await startBoard(targetFor(worker.port));
    board.register();
    const answered = await request(board.port, {
      path: `${base}/api/assets/payload.signature/image.png`,
    });
    expect(answered.status).toBe(200);
    expect(worker.seen[0]?.url).toBe("/api/assets/payload.signature/image.png");
  });

  it("answers 404 to a malformed worker id instead of throwing out of the seam", async () => {
    const board = await startBoard(targetFor(null));
    board.register();
    const answered = await request(board.port, {
      path: "/api/t3o/workers/%zz/api/orchestration/shell",
      headers: { authorization: "Bearer t" },
    });
    expect(answered.status).toBe(404);
    const socket = NodeNet.connect({ host: "127.0.0.1", port: board.port });
    cleanups.push(() => socket.destroy());
    let refused = "";
    const closed = new Promise<void>((resolve) => {
      socket.on("data", (chunk: Buffer) => (refused += chunk.toString("latin1")));
      socket.on("close", () => resolve());
    });
    socket.write(
      "GET /api/t3o/workers/%zz/ws HTTP/1.1\r\nHost: board\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    await closed;
    expect(refused.startsWith("HTTP/1.1 404")).toBe(true);
    expect((await request(board.port, { path: "/api/projects" })).body).toBe("upstream");
  });

  it("answers 503 worker-offline while the worker's tunnel isn't ready", async () => {
    const board = await startBoard(targetFor(1, false));
    board.register();
    const answered = await request(board.port, {
      path: `${base}/api/orchestration/shell`,
      headers: { authorization: "Bearer t" },
    });
    expect(answered.status).toBe(503);
    expect(JSON.parse(answered.body)).toEqual({ code: "worker-offline" });
  });

  it("forwards a WebSocket upgrade with its ticket, byte for byte after the handshake", async () => {
    const worker = await startWorker();
    const board = await startBoard(targetFor(worker.port));
    board.register();
    const socket = NodeNet.connect({ host: "127.0.0.1", port: board.port });
    cleanups.push(() => socket.destroy());
    let received = "";
    const echoed = new Promise<void>((resolve) => {
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1");
        if (received.includes("\r\n\r\n") && received.endsWith("\u0001\u0002ping")) resolve();
      });
    });
    socket.write(
      `GET ${base}/ws?wsTicket=ticket-1 HTTP/1.1\r\nHost: board\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: t3_session=board\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n\u0001\u0002ping`,
    );
    await echoed;
    expect(received.startsWith("HTTP/1.1 101")).toBe(true);
    const [upgrade] = worker.upgrades;
    expect(upgrade?.url).toBe("/ws?wsTicket=ticket-1");
    expect(upgrade?.headers["sec-websocket-key"]).toBe("abc");
    expect(upgrade?.headers.cookie).toBeUndefined();
  });
});

describe("HTTP seam", () => {
  it("leaves everything that isn't T3o's to upstream, and answers 503 before the board is up", async () => {
    const board = await startBoard(targetFor(null));
    expect((await request(board.port, { path: "/api/projects" })).body).toBe("upstream");
    expect((await request(board.port, { path: `${base}/api/orchestration/shell` })).status).toBe(
      503,
    );
    expect(
      (await request(board.port, { path: "/api/t3o/worker-join", method: "POST" })).status,
    ).toBe(503);
    board.register();
    expect((await request(board.port, { path: "/api/t3o/worker-join", method: "POST" })).body).toBe(
      "join",
    );
    expect((await request(board.port, { path: "/api/t3o/workers" })).body).toBe("upstream");
  });

  it("routes by exact path", () => {
    expect(routeOf("/api/t3o/worker-tunnel")).toBe("control");
    expect(routeOf("/api/t3o/worker-tunnel/stream?id=x")).toBe("stream");
    expect(routeOf("/api/t3o/worker-join")).toBe("join");
    expect(routeOf("/api/t3o/workers/w/ws?wsTicket=1")).toBe("proxy");
    expect(routeOf("/api/t3o/worker-tunnelx")).toBeNull();
    expect(routeOf("/ws")).toBeNull();
  });

  it("allows only what a thread view needs", () => {
    expect(isProxyAllowed("GET", "/ws")).toBe(true);
    expect(isProxyAllowed("GET", "/ws/voice")).toBe(true);
    expect(isProxyAllowed("GET", "/api/projects")).toBe(true);
    expect(isProxyAllowed("POST", "/api/projects")).toBe(false);
    expect(isProxyAllowed("POST", "/api/pull-requests/diff")).toBe(true);
    expect(isProxyAllowed("POST", "/api/auth/pairing-token")).toBe(false);
    expect(isProxyAllowed("GET", "/api/auth/bootstrap/x")).toBe(false);
  });
});
