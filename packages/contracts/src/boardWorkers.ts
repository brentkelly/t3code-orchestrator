/**
 * One central server hosts the board and dials each worker as a paired client.
 * Imports only leaf modules, so `board.ts` can import it without a cycle.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RepositoryIdentity, repositoryGroupingKeyOf } from "./environment.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// ── Protocol ───────────────────────────────────────────────────────────

/**
 * Bump when the central server starts relying on a `boardWorker.*` call an older worker
 * lacks. 2 added `boardWorker.git.closePullRequest`, best-effort. 3 sends `usage-recorded`
 * signals when asked (`BOARD_WORKER_USAGE_PROTOCOL`). 4 is worker-owned capacity (T3O-86):
 * claims, `syncCards`, the capacity stream, and provisions that carry a claim.
 */
export const BOARD_WORKER_PROTOCOL_VERSION = 4;

/** The first protocol whose workers report usage; an older one leaves its cards partial. */
export const BOARD_WORKER_USAGE_PROTOCOL = 3;

/** The oldest protocol a worker may speak and still be used: capacity needs 4 on both ends. */
export const BOARD_WORKER_PROTOCOL_FLOOR = 4;

/**
 * The T3o release that first spoke `BOARD_WORKER_PROTOCOL_FLOOR`, so the UI can
 * say "Needs T3o 0.1.8.2 or newer" rather than a protocol number nobody knows.
 * Raise it together with the floor.
 */
export const BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION = "0.1.8.2";

// ── Registry ───────────────────────────────────────────────────────────

/** The central server's own machine: always a worker, never removable. */
export const BOARD_LOCAL_WORKER_ID = "local" as const;

/**
 * A worker's id. A registered worker's id is its `environmentId`, read from
 * its `/.well-known/t3/environment`, so it survives restarts and re-pairs and
 * a re-added server reattaches its cards. The central server itself is
 * `local`.
 */
export const BoardWorkerId = Schema.Union([Schema.Literal(BOARD_LOCAL_WORKER_ID), EnvironmentId]);
export type BoardWorkerId = typeof BoardWorkerId.Type;

const BOARD_WORKER_LABEL_MAX_LENGTH = 64;
export const BoardWorkerLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BOARD_WORKER_LABEL_MAX_LENGTH),
);

/**
 * A worker's short name on the board: 1–3 uppercase letters or digits, unique
 * per board. `SRV` is the board server's own.
 */
export const BOARD_LOCAL_WORKER_ABBREVIATION = "SRV";
export const BoardWorkerAbbreviation = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{1,3}$/));
export type BoardWorkerAbbreviation = typeof BoardWorkerAbbreviation.Type;

/** A registered worker. The registry lives in the board read model. */
export const BoardWorker = Schema.Struct({
  id: EnvironmentId,
  label: BoardWorkerLabel,
  /** Where a direct-dial worker was reached. Outbound workers (T3O-84) dial the
      board instead, so they have none; only rows from before then carry one. */
  url: Schema.optionalKey(TrimmedNonEmptyString),
  addedAt: IsoDateTime,
  abbreviation: Schema.optionalKey(BoardWorkerAbbreviation),
  /** The T3o release the worker reported when it joined. */
  t3oRelease: Schema.optionalKey(TrimmedNonEmptyString),
  /** When it last joined with a code. */
  joinedAt: Schema.optionalKey(IsoDateTime),
});
export type BoardWorker = typeof BoardWorker.Type;

// ── Runtime status ─────────────────────────────────────────────────────

/**
 * Supervisor runtime state, re-derived by dialing on every boot, never event-sourced.
 * `incompatible`: below the protocol floor or not T3o. `unauthorized`: the worker refused
 * the board's session (revoked or reset) and needs a re-pair.
 */
export const BoardWorkerConnectionState = Schema.Literals([
  "online",
  "connecting",
  "offline",
  "incompatible",
  "unauthorized",
]);
export type BoardWorkerConnectionState = typeof BoardWorkerConnectionState.Type;

export const BoardWorkerStatus = Schema.Struct({
  state: BoardWorkerConnectionState,
  /** When the worker last answered — the last successful handshake or the
      moment a live connection dropped. Null when it never has. */
  lastSeenAt: Schema.NullOr(IsoDateTime),
  /** The T3o version the worker last reported. */
  t3oVersion: Schema.NullOr(TrimmedNonEmptyString),
  /** The board-worker protocol the worker last reported. */
  protocolVersion: Schema.NullOr(NonNegativeInt),
});
export type BoardWorkerStatus = typeof BoardWorkerStatus.Type;

// ── Last-known snapshot ────────────────────────────────────────────────

/** A provider instance on a worker, as that worker's own config reports it. */
export const BoardWorkerProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: TrimmedNonEmptyString,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  models: Schema.Array(
    Schema.Struct({
      slug: TrimmedNonEmptyString,
      name: TrimmedNonEmptyString,
    }),
  ),
});
export type BoardWorkerProvider = typeof BoardWorkerProvider.Type;

/** A project checkout on a worker. `projectId` is the WORKER's project id. */
export const BoardWorkerCheckout = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  /** The repository grouping key (`boardRepositoryGroupingKey`), or null for a
      checkout with no git remote. */
  repositoryKey: Schema.NullOr(TrimmedNonEmptyString),
});
export type BoardWorkerCheckout = typeof BoardWorkerCheckout.Type;

/**
 * What a worker last reported. Persisted on the central server, so an offline
 * worker keeps showing "Last known · offline" coverage and its last providers.
 */
export const BoardWorkerSnapshot = Schema.Struct({
  providers: Schema.Array(BoardWorkerProvider),
  checkouts: Schema.Array(BoardWorkerCheckout),
  /** Where Set up clones into by default on that worker. */
  projectsFolder: Schema.NullOr(TrimmedNonEmptyString),
  reportedAt: IsoDateTime,
});
export type BoardWorkerSnapshot = typeof BoardWorkerSnapshot.Type;

/** One registered worker, as every board client sees it. */
export const BoardWorkerView = Schema.Struct({
  ...BoardWorker.fields,
  status: BoardWorkerStatus,
  snapshot: Schema.NullOr(BoardWorkerSnapshot),
});
export type BoardWorkerView = typeof BoardWorkerView.Type;

// ── Project setup (clone on a worker) ──────────────────────────────────

/** Why a Set up on worker failed (prototype 2.3). */
export const BoardWorkerSetupFailureKind = Schema.Literals([
  "no-credentials",
  "remote-unreachable",
  "folder-exists",
  "no-remote",
  "disk-full",
  "worker-offline",
  "unknown",
]);
export type BoardWorkerSetupFailureKind = typeof BoardWorkerSetupFailureKind.Type;

/** The tail of git's output kept for Details / Copy log. */
export const BOARD_WORKER_SETUP_LOG_MAX_LENGTH = 4_000;

export const BoardWorkerSetup = Schema.Struct({
  /** The CENTRAL project being set up. */
  projectId: ProjectId,
  workerId: EnvironmentId,
  /** The project the clone created on the worker, once it exists. */
  workerProjectId: Schema.NullOr(ProjectId),
  destinationPath: TrimmedNonEmptyString,
  phase: Schema.Literals(["cloning", "failed", "done"]),
  /** Git's own phase while cloning (`receiving`, `resolving`…). */
  stage: Schema.NullOr(TrimmedNonEmptyString),
  /** Percent of the current git phase. */
  percent: Schema.NullOr(NonNegativeInt),
  failure: Schema.NullOr(
    Schema.Struct({
      kind: BoardWorkerSetupFailureKind,
      message: TrimmedNonEmptyString,
      log: Schema.String,
    }),
  ),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type BoardWorkerSetup = typeof BoardWorkerSetup.Type;

// ── Join codes (T3O-84) ───────────────────────────────────────────────

/** What Add worker ticks off as a joining worker reports in (prototype 3.5). */
export const BoardWorkerJoinMilestone = Schema.Literals([
  "code-accepted",
  "connected",
  "reading",
  "checking",
  "joined",
]);
export type BoardWorkerJoinMilestone = typeof BoardWorkerJoinMilestone.Type;

/** Why a worker's attempt to use a code was refused, kept so the dialog can say so. */
export const BoardWorkerJoinRefusal = Schema.Literals([
  "expired",
  "used",
  "unknown",
  "cancelled",
  "needs-update",
]);
export type BoardWorkerJoinRefusal = typeof BoardWorkerJoinRefusal.Type;

/**
 * A join code as every board client sees it. The code itself is never here: the
 * board keeps only its hash, and only the client that created it ever shows it.
 */
export const BoardWorkerJoinCodeView = Schema.Struct({
  codeId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  state: Schema.Literals(["open", "used", "expired", "cancelled"]),
  /** Who used it: set once a worker presented it. */
  usedBy: Schema.NullOr(
    Schema.Struct({
      workerId: EnvironmentId,
      label: TrimmedNonEmptyString,
      address: Schema.NullOr(TrimmedNonEmptyString),
      t3oRelease: Schema.NullOr(TrimmedNonEmptyString),
      usedAt: IsoDateTime,
      /** True when this worker was already on the board (a re-join). */
      rejoin: Schema.Boolean,
    }),
  ),
  /** The milestones reached so far, in order. */
  milestones: Schema.Array(BoardWorkerJoinMilestone),
  /** The last refusal a worker met trying this code (needs-update keeps it open). */
  lastRefusal: Schema.NullOr(
    Schema.Struct({
      reason: BoardWorkerJoinRefusal,
      at: IsoDateTime,
      t3oRelease: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
});
export type BoardWorkerJoinCodeView = typeof BoardWorkerJoinCodeView.Type;

/** How long a join code works for. */
export const BOARD_WORKER_JOIN_CODE_TTL_MINUTES = 10;

/** Crockford base32, with the letters that read as digits left out. */
const JOIN_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A code as typed: case, spaces and dashes don't matter, and I/L read as 1, O as 0. */
export function normalizeBoardWorkerJoinCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length !== 8) return null;
  for (const char of cleaned) if (!JOIN_CODE_ALPHABET.includes(char)) return null;
  return cleaned;
}

/** 40 random bits as eight Crockford characters, shown `XXXX-XXXX`. */
export function formatBoardWorkerJoinCode(bytes: Uint8Array): string {
  let bits = 0n;
  for (const byte of bytes.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let index = 0; index < 8; index++) {
    out = JOIN_CODE_ALPHABET[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * An abbreviation suggested from a label: `build-03` → `B03`, `mac-mini` → `MAC`.
 * Never one in `taken`; null when nothing fits.
 */
export function suggestBoardWorkerAbbreviation(
  label: string,
  taken: ReadonlyArray<string>,
): string | null {
  const used = new Set([BOARD_LOCAL_WORKER_ABBREVIATION, ...taken]);
  const upper = label.toUpperCase();
  const words = upper.split(/[^A-Z0-9]+/).filter((word) => word.length > 0);
  const letters = upper.replace(/[^A-Z]/g, "");
  const digits = upper.replace(/[^0-9]/g, "");
  const candidates: string[] = [];
  const firstLetter = words[0]?.match(/[A-Z]/)?.[0] ?? "";
  if (firstLetter.length > 0 && digits.length > 0) {
    candidates.push(`${firstLetter}${digits.slice(-2)}`);
  }
  if (words[0] !== undefined) candidates.push(words[0].slice(0, 3));
  if (words.length >= 2)
    candidates.push(
      words
        .map((word) => word[0])
        .join("")
        .slice(0, 3),
    );
  if (letters.length > 0) candidates.push(letters.slice(0, 3));
  for (const candidate of candidates) {
    if (/^[A-Z0-9]{1,3}$/.test(candidate) && !used.has(candidate)) return candidate;
  }
  const stem = letters || "W";
  for (let index = 1; index < 100; index++) {
    const suffix = String(index);
    const candidate = `${stem.slice(0, 3 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

// ── The board's worker summary ─────────────────────────────────────────

/**
 * Rides `board.subscribeBoard`, never the card shell. Absent on a local-only board, so an
 * ordinary board's payload is unchanged. The `local` worker is never listed.
 */
export const BoardWorkersState = Schema.Struct({
  defaultWorkerId: BoardWorkerId,
  workers: Schema.Array(BoardWorkerView),
  setups: Schema.Array(BoardWorkerSetup),
  /** Join codes still open, or used recently enough that Add worker follows them. */
  joinCodes: Schema.Array(BoardWorkerJoinCodeView).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** The board server's own name as a worker; absent or null reads "This server". */
  localLabel: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type BoardWorkersState = typeof BoardWorkersState.Type;

export const EMPTY_BOARD_WORKERS_STATE: BoardWorkersState = {
  defaultWorkerId: BOARD_LOCAL_WORKER_ID,
  workers: [],
  setups: [],
  joinCodes: [],
};

/** The board server is its only worker: none joined, none being set up, the local default. */
export function hasOnlyLocalBoardWorker(state: BoardWorkersState | undefined): boolean {
  return (
    state === undefined ||
    (state.workers.length === 0 &&
      state.setups.length === 0 &&
      state.defaultWorkerId === BOARD_LOCAL_WORKER_ID)
  );
}

/** A board with no workers, no join codes listed and the local default is exactly today's
    board, so its payload carries no worker state. */
export function isLocalOnlyBoardWorkers(state: BoardWorkersState | undefined): boolean {
  return hasOnlyLocalBoardWorker(state) && (state?.joinCodes.length ?? 0) === 0;
}

/** Every worker id, the built-in `local` first. */
export function boardWorkerIds(state: BoardWorkersState | undefined): ReadonlyArray<BoardWorkerId> {
  return [BOARD_LOCAL_WORKER_ID, ...(state?.workers ?? []).map((worker) => worker.id)];
}

/** Only an online, compatible, paired worker can become the default. */
export function canBeDefaultBoardWorker(worker: BoardWorkerView): boolean {
  return worker.status.state === "online";
}

// ── Commands and events (the registry) ─────────────────────────────

/**
 * Internal: dispatched once a joining worker's code is accepted. `add` refuses a
 * registered worker; `repair` (a re-join) refuses an unknown one and keeps its label,
 * abbreviation and `addedAt`; `rename` changes only the label and abbreviation.
 * An abbreviation another worker holds, or `SRV`, is refused.
 */
export const BoardWorkerRegisterCommand = Schema.Struct({
  type: Schema.Literal("board.worker.register"),
  commandId: CommandId,
  mode: Schema.Literals(["add", "repair", "rename"]),
  worker: BoardWorker,
  createdAt: IsoDateTime,
});

/** Remove a worker from the registry. Refused for `local` and for the default. */
export const BoardWorkerRemoveCommand = Schema.Struct({
  type: Schema.Literal("board.worker.remove"),
  commandId: CommandId,
  workerId: EnvironmentId,
  createdAt: IsoDateTime,
});

/** Make a worker the default for cards that are not pinned. */
export const BoardWorkerSetDefaultCommand = Schema.Struct({
  type: Schema.Literal("board.worker.set-default"),
  commandId: CommandId,
  workerId: BoardWorkerId,
  createdAt: IsoDateTime,
});

export const BoardWorkerRegisteredPayload = Schema.Struct({
  worker: BoardWorker,
});
export type BoardWorkerRegisteredPayload = typeof BoardWorkerRegisteredPayload.Type;

export const BoardWorkerRemovedPayload = Schema.Struct({
  workerId: EnvironmentId,
});
export type BoardWorkerRemovedPayload = typeof BoardWorkerRemovedPayload.Type;

export const BoardDefaultWorkerSetPayload = Schema.Struct({
  workerId: BoardWorkerId,
});
export type BoardDefaultWorkerSetPayload = typeof BoardDefaultWorkerSetPayload.Type;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Canonical registry order: by label, then id. By code units, never
    `localeCompare`, so a from-empty replay and a table rehydration agree on
    every machine. */
export function compareBoardWorkers(left: BoardWorker, right: BoardWorker): number {
  return compareCodeUnits(left.label, right.label) || compareCodeUnits(left.id, right.id);
}

// ── Project ↔ worker mapping ─────────────────────────────────────

/**
 * Prefers the checkout's own remote over the canonical one, so a fork stays distinct
 * (the origin-first rule pull requests are addressed by). Lower-cased so casing never
 * splits a match.
 */
export function boardRepositoryGroupingKey(
  identity: RepositoryIdentity | null | undefined,
): string | null {
  if (identity === null || identity === undefined) return null;
  const key = repositoryGroupingKeyOf(identity).trim().toLowerCase();
  return key.length === 0 ? null : key;
}

/**
 * The worker checkout a central project maps to, or null when the worker has
 * none. A project with no repository key maps to nothing on another worker —
 * there is no remote to match it by. The `local` worker maps every project to
 * itself; callers handle that before asking.
 */
export function resolveBoardWorkerCheckout(
  projectRepositoryKey: string | null,
  checkouts: ReadonlyArray<BoardWorkerCheckout>,
): BoardWorkerCheckout | null {
  if (projectRepositoryKey === null) return null;
  return checkouts.find((checkout) => checkout.repositoryKey === projectRepositoryKey) ?? null;
}

// ── Worker-side RPCs (`boardWorker.*`) ─────────────────────────────────

export const BOARD_WORKER_WS_METHODS = {
  /** The handshake: who this worker is and what protocol it speaks. */
  hello: "boardWorker.hello",
  /** The worker's project checkouts, with repository identity. */
  projects: "boardWorker.projects",
  /** The worker's provider instances and models, and its projects folder. */
  providers: "boardWorker.providers",
  /** Revoke the calling session — how a renewal gives the old session back — or,
      with `all`, every session this board holds on the worker, its users' too: how
      Remove gives the board's access back. Upstream refuses a session revoking
      itself over HTTP, so the worker does it on the board's behalf. */
  release: "boardWorker.release",
  /** Issue the calling session's successor — same subject, scopes and label —
      so the board's access outlives upstream's fixed session lifetime. The
      caller gives the old session back with `release` once it holds the new
      one. */
  renew: "boardWorker.renew",
  /** A session on the worker for one board user, so their browser can open the
      worker's threads through the board (T3O-84). Board sessions only. */
  mintUserSession: "boardWorker.mintUserSession",
  /** Revoke the worker sessions minted for these board sessions. */
  revokeUserSessions: "boardWorker.revokeUserSessions",
} as const;

export const BoardWorkerReleaseInput = Schema.Struct({
  all: Schema.optional(Schema.Boolean),
});
export type BoardWorkerReleaseInput = typeof BoardWorkerReleaseInput.Type;

export const BoardWorkerMintUserSessionInput = Schema.Struct({
  /** The caller's own session id on the board: it keys the worker session. */
  boardSessionId: TrimmedNonEmptyString,
  scopes: Schema.Array(TrimmedNonEmptyString),
  label: TrimmedNonEmptyString,
});
export type BoardWorkerMintUserSessionInput = typeof BoardWorkerMintUserSessionInput.Type;

export const BoardWorkerUserSession = Schema.Struct({
  bearerToken: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  scopes: Schema.Array(TrimmedNonEmptyString),
});
export type BoardWorkerUserSession = typeof BoardWorkerUserSession.Type;

export const BoardWorkerRevokeUserSessionsInput = Schema.Struct({
  boardSessionIds: Schema.Array(TrimmedNonEmptyString),
});
export type BoardWorkerRevokeUserSessionsInput = typeof BoardWorkerRevokeUserSessionsInput.Type;

export const BoardWorkerHello = Schema.Struct({
  protocolVersion: NonNegativeInt,
  environmentId: EnvironmentId,
  t3oVersion: TrimmedNonEmptyString,
  /** When the calling session expires; null for one that never does. */
  sessionExpiresAt: Schema.NullOr(IsoDateTime),
});
export type BoardWorkerHello = typeof BoardWorkerHello.Type;

export const BoardWorkerProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
});
export type BoardWorkerProject = typeof BoardWorkerProject.Type;

export const BoardWorkerProjects = Schema.Struct({
  projects: Schema.Array(BoardWorkerProject),
});
export type BoardWorkerProjects = typeof BoardWorkerProjects.Type;

export const BoardWorkerProviders = Schema.Struct({
  providers: Schema.Array(BoardWorkerProvider),
  projectsFolder: Schema.NullOr(TrimmedNonEmptyString),
});
export type BoardWorkerProviders = typeof BoardWorkerProviders.Type;

export const BoardWorkerRenewal = Schema.Struct({
  accessToken: TrimmedNonEmptyString,
});
export type BoardWorkerRenewal = typeof BoardWorkerRenewal.Type;

export class BoardWorkerRequestError extends Schema.TaggedError<BoardWorkerRequestError>()(
  "BoardWorkerRequestError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const BOARD_WORKER_RPCS = [
  Rpc.make(BOARD_WORKER_WS_METHODS.hello, {
    payload: Schema.Struct({}),
    success: BoardWorkerHello,
    error: Schema.Union([BoardWorkerRequestError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKER_WS_METHODS.projects, {
    payload: Schema.Struct({}),
    success: BoardWorkerProjects,
    error: Schema.Union([BoardWorkerRequestError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKER_WS_METHODS.providers, {
    payload: Schema.Struct({}),
    success: BoardWorkerProviders,
    error: Schema.Union([BoardWorkerRequestError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKER_WS_METHODS.release, {
    payload: BoardWorkerReleaseInput,
    success: Schema.Void,
    error: Schema.Union([BoardWorkerRequestError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKER_WS_METHODS.renew, {
    payload: Schema.Struct({}),
    success: BoardWorkerRenewal,
    error: Schema.Union([BoardWorkerRequestError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKER_WS_METHODS.mintUserSession, {
    payload: BoardWorkerMintUserSessionInput,
    success: BoardWorkerUserSession,
    error: Schema.Union([BoardWorkerRequestError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKER_WS_METHODS.revokeUserSessions, {
    payload: BoardWorkerRevokeUserSessionsInput,
    success: Schema.Struct({ revoked: NonNegativeInt }),
    error: Schema.Union([BoardWorkerRequestError, EnvironmentAuthorizationError]),
  }),
] as const;

// ── Central-server RPCs (`board.workers.*`) ────────────────────────────

export const BOARD_WORKERS_WS_METHODS = {
  /** A one-time join code for a new worker (T3O-84). */
  createJoinCode: "board.workers.createJoinCode",
  /** Stop an open join code working. */
  cancelJoinCode: "board.workers.cancelJoinCode",
  /** Change a worker's label and abbreviation. */
  rename: "board.workers.rename",
  /** Revoke the board's access on the worker if reachable, then forget it. */
  remove: "board.workers.remove",
  /** The cards removing a worker would affect, for its confirm dialog. */
  removePreview: "board.workers.removePreview",
  /** Make an online worker the default. */
  setDefault: "board.workers.setDefault",
  /** Clone a board project's repository onto a worker. */
  setupProject: "board.workers.setupProject",
  /** Forget a finished or failed setup (dismiss). */
  dismissSetup: "board.workers.dismissSetup",
  /** A session for the caller on a worker, to open its threads through the board. */
  threadAccess: "board.workers.threadAccess",
} as const;

export const BoardWorkerJoinCodeCreated = Schema.Struct({
  codeId: TrimmedNonEmptyString,
  /** `XXXX-XXXX`. Shown once, to the client that asked; the board keeps a hash. */
  code: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type BoardWorkerJoinCodeCreated = typeof BoardWorkerJoinCodeCreated.Type;

export const BoardWorkersCancelJoinCodeInput = Schema.Struct({
  codeId: TrimmedNonEmptyString,
});
export type BoardWorkersCancelJoinCodeInput = typeof BoardWorkersCancelJoinCodeInput.Type;

export const BoardWorkersRenameInput = Schema.Struct({
  workerId: BoardWorkerId,
  label: BoardWorkerLabel,
  abbreviation: BoardWorkerAbbreviation,
});
export type BoardWorkersRenameInput = typeof BoardWorkersRenameInput.Type;

/** A browser's way into a worker's threads: the board's proxied path for it and a
    session there. The client resolves `path` against the board URL it already uses. */
export const BoardWorkerThreadAccess = Schema.Struct({
  workerId: EnvironmentId,
  path: TrimmedNonEmptyString,
  bearerToken: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type BoardWorkerThreadAccess = typeof BoardWorkerThreadAccess.Type;

export const BoardWorkerIdInput = Schema.Struct({
  workerId: EnvironmentId,
});
export type BoardWorkerIdInput = typeof BoardWorkerIdInput.Type;

export const BoardWorkersSetDefaultInput = Schema.Struct({
  workerId: BoardWorkerId,
});
export type BoardWorkersSetDefaultInput = typeof BoardWorkersSetDefaultInput.Type;

export const BoardWorkersSetupProjectInput = Schema.Struct({
  projectId: ProjectId,
  workerId: EnvironmentId,
  /** The folder to clone into, on the worker. Defaults to the worker's
      projects folder plus the repository's name. */
  folder: Schema.optionalKey(TrimmedNonEmptyString),
});
export type BoardWorkersSetupProjectInput = typeof BoardWorkersSetupProjectInput.Type;

export const BoardWorkersDismissSetupInput = Schema.Struct({
  projectId: ProjectId,
  workerId: EnvironmentId,
});
export type BoardWorkersDismissSetupInput = typeof BoardWorkersDismissSetupInput.Type;

/** One card in Remove worker's confirm dialog (prototype 1.11). `detail` is
    the row's right-hand text: its stage, "Build step running", or "Has
    worktree". `running` says whether removal stops one of its steps. */
export const BoardWorkerRemovePreviewCard = Schema.Struct({
  cardId: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  title: Schema.String,
  detail: TrimmedNonEmptyString,
  running: Schema.Boolean,
});
export type BoardWorkerRemovePreviewCard = typeof BoardWorkerRemovePreviewCard.Type;

/**
 * What removing a worker would do to its cards: the cards with
 * no worktree yet move to the default worker; the ones with a worktree or a
 * running step need moving by hand, and hold until they are. Archived cards
 * are not listed.
 */
export const BoardWorkerRemovePreview = Schema.Struct({
  workerId: EnvironmentId,
  workerLabel: TrimmedNonEmptyString,
  /** The default worker the first group falls back to. */
  defaultWorkerLabel: TrimmedNonEmptyString,
  toDefault: Schema.Array(BoardWorkerRemovePreviewCard),
  byHand: Schema.Array(BoardWorkerRemovePreviewCard),
});
export type BoardWorkerRemovePreview = typeof BoardWorkerRemovePreview.Type;

/** The success summary Add worker shows (prototype 1.6). */
export const BoardWorkerAddResult = Schema.Struct({
  worker: BoardWorkerView,
  /** Board projects with a checkout on the new worker, out of all of them. */
  coveredProjects: NonNegativeInt,
  totalProjects: NonNegativeInt,
});
export type BoardWorkerAddResult = typeof BoardWorkerAddResult.Type;

/**
 * `unreachable` means the board server cannot reach the worker, though the client may.
 * `different-server`: the credential belongs to another server than the one picked.
 */
export const BoardWorkerAddErrorCode = Schema.Literals([
  "unreachable",
  "invalid-credential",
  "incompatible",
  "different-server",
  "board-server",
  "already-worker",
  "not-found",
]);
export type BoardWorkerAddErrorCode = typeof BoardWorkerAddErrorCode.Type;

export class BoardWorkerAddError extends Schema.TaggedError<BoardWorkerAddError>()(
  "BoardWorkerAddError",
  {
    code: BoardWorkerAddErrorCode,
    message: TrimmedNonEmptyString,
    /** The worker's label as it named itself, for "this link is from ci-runner-3". */
    workerLabel: Schema.optionalKey(TrimmedNonEmptyString),
    /** The worker's version, for "mbp-brent runs T3o 0.11.0". */
    workerVersion: Schema.optionalKey(TrimmedNonEmptyString),
  },
) {}

/** Remove, set-default and setup refusals: a sentence the UI shows as is. */
export class BoardWorkerActionError extends Schema.TaggedError<BoardWorkerActionError>()(
  "BoardWorkerActionError",
  {
    code: Schema.Literals([
      "not-found",
      "is-default",
      "not-online",
      "no-remote",
      "internal",
      "invalid",
      "forbidden",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}

export const BOARD_WORKERS_RPCS = [
  Rpc.make(BOARD_WORKERS_WS_METHODS.createJoinCode, {
    payload: Schema.Struct({}),
    success: BoardWorkerJoinCodeCreated,
    error: Schema.Union([BoardWorkerActionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.cancelJoinCode, {
    payload: BoardWorkersCancelJoinCodeInput,
    success: Schema.Void,
    error: Schema.Union([BoardWorkerActionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.rename, {
    payload: BoardWorkersRenameInput,
    success: Schema.Void,
    error: Schema.Union([BoardWorkerActionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.threadAccess, {
    payload: BoardWorkerIdInput,
    success: BoardWorkerThreadAccess,
    error: Schema.Union([BoardWorkerActionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.remove, {
    payload: BoardWorkerIdInput,
    success: Schema.Struct({ revoked: Schema.Boolean }),
    error: Schema.Union([BoardWorkerActionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.removePreview, {
    payload: BoardWorkerIdInput,
    success: BoardWorkerRemovePreview,
    error: Schema.Union([BoardWorkerActionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.setDefault, {
    payload: BoardWorkersSetDefaultInput,
    success: Schema.Void,
    error: Schema.Union([BoardWorkerActionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.setupProject, {
    payload: BoardWorkersSetupProjectInput,
    success: BoardWorkerSetup,
    error: Schema.Union([BoardWorkerActionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.dismissSetup, {
    payload: BoardWorkersDismissSetupInput,
    success: Schema.Void,
    error: EnvironmentAuthorizationError,
  }),
] as const;

/**
 * Scopes, spread into `BOARD_RPC_SCOPES`. No new scope tier: a worker's
 * reads are thread-shell reads, managing workers is a board write, cloning is
 * a source-control write, and the board's own session holds all three.
 */
export const BOARD_WORKER_RPC_SCOPES = {
  [BOARD_WORKER_WS_METHODS.hello]: AuthOrchestrationReadScope,
  [BOARD_WORKER_WS_METHODS.projects]: AuthOrchestrationReadScope,
  [BOARD_WORKER_WS_METHODS.providers]: AuthOrchestrationReadScope,
  // Revokes only the caller's own session, so it needs nothing more than the
  // session itself.
  [BOARD_WORKER_WS_METHODS.release]: AuthOrchestrationReadScope,
  // Its successor carries exactly the caller's own scopes, never more.
  [BOARD_WORKER_WS_METHODS.renew]: AuthOrchestrationReadScope,
  // Board RPCs only: the guard in `board/rpc.ts` also refuses non-board sessions.
  [BOARD_WORKER_WS_METHODS.mintUserSession]: AuthOrchestrationReadScope,
  [BOARD_WORKER_WS_METHODS.revokeUserSessions]: AuthOrchestrationReadScope,
  // A join code lets a machine onto the board, so it is an access write.
  [BOARD_WORKERS_WS_METHODS.createJoinCode]: AuthAccessWriteScope,
  [BOARD_WORKERS_WS_METHODS.cancelJoinCode]: AuthAccessWriteScope,
  [BOARD_WORKERS_WS_METHODS.rename]: AuthOrchestrationOperateScope,
  [BOARD_WORKERS_WS_METHODS.threadAccess]: AuthOrchestrationReadScope,
  [BOARD_WORKERS_WS_METHODS.remove]: AuthOrchestrationOperateScope,
  // A read of the board's own cards, ahead of the write it previews.
  [BOARD_WORKERS_WS_METHODS.removePreview]: AuthOrchestrationReadScope,
  [BOARD_WORKERS_WS_METHODS.setDefault]: AuthOrchestrationOperateScope,
  [BOARD_WORKERS_WS_METHODS.setupProject]: AuthSourceControlWriteScope,
  [BOARD_WORKERS_WS_METHODS.dismissSetup]: AuthOrchestrationOperateScope,
} as const;
