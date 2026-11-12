import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  EMPTY_BOARD_WORKERS_STATE,
  EnvironmentId,
  type BoardWorkersState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardConnectionIsDirect,
  boardThreadWorker,
  isWorkerProxyEntry,
  LOCAL_WORKER_LABEL,
  staleWorkerEnvironmentIds,
  threadWorkerChip,
  threadWorkerOpensOn,
  threadWorkerRanOn,
  workerProxyAddress,
  workerProxyRouteIds,
  workerThreadAccess,
  workerThreadAccessCopy,
  workerThreadMintStep,
} from "./threadWorker";

const BOARD = EnvironmentId.make("env-board");
const W1 = EnvironmentId.make("env-w1");

const withWorker: BoardWorkersState = {
  ...EMPTY_BOARD_WORKERS_STATE,
  workers: [
    {
      id: W1,
      label: "linux-box",
      abbreviation: "LB",
      addedAt: "2026-10-21T10:00:00.000Z",
      status: { state: "online", lastSeenAt: null, t3oVersion: null, protocolVersion: null },
      snapshot: null,
    },
  ],
};

const local = boardThreadWorker({
  workerId: undefined,
  workers: withWorker,
  boardEnvironmentId: BOARD,
});
const remote = boardThreadWorker({ workerId: W1, workers: withWorker, boardEnvironmentId: BOARD });

const connection = (patch: Partial<SupervisorConnectionState>): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  ...patch,
});

describe("the worker a thread lives on", () => {
  it("is this server when the link names none, and opens in the board's environment", () => {
    expect(local).toEqual({
      workerId: "local",
      environmentId: BOARD,
      boardEnvironmentId: BOARD,
      label: LOCAL_WORKER_LABEL,
      abbreviation: "SRV",
      state: null,
      lastSeenAt: null,
      removed: false,
    });
  });

  it("is the named worker, opening in that worker's environment", () => {
    expect(remote.environmentId).toBe(W1);
    expect(remote.label).toBe("linux-box");
    expect(remote.abbreviation).toBe("LB");
    expect(threadWorkerOpensOn(remote)).toBe("Opens on linux-box");
  });

  it("is removed once the board no longer lists it", () => {
    const gone = boardThreadWorker({
      workerId: W1,
      workers: EMPTY_BOARD_WORKERS_STATE,
      boardEnvironmentId: BOARD,
    });
    expect(gone.removed).toBe(true);
    expect(
      workerThreadAccess({
        worker: gone,
        connection: connection({ phase: "connected" }),
        boardDirect: true,
        throughBoard: true,
      }),
    ).toBe("removed");
  });

  it("says where a thread ran only on a board with more than one worker", () => {
    const localOnly = boardThreadWorker({
      workerId: undefined,
      workers: EMPTY_BOARD_WORKERS_STATE,
      boardEnvironmentId: BOARD,
    });
    expect(threadWorkerRanOn(localOnly, EMPTY_BOARD_WORKERS_STATE)).toBeNull();
    expect(threadWorkerRanOn(local, withWorker)).toBe("ran on This server");
    expect(threadWorkerRanOn(remote, withWorker)).toBe("ran on linux-box");
  });
});

describe("opening a thread on a worker", () => {
  const access = (
    patch: Partial<SupervisorConnectionState> | null,
    options: {
      readonly boardDirect?: boolean;
      readonly worker?: typeof remote;
      readonly throughBoard?: boolean | null;
    } = {},
  ) =>
    workerThreadAccess({
      worker: options.worker ?? remote,
      connection: patch === null ? null : connection(patch),
      boardDirect: options.boardDirect ?? true,
      throughBoard: options.throughBoard ?? true,
    });

  it("needs no connection for this server's own threads", () => {
    expect(access(null, { worker: local, boardDirect: false })).toBe("open");
  });

  it("registers through the board when this device has no entry, unless the board is relayed", () => {
    expect(access(null)).toBe("register");
    expect(access(null, { boardDirect: false })).toBe("relayed");
    expect(workerThreadAccessCopy("relayed", remote).title).toBe(
      "Open this thread from a direct connection to the board",
    );
  });

  it("waits for an offline worker in amber, whatever this device's connection", () => {
    const offline = { ...remote, state: "offline" as const };
    expect(access({ phase: "connected" }, { worker: offline })).toBe("worker-offline");
    const copy = workerThreadAccessCopy("worker-offline", offline);
    expect(copy.title).toBe("Messages resume when linux-box reconnects");
    expect(copy.tone).toBe("warning");
  });

  it("follows the device's own connection state, re-minting a refused session", () => {
    expect(access({ phase: "connected" })).toBe("open");
    expect(access({ phase: "connecting", attempt: 1 })).toBe("opening");
    expect(access({ phase: "backoff", attempt: 1 })).toBe("opening");
    expect(access({ phase: "backoff", attempt: 5 })).toBe("offline");
    expect(access({ phase: "offline" })).toBe("offline");
    expect(
      access({
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({ reason: "authentication", detail: "401" }),
      }),
    ).toBe("reauthorize");
    expect(
      access({
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({ reason: "configuration", detail: "bad" }),
      }),
    ).toBe("offline");
  });

  it("replaces an entry that isn't the board's proxy once it can't connect", () => {
    const own = { throughBoard: false };
    // The user's own direct pairing still works: it's used as is.
    expect(access({ phase: "connected" }, own)).toBe("open");
    expect(access({ phase: "backoff", attempt: 1 }, own)).toBe("opening");
    expect(access({ phase: "backoff", attempt: 5 }, own)).toBe("register");
    expect(access({ phase: "offline" }, own)).toBe("register");
    expect(access({ phase: "offline" }, { ...own, boardDirect: false })).toBe("offline");
    // Not yet tried, or the entry's address not yet resolved: never minted over.
    expect(access({ phase: "available" }, own)).toBe("offline");
    const unknown = { throughBoard: null };
    expect(access({ phase: "available" }, unknown)).toBe("offline");
    expect(access({ phase: "offline" }, unknown)).toBe("offline");
    expect(access({ phase: "backoff", attempt: 5 }, unknown)).toBe("offline");
  });

  it("knows the board's proxy route for a worker among an entry's saved routes", () => {
    const board = "https://board.example/";
    const proxied = "https://board.example/api/t3o/workers/env-w1/";
    const own = "http://100.64.0.2:3773/";
    const check = (entry: ReadonlyArray<string> | null, boardUrl: string | null = board) =>
      isWorkerProxyEntry({ workerId: W1, boardHttpBaseUrl: boardUrl, entryHttpBaseUrls: entry });
    expect(check([proxied])).toBe(true);
    expect(check([own, proxied])).toBe(true);
    expect(check([own])).toBe(false);
    expect(check(["https://old-board.example/api/t3o/workers/env-w1/"])).toBe(false);
    expect(check([proxied], null)).toBeNull();
    expect(check(null)).toBeNull();
  });

  it("forgets only the board's proxy routes, never the user's own pairing", () => {
    const routes = [
      { id: "own", httpBaseUrl: "http://100.64.0.2:3773/" },
      { id: "proxy", httpBaseUrl: "https://board.example/api/t3o/workers/env-w1/" },
      { id: "old-proxy", httpBaseUrl: "https://old.example/t3/api/t3o/workers/env-w1" },
      { id: "other-worker", httpBaseUrl: "https://board.example/api/t3o/workers/env-w2/" },
      { id: "ssh", httpBaseUrl: null },
    ];
    expect(workerProxyRouteIds(routes, W1)).toEqual(["proxy", "old-proxy"]);
  });
});

describe("the thread header's worker chip", () => {
  it("says where the thread runs or ran, by abbreviation, and amber while offline", () => {
    expect(threadWorkerChip({ worker: remote, running: true, localOnly: false })).toEqual({
      text: "Running on LB",
      tooltip: "linux-box",
      warning: false,
    });
    expect(threadWorkerChip({ worker: remote, running: false, localOnly: false })?.text).toBe(
      "Ran on LB",
    );
    expect(
      threadWorkerChip({
        worker: { ...remote, state: "offline" },
        running: false,
        localOnly: false,
      }),
    ).toMatchObject({ text: "linux-box offline", warning: true });
    expect(threadWorkerChip({ worker: local, running: true, localOnly: true })).toBeNull();
    expect(threadWorkerChip({ worker: local, running: true, localOnly: false })?.text).toBe(
      "Running on SRV",
    );
  });
});

describe("reaching a worker through the board", () => {
  it("puts the proxy path under the board's own base, for http and ws", () => {
    expect(workerProxyAddress("https://board.example/", "/api/t3o/workers/env-w1/")).toEqual({
      httpBaseUrl: "https://board.example/api/t3o/workers/env-w1/",
      wsBaseUrl: "wss://board.example/api/t3o/workers/env-w1/",
    });
    expect(
      workerProxyAddress("http://10.0.0.2:3773/t3/?x=1", "api/t3o/workers/env-w1").httpBaseUrl,
    ).toBe("http://10.0.0.2:3773/t3/api/t3o/workers/env-w1/");
  });

  it("counts only a plain http(s) board connection as direct", () => {
    const base = {
      httpBaseUrl: "https://board.example/",
      httpAuthorization: null,
      target: { _tag: "PrimaryConnectionTarget" },
    } as unknown as Parameters<typeof boardConnectionIsDirect>[0];
    expect(boardConnectionIsDirect(base)).toBe(true);
    expect(boardConnectionIsDirect(null)).toBe(false);
    expect(
      boardConnectionIsDirect({
        ...base!,
        httpAuthorization: { _tag: "Dpop", accessToken: "a", expiresAtEpochMs: 0 },
      }),
    ).toBe(false);
    expect(
      boardConnectionIsDirect({
        ...base!,
        target: { _tag: "SshConnectionTarget" },
      } as unknown as Parameters<typeof boardConnectionIsDirect>[0]),
    ).toBe(false);
  });
});

describe("a board's tagged worker environments", () => {
  const tags = {
    "env-w1": { boardEnvironmentId: "env-board", workerId: "env-w1" },
    "env-w2": { boardEnvironmentId: "env-board", workerId: "env-w2" },
    "env-x1": { boardEnvironmentId: "env-other-board", workerId: "env-x1" },
  };

  it.each([
    ["a removed worker's", ["env-w1"], ["env-w2"]],
    ["none while every worker is listed", ["env-w1", "env-w2"], []],
    ["every one when the board itself is gone", null, ["env-w1", "env-w2"]],
  ] as const)("are stale: %s", (_name, workerIds, expected) => {
    expect(staleWorkerEnvironmentIds(tags, { boardEnvironmentId: "env-board", workerIds })).toEqual(
      expected,
    );
  });
});

describe("the thread gate's mint", () => {
  it.each([
    ["open", [], false, { kind: "reset" }],
    ["opening", [], false, { kind: "none" }],
    ["register", [], false, { kind: "mint", reason: "register" }],
    ["reauthorize", ["register"], false, { kind: "mint", reason: "reauthorize" }],
    ["reauthorize", ["reauthorize"], true, { kind: "none" }],
    ["reauthorize", ["reauthorize"], false, { kind: "refused", reason: "reauthorize" }],
  ] as const)("on %s after %j (minting %s) is %j", (access, attempted, minting, expected) => {
    expect(workerThreadMintStep({ access, attempted: new Set(attempted), minting })).toEqual(
      expected,
    );
  });
});
