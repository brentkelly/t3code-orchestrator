/**
 * T3o (T3O-63, D9; prototype 7.1–7.3): the worker a card's thread lives on,
 * and whether this client can open it there.
 *
 * A thread link names its worker's environment id. The board itself is fully
 * usable without a connection to that worker; only opening the thread needs
 * one, so everything here is about that one action. The connection states
 * come from client-runtime's own environment connection state, never a second
 * notion of "online".
 */
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import {
  BOARD_LOCAL_WORKER_ID,
  isLocalOnlyBoardWorkers,
  type BoardWorkerId,
  type BoardWorkersState,
  type EnvironmentId,
} from "@t3tools/contracts";

/** The built-in worker's name: the board server's own machine. */
export const LOCAL_WORKER_LABEL = "This server";

export interface BoardThreadWorker {
  readonly workerId: BoardWorkerId;
  /** The environment the thread opens in: the worker's, or the board's own. */
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The worker's address, for Settings → Connections; null for this server. */
  readonly url: string | null;
  /** No longer one of the board's workers. */
  readonly removed: boolean;
}

/** The worker a thread link names. */
export function boardThreadWorker(input: {
  readonly workerId: EnvironmentId | undefined;
  readonly workers: BoardWorkersState;
  readonly boardEnvironmentId: EnvironmentId;
}): BoardThreadWorker {
  if (input.workerId === undefined) {
    return {
      workerId: BOARD_LOCAL_WORKER_ID,
      environmentId: input.boardEnvironmentId,
      label: LOCAL_WORKER_LABEL,
      url: null,
      removed: false,
    };
  }
  const registered = input.workers.workers.find((worker) => worker.id === input.workerId);
  return {
    workerId: input.workerId,
    environmentId: input.workerId,
    label: registered?.label ?? input.workerId,
    url: registered?.url ?? null,
    removed: registered === undefined,
  };
}

/** "ran on This server" — said only on a board with more than one worker,
    where it is news. */
export function threadWorkerRanOn(
  worker: BoardThreadWorker,
  workers: BoardWorkersState,
): string | null {
  return isLocalOnlyBoardWorkers(workers) && worker.workerId === BOARD_LOCAL_WORKER_ID
    ? null
    : `ran on ${worker.label}`;
}

/** The hover on a thread row. */
export function threadWorkerOpensOn(worker: BoardThreadWorker): string {
  return `Opens on ${worker.label}`;
}

/**
 * Whether this client can open a thread on `worker` now (7.2/7.3).
 *
 * - `open` — this server, or a worker this client is connected to;
 * - `connect` — this client has no connection to the worker at all;
 * - `opening` — connecting for the first time, or a retry still early;
 * - `offline` — the connection is down;
 * - `removed` — the worker is no longer on the board;
 * - `sign-in` — the worker refused this client's session.
 */
export type WorkerThreadAccess = "open" | "connect" | "opening" | "offline" | "removed" | "sign-in";

export function workerThreadAccess(input: {
  readonly worker: BoardThreadWorker;
  /** The client's connection to the worker's environment, or null when it
      has none (not in this client's Connections). */
  readonly connection: SupervisorConnectionState | null;
}): WorkerThreadAccess {
  const { worker, connection } = input;
  if (worker.workerId === BOARD_LOCAL_WORKER_ID) return "open";
  if (worker.removed) return "removed";
  if (connection === null) return "connect";
  switch (connection.phase) {
    case "connected":
      return "open";
    case "connecting":
      return "opening";
    case "backoff":
      return connection.attempt <= 2 ? "opening" : "offline";
    case "blocked":
      return connection.lastFailure?.reason === "authentication" ? "sign-in" : "offline";
    case "available":
    case "offline":
      return "offline";
  }
}

export interface WorkerThreadAccessCopy {
  readonly title: string;
  readonly detail: string;
  /** `attention` is violet: waiting on the human (status-colours.md). */
  readonly tone: "muted" | "attention";
  /** The one action, or null when there is nothing to do but wait. */
  readonly action: "open-connections" | "sign-in" | null;
}

/** What the thread pane says instead of the chat (7.2/7.3). */
export function workerThreadAccessCopy(
  access: Exclude<WorkerThreadAccess, "open">,
  worker: BoardThreadWorker,
): WorkerThreadAccessCopy {
  switch (access) {
    case "connect":
      return {
        title: `Connect to worker ${worker.label} to open this thread`,
        detail:
          "This thread runs on another machine. Add it under Connections on this device; the board works without it.",
        tone: "muted",
        action: "open-connections",
      };
    case "opening":
      return {
        title: "Opening…",
        detail: `Connecting to ${worker.label}.`,
        tone: "muted",
        action: null,
      };
    case "offline":
      return {
        title: "Offline",
        detail: `${worker.label} can't be reached from this device right now.`,
        tone: "muted",
        action: null,
      };
    case "removed":
      return {
        title: "Removed",
        detail: `${worker.label} is no longer one of this board's workers. Its threads stay on that machine.`,
        tone: "muted",
        action: null,
      };
    case "sign-in":
      return {
        title: "Connection needs sign-in",
        detail: `${worker.label} no longer accepts this device's session.`,
        tone: "attention",
        action: "sign-in",
      };
  }
}
