// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - plain Node sockets and files: a byte pipe below Effect, also used by the CLI.
/**
 * `<T3 home>/worker.json`: the boards this server works for and the worker's own
 * config, and `worker-status.json` beside it, which the running server writes and
 * `t3o-worker status` reads. The CLI writes `worker.json`; the server watches it.
 * Plain `node:fs` so the CLI can use it without the server's layers. Writes are atomic.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export const WORKER_FILE_NAME = "worker.json";
const WORKER_STATUS_FILE_NAME = "worker-status.json";

/** The secret holding a board's tunnel credential, in `ServerSecretStore`. */
export const tunnelCredentialSecretName = (boardEnvironmentId: string): string =>
  `t3o-board-tunnel-${boardEnvironmentId}`;

export const WorkerBoardEntry = Schema.Struct({
  boardEnvironmentId: Schema.String,
  /** The address in use: the one joined on, or one the board later announced. */
  boardUrl: Schema.String,
  boardLabel: Schema.String,
  /** The last address that worked before `boardUrl` was adopted. */
  previousBoardUrl: Schema.optionalKey(Schema.String),
  joinedAt: Schema.String,
});
export type WorkerBoardEntry = typeof WorkerBoardEntry.Type;

/**
 * The worker's own settings, edited with `t3o-worker config`. Empty here; T3O-71 adds
 * capacity. Each key carries a description so `config --help` can list it.
 */
export const WorkerConfig = Schema.Struct({});
export type WorkerConfig = typeof WorkerConfig.Type;

/** Every `config` key, with what it does, for `config --help` and validation. */
export const WORKER_CONFIG_KEYS: ReadonlyArray<{
  readonly key: string;
  readonly description: string;
  readonly parse: (raw: string) => unknown;
}> = [];

export const WorkerFile = Schema.Struct({
  boards: Schema.Array(WorkerBoardEntry),
  config: Schema.Record(Schema.String, Schema.Unknown),
});
export type WorkerFile = typeof WorkerFile.Type;

const EMPTY_WORKER_FILE: WorkerFile = { boards: [], config: {} };

export const WorkerBoardStatus = Schema.Struct({
  boardEnvironmentId: Schema.String,
  boardLabel: Schema.String,
  boardUrl: Schema.String,
  state: Schema.Literals(["connecting", "connected", "offline", "revoked", "needs-update"]),
  lastConnectedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export type WorkerBoardStatus = typeof WorkerBoardStatus.Type;

export const WorkerStatusFile = Schema.Struct({
  updatedAt: Schema.String,
  pid: Schema.Number,
  boards: Schema.Array(WorkerBoardStatus),
});
export type WorkerStatusFile = typeof WorkerStatusFile.Type;

const decodeWorkerFile = Schema.decodeUnknownExit(WorkerFile);
const decodeStatusFile = Schema.decodeUnknownExit(WorkerStatusFile);

export const workerFilePath = (home: string) => NodePath.join(home, WORKER_FILE_NAME);
const workerStatusPath = (home: string) => NodePath.join(home, WORKER_STATUS_FILE_NAME);

function readJson(path: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The worker file, or the empty one when it is missing or unreadable. */
export function readWorkerFile(home: string): WorkerFile {
  const raw = readJson(workerFilePath(home));
  if (raw === undefined) return EMPTY_WORKER_FILE;
  const exit = decodeWorkerFile(raw);
  return exit._tag === "Success" ? exit.value : EMPTY_WORKER_FILE;
}

export function readWorkerStatus(home: string): WorkerStatusFile | null {
  const raw = readJson(workerStatusPath(home));
  if (raw === undefined) return null;
  const exit = decodeStatusFile(raw);
  return exit._tag === "Success" ? exit.value : null;
}

/** Write via a temporary file and rename, so a reader never sees half a file. */
function writeJsonAtomic(path: string, value: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, path);
}

export function writeWorkerFile(home: string, file: WorkerFile): void {
  writeJsonAtomic(workerFilePath(home), file);
}

export function writeWorkerStatus(home: string, status: WorkerStatusFile): void {
  writeJsonAtomic(workerStatusPath(home), status);
}

/** The worker file with one board added or replaced, keyed by its environment id. */
export function upsertWorkerBoard(file: WorkerFile, entry: WorkerBoardEntry): WorkerFile {
  return {
    ...file,
    boards: [
      ...file.boards.filter((board) => board.boardEnvironmentId !== entry.boardEnvironmentId),
      entry,
    ],
  };
}

export function removeWorkerBoard(file: WorkerFile, boardEnvironmentId: string): WorkerFile {
  return {
    ...file,
    boards: file.boards.filter((board) => board.boardEnvironmentId !== boardEnvironmentId),
  };
}

/** A board named by its environment id, its label or its address. */
export function findWorkerBoard(file: WorkerFile, name: string): WorkerBoardEntry | null {
  const trimmed = name.trim().replace(/\/+$/, "");
  return (
    file.boards.find(
      (board) =>
        board.boardEnvironmentId === trimmed ||
        board.boardLabel === trimmed ||
        board.boardUrl.replace(/\/+$/, "") === trimmed,
    ) ?? null
  );
}

const isLoopbackHost = (host: string) =>
  host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

/** 100.64.0.0/10, the tailnet's address range. */
const isTailscaleAddress = (host: string) => {
  const match = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (match === null) return false;
  const second = Number(match[1]);
  return second >= 64 && second <= 127;
};

/**
 * Whether the worker may use this board address. Plain http carries the tunnel credential
 * and every agent's traffic in clear text, so it's allowed only on loopback and Tailscale
 * (already encrypted), unless `--insecure` says otherwise.
 */
export function boardUrlRefusal(rawUrl: string, insecure: boolean): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `"${rawUrl}" isn't a URL. Use the address in the board's join command, e.g. https://board.example.`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return `Board addresses start with https:// (got ${url.protocol}).`;
  if (insecure) return null;
  const host = url.hostname;
  if (isLoopbackHost(host) || isTailscaleAddress(host) || host.endsWith(".ts.net")) return null;
  return `Refusing http://${url.host}: the tunnel credential and all agent traffic would cross the network unencrypted. Use the board's https:// address, a Tailscale address, or pass --insecure.`;
}

/** The loopback form of this server's own bind host: where tunnel streams go. */
export function localTunnelTarget(
  bindHost: string | undefined,
  port: number,
): { readonly host: string; readonly port: number } {
  if (bindHost === undefined || bindHost === "" || bindHost === "0.0.0.0") {
    return { host: "127.0.0.1", port };
  }
  if (bindHost === "::" || bindHost === "[::]") return { host: "::1", port };
  return { host: bindHost.replace(/^\[|\]$/g, ""), port };
}
