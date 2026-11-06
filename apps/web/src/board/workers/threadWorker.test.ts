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
  boardThreadWorker,
  LOCAL_WORKER_LABEL,
  threadWorkerOpensOn,
  threadWorkerRanOn,
  workerThreadAccess,
  workerThreadAccessCopy,
} from "./threadWorker";

const BOARD = EnvironmentId.make("env-board");
const W1 = EnvironmentId.make("env-w1");

const withWorker: BoardWorkersState = {
  ...EMPTY_BOARD_WORKERS_STATE,
  workers: [
    {
      id: W1,
      label: "linux-box",
      url: "http://linux-box:3773",
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
      label: LOCAL_WORKER_LABEL,
      url: null,
      removed: false,
    });
  });

  it("is the named worker, opening in that worker's environment", () => {
    expect(remote.environmentId).toBe(W1);
    expect(remote.label).toBe("linux-box");
    expect(remote.url).toBe("http://linux-box:3773");
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
      workerThreadAccess({ worker: gone, connection: connection({ phase: "connected" }) }),
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
  it("needs no connection for this server's own threads", () => {
    expect(workerThreadAccess({ worker: local, connection: null })).toBe("open");
  });

  it("asks to connect when this device has no connection to the worker", () => {
    const access = workerThreadAccess({ worker: remote, connection: null });
    expect(access).toBe("connect");
    if (access === "open") return;
    const copy = workerThreadAccessCopy(access, remote);
    expect(copy.title).toBe("Connect to worker linux-box to open this thread");
    expect(copy.action).toBe("open-connections");
  });

  it("follows the device's own connection state", () => {
    const access = (patch: Partial<SupervisorConnectionState>) =>
      workerThreadAccess({ worker: remote, connection: connection(patch) });
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
    ).toBe("sign-in");
    expect(
      access({
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({ reason: "configuration", detail: "bad" }),
      }),
    ).toBe("offline");
  });

  it("asks for sign-in in the waiting-on-you colour, with Sign in", () => {
    const copy = workerThreadAccessCopy("sign-in", remote);
    expect(copy.title).toBe("Connection needs sign-in");
    expect(copy.tone).toBe("attention");
    expect(copy.action).toBe("sign-in");
  });
});
