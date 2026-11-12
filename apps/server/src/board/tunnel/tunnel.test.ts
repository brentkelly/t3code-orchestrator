// @effect-diagnostics nodeBuiltinImport:off - the tunnel is real sockets end to end.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import {
  BOARD_WORKER_TUNNEL_PATH,
  BOARD_WORKER_TUNNEL_STREAM_PATH,
  EnvironmentId,
  T3O_TUNNEL_PROTOCOL_VERSION,
  type WorkerTunnelHello,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { joinSockets } from "./lineChannel.ts";
import { NONCE_HEADER, TunnelBoard, type TunnelSessionDecision } from "./tunnelBoard.ts";
import {
  advertisedBoardCandidate,
  openUpgrade,
  redialAfterClose,
  TUNNEL_STABLE_MS,
  TunnelWorker,
  tunnelBackoffMs,
  type WorkerTunnelStatus,
} from "./tunnelWorker.ts";

const WORKER_ID = EnvironmentId.make("env-worker");
const CREDENTIAL = "tunnel-credential";

interface Deferred<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
}
function deferred<A>(): Deferred<A> {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The worker's own loopback T3 server: answers `GET /who` with its name and echoes
    `/echo` bodies, so a request that went through the tunnel proves where it landed. */
async function startLocalServer(name: string) {
  const server = NodeHttp.createServer((request, response) => {
    if (request.url === "/who") {
      response.end(name);
      return;
    }
    if (request.url === "/slow") {
      // Never answers until the client goes: for "legs die with the tunnel".
      return;
    }
    request.pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as NodeNet.AddressInfo).port;
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, port };
}

/** The board: a plain HTTP server whose upgrades go to the tunnel host by path. */
async function startBoard(options: {
  readonly decide?: (
    hello: WorkerTunnelHello,
    probe: () => Promise<string>,
  ) => Promise<TunnelSessionDecision>;
  readonly credentials?: Map<string, string>;
}) {
  const credentials = options.credentials ?? new Map([[CREDENTIAL, WORKER_ID]]);
  const hellos: WorkerTunnelHello[] = [];
  const goodbyes: string[] = [];
  const changes: Array<() => void> = [];
  let board!: TunnelBoard;
  const probe = async () => {
    const endpoint = board.endpoint(WORKER_ID);
    return httpGet(endpoint!.port, "/who");
  };
  board = new TunnelBoard({
    verifyCredential: async (credential) => credentials.get(credential) ?? null,
    onHello: async (_workerId, hello) => {
      hellos.push(hello);
      return options.decide === undefined
        ? { status: "ok", liveBoardSessionIds: ["board-session-1"] }
        : options.decide(hello, probe);
    },
    onGoodbye: (workerId) => goodbyes.push(workerId),
    onChange: () => {
      for (const listener of changes.splice(0)) listener();
    },
  });
  const server = NodeHttp.createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on(
    "upgrade",
    (request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer) => {
      const path = new URL(request.url ?? "/", "http://board").pathname;
      if (path === BOARD_WORKER_TUNNEL_STREAM_PATH) board.handleStream(request, socket, head);
      else if (path === BOARD_WORKER_TUNNEL_PATH) board.handleControl(request, socket, head);
      else socket.destroy();
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as NodeNet.AddressInfo).port;
  cleanups.push(() => {
    board.close();
    server.closeAllConnections();
    server.close();
  });
  const listenerPort = await board.ensureListener(WORKER_ID);
  /** Resolves on the next phase the predicate accepts. */
  const until = async (predicate: () => boolean) => {
    while (!predicate()) {
      const next = deferred<void>();
      changes.push(next.resolve);
      await next.promise;
    }
  };
  return { board, url: `http://127.0.0.1:${port}`, listenerPort, hellos, goodbyes, until };
}

function startWorker(input: {
  readonly boardUrl: string;
  readonly localPort: number;
  readonly credential?: string;
  readonly mint?: () => Promise<string>;
  readonly onStatus?: (status: WorkerTunnelStatus) => void;
  readonly onRevoked?: () => void;
  readonly onReady?: () => void;
  readonly onAddressAdopted?: (url: string) => void;
}) {
  const worker = new TunnelWorker({
    boardUrl: input.boardUrl,
    credential: input.credential ?? CREDENTIAL,
    environmentId: WORKER_ID,
    label: "build-03",
    t3oRelease: "0.0.70",
    gatewayProtocol: 3,
    local: { host: "127.0.0.1", port: input.localPort },
    mintBoardSession: input.mint ?? (async () => "board-session-token"),
    onStatus: input.onStatus,
    onRevoked: input.onRevoked,
    onReady: input.onReady,
    onAddressAdopted: input.onAddressAdopted,
    backoff: { initialMs: 5, maxMs: 20 },
  });
  cleanups.push(() => worker.stop());
  worker.start();
  return worker;
}

function httpGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
  });
}

function waitForStatus(
  states: WorkerTunnelStatus[],
  listeners: Array<() => void>,
  predicate: (status: WorkerTunnelStatus) => boolean,
): Promise<WorkerTunnelStatus> {
  return new Promise((resolve) => {
    const check = () => {
      const match = states.find(predicate);
      if (match !== undefined) resolve(match);
      else listeners.push(check);
    };
    check();
  });
}

function statusLog() {
  const states: WorkerTunnelStatus[] = [];
  const listeners: Array<() => void> = [];
  return {
    states,
    onStatus: (status: WorkerTunnelStatus) => {
      states.push(status);
      for (const listener of listeners.splice(0)) listener();
    },
    when: (predicate: (status: WorkerTunnelStatus) => boolean) =>
      waitForStatus(states, listeners, predicate),
  };
}

describe("worker tunnel", () => {
  it("joins: needs-session, then the board probes through the tunnel before ok", async () => {
    const local = await startLocalServer("worker-loopback");
    const probed: string[] = [];
    const board = await startBoard({
      decide: async (hello, probe) => {
        if (hello.boardSession === undefined) return { status: "needs-session" };
        // Streams open before `ok`: the probe itself goes through the tunnel.
        probed.push(await probe());
        return { status: "ok", liveBoardSessionIds: ["s1"] };
      },
    });
    const log = statusLog();
    const ready = deferred<void>();
    startWorker({
      boardUrl: board.url,
      localPort: local.port,
      onStatus: log.onStatus,
      onReady: () => ready.resolve(),
    });
    await ready.promise;
    expect(board.hellos.map((hello) => hello.boardSession ?? null)).toEqual([
      null,
      "board-session-token",
    ]);
    expect(board.hellos[0]?.tunnelProtocol).toBe(T3O_TUNNEL_PROTOCOL_VERSION);
    expect(probed).toEqual(["worker-loopback"]);
    expect(board.board.phase(WORKER_ID)).toBe("ready");
    expect((await log.when((status) => status.state === "connected")).lastError).toBeNull();
  });

  it("carries concurrent streams, each to the worker's own port", async () => {
    const local = await startLocalServer("worker-loopback");
    const board = await startBoard({});
    const ready = deferred<void>();
    startWorker({ boardUrl: board.url, localPort: local.port, onReady: () => ready.resolve() });
    await ready.promise;
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => httpGet(board.listenerPort, "/who")),
    );
    expect(answers).toEqual(Array.from({ length: 8 }, () => "worker-loopback"));
  });

  it("resets accepted sockets at once while the worker isn't connected", async () => {
    const board = await startBoard({});
    await expect(httpGet(board.listenerPort, "/who")).rejects.toThrow();
  });

  it("refuses an unknown credential, and the worker marks the board revoked", async () => {
    const local = await startLocalServer("worker-loopback");
    const board = await startBoard({});
    const revoked = deferred<void>();
    const log = statusLog();
    startWorker({
      boardUrl: board.url,
      localPort: local.port,
      credential: "forgotten",
      onStatus: log.onStatus,
      onRevoked: () => revoked.resolve(),
    });
    await revoked.promise;
    expect((await log.when((status) => status.state === "revoked")).lastError).toMatch(/revoked/);
  });

  it("retries a 401 that isn't the board's own revocation, such as a gateway's", async () => {
    const local = await startLocalServer("worker-loopback");
    let attempts = 0;
    const second = deferred<void>();
    const front = NodeHttp.createServer();
    front.on("upgrade", (_request: NodeHttp.IncomingMessage, socket: NodeNet.Socket) => {
      attempts += 1;
      if (attempts >= 2) second.resolve();
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      front.closeAllConnections();
      front.close();
    });
    let revoked = false;
    const log = statusLog();
    startWorker({
      boardUrl: `http://127.0.0.1:${(front.address() as NodeNet.AddressInfo).port}`,
      localPort: local.port,
      onStatus: log.onStatus,
      onRevoked: () => (revoked = true),
    });
    await second.promise;
    expect(revoked).toBe(false);
    expect(log.states.some((status) => status.state === "revoked")).toBe(false);
    expect((await log.when((status) => status.state === "offline")).lastError).toMatch(/401/);
  });

  it("mints once per control channel, then backs off on a fresh one", async () => {
    const local = await startLocalServer("worker-loopback");
    const fourth = deferred<void>();
    const board = await startBoard({
      decide: async () => {
        if (board.hellos.length >= 4) fourth.resolve();
        return { status: "needs-session" };
      },
    });
    let mints = 0;
    const worker = startWorker({
      boardUrl: board.url,
      localPort: local.port,
      mint: async () => `board-session-${++mints}`,
    });
    await fourth.promise;
    worker.stop();
    expect(board.hellos.slice(0, 4).map((hello) => hello.boardSession ?? null)).toEqual([
      null,
      "board-session-1",
      null,
      "board-session-2",
    ]);
  });

  it("refuses a hello naming another worker than the credential's", async () => {
    const local = await startLocalServer("worker-loopback");
    const board = await startBoard({ credentials: new Map([[CREDENTIAL, "env-other"]]) });
    await board.board.ensureListener("env-other");
    const revoked = deferred<void>();
    startWorker({ boardUrl: board.url, localPort: local.port, onRevoked: () => revoked.resolve() });
    await revoked.promise;
    expect(board.board.phase("env-other")).toBe("down");
  });

  it("uses each nonce once", async () => {
    const local = await startLocalServer("worker-loopback");
    const board = await startBoard({});
    const ready = deferred<void>();
    startWorker({ boardUrl: board.url, localPort: local.port, onReady: () => ready.resolve() });
    await ready.promise;
    // A stream id nobody dialled, or one already joined, is refused.
    const target = new URL(`${board.url}${BOARD_WORKER_TUNNEL_STREAM_PATH}`);
    target.searchParams.set("id", "never-dialled");
    await expect(
      openUpgrade(target, { Authorization: `Bearer ${CREDENTIAL}`, [NONCE_HEADER]: "x" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("destroys every stream leg when the control channel drops", async () => {
    const local = await startLocalServer("worker-loopback");
    const board = await startBoard({});
    const ready = deferred<void>();
    startWorker({ boardUrl: board.url, localPort: local.port, onReady: () => ready.resolve() });
    await ready.promise;
    const closed = deferred<void>();
    const client = NodeNet.connect({ host: "127.0.0.1", port: board.listenerPort }, () => {
      client.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n");
    });
    client.on("close", () => closed.resolve());
    client.on("error", () => undefined);
    // Once the leg is joined the board counts it; then the tunnel goes.
    await board.until(() => board.board.phase(WORKER_ID) === "ready");
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    board.board.disconnect(WORKER_ID);
    await closed.promise;
  });

  it("a newer tunnel replaces an older one", async () => {
    const local = await startLocalServer("worker-loopback");
    const board = await startBoard({});
    const first = deferred<void>();
    const firstWorker = startWorker({
      boardUrl: board.url,
      localPort: local.port,
      onReady: () => first.resolve(),
    });
    await first.promise;
    const second = deferred<void>();
    startWorker({ boardUrl: board.url, localPort: local.port, onReady: () => second.resolve() });
    await second.promise;
    firstWorker.stop();
    expect(await httpGet(board.listenerPort, "/who")).toBe("worker-loopback");
  });

  it("forwards goodbye to the board", async () => {
    const local = await startLocalServer("worker-loopback");
    const board = await startBoard({});
    const ready = deferred<void>();
    const worker = startWorker({
      boardUrl: board.url,
      localPort: local.port,
      onReady: () => ready.resolve(),
    });
    await ready.promise;
    await worker.goodbye();
    expect(board.goodbyes).toEqual([WORKER_ID]);
  });

  it("adopts a new board address only after a connection to it succeeds", async () => {
    const local = await startLocalServer("worker-loopback");
    const adopted: string[] = [];
    // The board advertises an address that doesn't answer: the worker keeps the old one.
    const deadPort = await new Promise<number>((resolve) => {
      const probe = NodeNet.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as NodeNet.AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });
    let readies = 0;
    const second = deferred<void>();
    const board = await startBoard({
      decide: async () => ({
        status: "ok",
        liveBoardSessionIds: [],
        boardAddress: `http://127.0.0.1:${deadPort}`,
      }),
    });
    const worker = startWorker({
      boardUrl: board.url,
      localPort: local.port,
      onAddressAdopted: (url) => adopted.push(url),
      onReady: () => {
        readies += 1;
        if (readies === 2) second.resolve();
      },
    });
    const firstReady = board.until(() => board.board.phase(WORKER_ID) === "ready");
    await firstReady;
    board.board.disconnect(WORKER_ID);
    await second.promise;
    expect(adopted).toEqual([]);
    expect(worker.currentStatus().boardUrl).toBe(board.url);
  });
});

describe("tunnel backpressure", () => {
  it("a stalled reader pauses the writer instead of buffering without bound", async () => {
    let produced = 0;
    const left = Object.assign(
      new NodeStream.Duplex({
        highWaterMark: 64 * 1024,
        read() {
          produced += 64 * 1024;
          this.push(Buffer.alloc(64 * 1024));
        },
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      { setNoDelay() {}, setKeepAlive() {} },
    );
    // A reader that never takes anything: its first write never completes.
    const right = Object.assign(
      new NodeStream.Duplex({ highWaterMark: 64 * 1024, read() {}, write() {} }),
      { setNoDelay() {}, setKeepAlive() {} },
    );
    const paused = new Promise((resolve) => left.once("pause", resolve));
    joinSockets(left as unknown as NodeNet.Socket, right as unknown as NodeNet.Socket);
    await paused;
    expect(produced).toBeLessThan(1024 * 1024);
  });

  it("backs off with jitter between 1 s and 30 s", () => {
    const bounds = { initialMs: 1_000, maxMs: 30_000 };
    expect(tunnelBackoffMs(0, bounds, () => 0)).toBe(500);
    expect(tunnelBackoffMs(0, bounds, () => 1)).toBe(1_000);
    expect(tunnelBackoffMs(10, bounds, () => 1)).toBe(30_000);
  });

  it("follows an advertised board address only when it passes the clear-text check", () => {
    const current = "https://board.example";
    expect(advertisedBoardCandidate(current, "https://new.example/")).toBe("https://new.example");
    expect(advertisedBoardCandidate(current, "https://board.example/")).toBeNull();
    expect(advertisedBoardCandidate(current, undefined)).toBeNull();
    expect(advertisedBoardCandidate(current, "http://board.example")).toBeNull();
    expect(advertisedBoardCandidate(current, "not a url")).toBeNull();
    expect(advertisedBoardCandidate(current, "http://127.0.0.1:3773")).toBe(
      "http://127.0.0.1:3773",
    );
  });

  it("comes straight back only after a tunnel held; a flapping one keeps backing off", () => {
    expect(redialAfterClose(TUNNEL_STABLE_MS)).toEqual({ delayMs: 250, reset: true });
    // Two machines sharing an id replace each other's tunnel right after it is ready.
    expect(redialAfterClose(100)).toEqual({ reset: false });
    expect(redialAfterClose(null)).toEqual({ reset: false });
  });
});
