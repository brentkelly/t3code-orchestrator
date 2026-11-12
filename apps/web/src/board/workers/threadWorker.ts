/**
 * The worker a card's thread lives on, and whether this client can open it
 * there. A worker's threads open through the board: the board proxies the
 * worker and mints this client a session there (`board.workers.threadAccess`).
 * States come from client-runtime's connection state.
 */
import type {
  PreparedConnection,
  SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  BOARD_LOCAL_WORKER_ABBREVIATION,
  BOARD_LOCAL_WORKER_ID,
  boardWorkerProxyPath,
  isLocalOnlyBoardWorkers,
  type BoardWorkerConnectionState,
  type BoardWorkerId,
  type BoardWorkersState,
  type EnvironmentId,
} from "@t3tools/contracts";

import { clockTime } from "./workerCopy";

/** The built-in worker's name: the board server's own machine. */
export const LOCAL_WORKER_LABEL = "This server";

export interface BoardThreadWorker {
  readonly workerId: BoardWorkerId;
  /** The environment the thread opens in: the worker's, or the board's own. */
  readonly environmentId: EnvironmentId;
  /** The board's environment, which proxies the worker. */
  readonly boardEnvironmentId: EnvironmentId;
  readonly label: string;
  /** The short name for tight places; null for a worker that never had one. */
  readonly abbreviation: string | null;
  /** The board's connection to the worker; null for this server. */
  readonly state: BoardWorkerConnectionState | null;
  readonly lastSeenAt: string | null;
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
      boardEnvironmentId: input.boardEnvironmentId,
      label: LOCAL_WORKER_LABEL,
      abbreviation: BOARD_LOCAL_WORKER_ABBREVIATION,
      state: null,
      lastSeenAt: null,
      removed: false,
    };
  }
  const registered = input.workers.workers.find((worker) => worker.id === input.workerId);
  return {
    workerId: input.workerId,
    environmentId: input.workerId,
    boardEnvironmentId: input.boardEnvironmentId,
    label: registered?.label ?? input.workerId,
    abbreviation: registered?.abbreviation ?? null,
    state: registered?.status.state ?? null,
    lastSeenAt: registered?.status.lastSeenAt ?? null,
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
 * Whether this client can open a thread on `worker` now. `register` and `reauthorize` have the
 * gate mint access through the board; `worker-offline` means the board can't reach the worker;
 * `relayed` means the board connection (relay or SSH) can't carry its proxy.
 */
export type WorkerThreadAccess =
  | "open"
  | "register"
  | "reauthorize"
  | "opening"
  | "offline"
  | "worker-offline"
  | "relayed"
  | "removed";

export function workerThreadAccess(input: {
  readonly worker: BoardThreadWorker;
  /** The client's connection to the worker's environment, or null when it has none. */
  readonly connection: SupervisorConnectionState | null;
  /** The client reaches the board over plain http(s), so the board's proxy path works. */
  readonly boardDirect: boolean;
  /** The client's entry is at this board's proxy address, not a pairing of its own or an
      address the board was reached on before. */
  readonly throughBoard: boolean;
}): WorkerThreadAccess {
  const { worker, connection } = input;
  if (worker.workerId === BOARD_LOCAL_WORKER_ID) return "open";
  if (worker.removed) return "removed";
  if (worker.state === "offline") return "worker-offline";
  if (connection === null) return input.boardDirect ? "register" : "relayed";
  // An entry that isn't the board's proxy and can't connect is replaced by one that is.
  const unreachable = !input.throughBoard && input.boardDirect ? "register" : "offline";
  switch (connection.phase) {
    case "connected":
      return "open";
    case "connecting":
      return "opening";
    case "backoff":
      return connection.attempt <= 2 ? "opening" : unreachable;
    case "blocked":
      return connection.lastFailure?.reason === "authentication" ? "reauthorize" : unreachable;
    case "available":
    case "offline":
      return unreachable;
  }
}

/** Whether a worker environment's registered address is this board's proxy for it. */
export function isWorkerProxyEntry(input: {
  readonly workerId: string;
  readonly boardHttpBaseUrl: string | null;
  readonly entryHttpBaseUrl: string | null;
}): boolean {
  if (input.boardHttpBaseUrl === null || input.entryHttpBaseUrl === null) return false;
  try {
    const expected = workerProxyAddress(
      input.boardHttpBaseUrl,
      boardWorkerProxyPath(input.workerId),
    ).httpBaseUrl;
    return new URL(input.entryHttpBaseUrl).toString() === expected;
  } catch {
    return false;
  }
}

export interface WorkerThreadAccessCopy {
  readonly title: string;
  readonly detail: string;
  /** `warning` is amber: blocked until something changes (status-colours.md). */
  readonly tone: "muted" | "warning";
}

/** What the thread pane says instead of the chat. `register` and `reauthorize` read as opening. */
export function workerThreadAccessCopy(
  access: Exclude<WorkerThreadAccess, "open">,
  worker: BoardThreadWorker,
): WorkerThreadAccessCopy {
  switch (access) {
    case "register":
    case "reauthorize":
    case "opening":
      return {
        title: "Opening…",
        detail: `Connecting to ${worker.label} through the board.`,
        tone: "muted",
      };
    case "offline":
      return {
        title: "Can't reach this thread",
        detail: `${worker.label}'s threads can't be reached through the board from this device right now.`,
        tone: "muted",
      };
    case "worker-offline":
      return {
        title: `Messages resume when ${worker.label} reconnects`,
        detail: `${worker.label} is offline, so its threads can't be opened until it's back.`,
        tone: "warning",
      };
    case "relayed":
      return {
        title: "Open this thread from a direct connection to the board",
        detail: `This device reaches the board through a relay, which can't carry ${worker.label}'s threads. Connect to the board's address directly to open them.`,
        tone: "muted",
      };
    case "removed":
      return {
        title: "Removed",
        detail: `${worker.label} is no longer one of this board's workers. Its threads stay on that machine.`,
        tone: "muted",
      };
  }
}

/** The thread header's worker chip (prototype 6.4); null for this server on a local-only board. */
export function threadWorkerChip(input: {
  readonly worker: BoardThreadWorker;
  readonly running: boolean;
  readonly localOnly: boolean;
}): { readonly text: string; readonly tooltip: string; readonly warning: boolean } | null {
  const { worker } = input;
  if (worker.workerId === BOARD_LOCAL_WORKER_ID && input.localOnly) return null;
  const short = worker.abbreviation ?? worker.label;
  if (worker.state === "offline") {
    return {
      text:
        worker.lastSeenAt === null
          ? `${worker.label} offline`
          : `${worker.label} offline · transcript up to ${clockTime(worker.lastSeenAt)}`,
      tooltip: worker.label,
      warning: true,
    };
  }
  return {
    text: input.running ? `Running on ${short}` : `Ran on ${short}`,
    tooltip: worker.label,
    warning: false,
  };
}

/**
 * Whether the board's proxy path works over this client's board connection:
 * plain http(s) to the board itself. A relay (DPoP) or SSH tunnel can't carry it.
 */
export function boardConnectionIsDirect(
  prepared: Pick<PreparedConnection, "httpBaseUrl" | "httpAuthorization" | "target"> | null,
): boolean {
  if (prepared === null) return false;
  if (
    prepared.target._tag !== "PrimaryConnectionTarget" &&
    prepared.target._tag !== "BearerConnectionTarget"
  ) {
    return false;
  }
  if (prepared.httpAuthorization?._tag === "Dpop") return false;
  try {
    const protocol = new URL(prepared.httpBaseUrl).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The worker's proxied address: `path` under the board's own base URL, http and ws. */
export function workerProxyAddress(
  boardHttpBaseUrl: string,
  path: string,
): { readonly httpBaseUrl: string; readonly wsBaseUrl: string } {
  const url = new URL(boardHttpBaseUrl);
  const base = url.pathname.replace(/\/+$/, "");
  const suffix = path.replace(/^\/*/, "/").replace(/\/*$/, "/");
  url.pathname = `${base}${suffix}`;
  url.search = "";
  url.hash = "";
  const ws = new URL(url);
  ws.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { httpBaseUrl: url.toString(), wsBaseUrl: ws.toString() };
}
