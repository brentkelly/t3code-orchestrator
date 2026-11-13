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

/** A `config set` value, or why it can't be one. */
export type WorkerConfigParse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

const positiveNumber =
  (what: string) =>
  (raw: string): WorkerConfigParse => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? { ok: true, value }
      : { ok: false, message: `${what} must be a number above 0.` };
  };

const positiveInt =
  (what: string) =>
  (raw: string): WorkerConfigParse => {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0
      ? { ok: true, value }
      : { ok: false, message: `${what} must be a whole number above 0.` };
  };

/**
 * Every `config` key (T3O-86), with what it does, for `config --help` and validation. A key
 * with `prefix` names a family (`providerCaps.<providerInstanceId>`). Applied live.
 */
export const WORKER_CONFIG_KEYS: ReadonlyArray<{
  readonly key: string;
  readonly prefix?: string;
  readonly description: string;
  readonly parse: (raw: string) => WorkerConfigParse;
}> = [
  {
    key: "capacity.cpuCores",
    description: "Cores this worker offers its boards. Default: every detected core.",
    parse: positiveNumber("capacity.cpuCores"),
  },
  {
    key: "capacity.ramGiB",
    description:
      "GiB of RAM this worker offers. Default: the agent slice's memory.high minus 2 GiB, else total minus 8 GiB (at least half).",
    parse: positiveNumber("capacity.ramGiB"),
  },
  {
    key: "capacity.diskGB",
    description:
      "GB of disk for card worktrees. Default: 90% of the free space on the worktree volume when first set, plus what board worktrees already use.",
    parse: positiveNumber("capacity.diskGB"),
  },
  {
    key: "maxAgents",
    description:
      "Most board-started threads running a turn at once, across every board. Default: no limit.",
    parse: positiveInt("maxAgents"),
  },
  {
    key: "providerCaps.<providerInstanceId>",
    prefix: "providerCaps.",
    description: "Most board-started threads running at once on one provider instance.",
    parse: positiveInt("A provider cap"),
  },
  {
    key: "quotaThresholdPercent",
    description:
      "Stop taking new cards for a provider once its session or weekly window is at this percent. Default: 95.",
    parse: (raw) => {
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 && value <= 100
        ? { ok: true, value }
        : { ok: false, message: "quotaThresholdPercent must be between 1 and 100." };
    },
  },
];

/** The config entry a key belongs to, or undefined for an unknown key. */
export function findWorkerConfigKey(key: string) {
  return WORKER_CONFIG_KEYS.find((entry) =>
    entry.prefix === undefined
      ? entry.key === key
      : key.startsWith(entry.prefix) && key.length > entry.prefix.length,
  );
}

export const DEFAULT_QUOTA_THRESHOLD_PERCENT = 95;

/** The capacity settings `worker.json` declares; absent keys fall to the machine defaults. */
export interface WorkerCapacitySettings {
  readonly cpuCores: number | null;
  readonly ramGiB: number | null;
  readonly diskGB: number | null;
  readonly maxAgents: number | null;
  readonly providerCaps: Readonly<Record<string, number>>;
  readonly quotaThresholdPercent: number;
}

export function resolveWorkerCapacitySettings(
  config: Readonly<Record<string, unknown>>,
): WorkerCapacitySettings {
  const read = (key: string, integer = false): number | null => {
    const value = config[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? integer
        ? Math.floor(value)
        : value
      : null;
  };
  const providerCaps: Record<string, number> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith("providerCaps.") || key.length === "providerCaps.".length) continue;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      providerCaps[key.slice("providerCaps.".length)] = value;
    }
  }
  const threshold = read("quotaThresholdPercent");
  return {
    cpuCores: read("capacity.cpuCores"),
    ramGiB: read("capacity.ramGiB"),
    diskGB: read("capacity.diskGB"),
    maxAgents: read("maxAgents", true),
    providerCaps,
    quotaThresholdPercent:
      threshold === null ? DEFAULT_QUOTA_THRESHOLD_PERCENT : Math.min(100, threshold),
  };
}

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

const StatusProfile = Schema.Struct({
  cpuCores: Schema.Number,
  ramGiB: Schema.Number,
  diskGB: Schema.Number,
});

/** The capacity section `t3o-worker status` prints (T3O-86). */
export const WorkerCapacityStatus = Schema.Struct({
  updatedAt: Schema.String,
  declared: StatusProfile,
  held: StatusProfile,
  headroom: StatusProfile,
  heldByBoard: Schema.Array(
    Schema.Struct({ boardEnvironmentId: Schema.String, held: StatusProfile }),
  ),
  /** Board worktrees no board owns (a legacy marker no board listed), and worktrees of
      boards this worker no longer serves, with their size. */
  unowned: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sizeGB: Schema.NullOr(Schema.Number),
      boardEnvironmentId: Schema.NullOr(Schema.String),
    }),
  ),
});
export type WorkerCapacityStatus = typeof WorkerCapacityStatus.Type;

export const WorkerStatusFile = Schema.Struct({
  updatedAt: Schema.String,
  pid: Schema.Number,
  boards: Schema.Array(WorkerBoardStatus),
  capacity: Schema.optionalKey(WorkerCapacityStatus),
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

/** A `worker.json` that exists but can't be read as one: never "no boards". */
export class WorkerFileInvalidError extends Error {
  constructor(path: string, reason: string) {
    super(`${path} can't be read (${reason}). Fix or remove it; it was left as it is.`);
  }
}

/**
 * The worker file, or the empty one when it is missing. Throws `WorkerFileInvalidError`
 * when it exists but is unreadable or invalid, so nobody reads it as "this worker serves
 * no boards" and closes or overwrites the boards it lists.
 */
export function readWorkerFile(home: string): WorkerFile {
  const path = workerFilePath(home);
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return EMPTY_WORKER_FILE;
    throw new WorkerFileInvalidError(path, error instanceof Error ? error.message : String(error));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WorkerFileInvalidError(path, "not JSON");
  }
  const exit = decodeWorkerFile(raw);
  if (exit._tag !== "Success") throw new WorkerFileInvalidError(path, "not a worker file");
  return exit.value;
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
  host === "localhost" ||
  host === "::1" ||
  host === "[::1]" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

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
