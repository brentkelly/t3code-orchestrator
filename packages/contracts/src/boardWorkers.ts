/**
 * T3o distributed board: workers (T3O-62, overview D19–D22).
 *
 * One central T3o server hosts the board and dials each worker — another T3o
 * server — as a paired client. This file holds everything worker-shaped on the
 * wire:
 *
 * - the registry (`BoardWorker`) and what the central server knows about each
 *   worker at runtime (`BoardWorkerStatus`, the last-known snapshot);
 * - `BoardWorkersState`, the one bounded summary that rides
 *   `board.subscribeBoard`;
 * - the central server's `board.workers.*` RPCs, which clients call;
 * - the worker-side `boardWorker.*` RPCs, which the central server calls on
 *   each worker over the connection it holds.
 *
 * Imports only leaf modules, so `board.ts` can import it without a cycle.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
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
 * The board-worker protocol this build speaks. Bumped when the central server
 * starts relying on a `boardWorker.*` call (or a change to one) that an older
 * worker does not have.
 */
export const BOARD_WORKER_PROTOCOL_VERSION = 1;

/** The oldest protocol a worker may speak and still be used (D16). */
export const BOARD_WORKER_PROTOCOL_FLOOR = 1;

/**
 * The T3o release that first spoke `BOARD_WORKER_PROTOCOL_FLOOR`, so the UI can
 * say "Needs T3o 0.0.45 or newer" rather than a protocol number nobody knows.
 * Raise it together with the floor.
 */
export const BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION = "0.0.45";

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

export const BOARD_WORKER_LABEL_MAX_LENGTH = 64;
export const BoardWorkerLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BOARD_WORKER_LABEL_MAX_LENGTH),
);

/** A registered worker (D19). The registry lives in the board read model (D8). */
export const BoardWorker = Schema.Struct({
  id: EnvironmentId,
  label: BoardWorkerLabel,
  /** The worker's HTTP origin, e.g. `https://linux-box.tail1234.ts.net:3773`. */
  url: TrimmedNonEmptyString,
  addedAt: IsoDateTime,
});
export type BoardWorker = typeof BoardWorker.Type;

// ── Runtime status ─────────────────────────────────────────────────────

/**
 * Where the central server's connection to a worker stands. Supervisor
 * runtime state, re-derived by dialing on every boot — never event-sourced
 * (D8).
 *
 * - `online` — connected, handshake passed. The steady state.
 * - `connecting` — dialing, or handshaking.
 * - `offline` — unreachable; retried with backoff.
 * - `incompatible` — reachable, but below the protocol floor or not a T3o
 *   worker at all.
 * - `unauthorized` — the worker refused the board's session: revoked on the
 *   worker, or the worker was reset. Needs a re-pair.
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

// ── The board's worker summary ─────────────────────────────────────────

/**
 * Everything about workers a board client holds. Rides `board.subscribeBoard`
 * (the snapshot's `workers`, and the whole-state `workers` delta), never the
 * card shell (D7). Absent from the snapshot on a local-only board, which is
 * the overwhelming majority: an ordinary board's payload is unchanged.
 *
 * The `local` worker is not listed: it always exists, and the client renders
 * it from its own connection (`boardWorkerIds`).
 */
export const BoardWorkersState = Schema.Struct({
  defaultWorkerId: BoardWorkerId,
  workers: Schema.Array(BoardWorkerView),
  setups: Schema.Array(BoardWorkerSetup),
});
export type BoardWorkersState = typeof BoardWorkersState.Type;

export const EMPTY_BOARD_WORKERS_STATE: BoardWorkersState = {
  defaultWorkerId: BOARD_LOCAL_WORKER_ID,
  workers: [],
  setups: [],
};

/** A board with no workers and the local default is exactly today's board. */
export function isLocalOnlyBoardWorkers(state: BoardWorkersState | undefined): boolean {
  return (
    state === undefined ||
    (state.workers.length === 0 &&
      state.setups.length === 0 &&
      state.defaultWorkerId === BOARD_LOCAL_WORKER_ID)
  );
}

/** Every worker id, the built-in `local` first. */
export function boardWorkerIds(state: BoardWorkersState | undefined): ReadonlyArray<BoardWorkerId> {
  return [BOARD_LOCAL_WORKER_ID, ...(state?.workers ?? []).map((worker) => worker.id)];
}

/** Only an online, compatible, paired worker can become the default. */
export function canBeDefaultBoardWorker(worker: BoardWorkerView): boolean {
  return worker.status.state === "online";
}

// ── Commands and events (the registry, D8) ─────────────────────────────

/**
 * Register a worker, or record a re-pair of one. Internal: dispatched by the
 * `board.workers.add` / `.repair` RPCs once the credential exchange succeeded,
 * never by a client directly — the board must hold a working session before a
 * worker exists in its registry.
 *
 * `mode: "add"` is refused for a worker that is already registered;
 * `"repair"` is refused for one that is not, and keeps its label and
 * `addedAt` (only the URL may change).
 */
export const BoardWorkerRegisterCommand = Schema.Struct({
  type: Schema.Literal("board.worker.register"),
  commandId: CommandId,
  mode: Schema.Literals(["add", "repair"]),
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

// ── Project ↔ worker mapping (D20) ─────────────────────────────────────

/**
 * The key a board project and a worker's checkout must share to be the same
 * repository: upstream's grouping key, which prefers the checkout's own
 * remote over the canonical one, so a fork stays distinct from what it forked
 * — the same origin-first rule `board/boardRepository.ts` addresses pull
 * requests by. Lower-cased, so host and owner casing never split a match.
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
  /** Revoke the calling session — how Remove gives the board's access back.
      Upstream refuses a session revoking itself over HTTP, so the worker does
      it on the board's behalf. */
  release: "boardWorker.release",
} as const;

export const BoardWorkerHello = Schema.Struct({
  protocolVersion: NonNegativeInt,
  environmentId: EnvironmentId,
  t3oVersion: TrimmedNonEmptyString,
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
    payload: Schema.Struct({}),
    success: Schema.Void,
    error: Schema.Union([BoardWorkerRequestError, EnvironmentAuthorizationError]),
  }),
] as const;

// ── Central-server RPCs (`board.workers.*`) ────────────────────────────

export const BOARD_WORKERS_WS_METHODS = {
  /** Add a worker from a one-time pairing token or a pasted pairing link. */
  add: "board.workers.add",
  /** Re-pair an existing worker; keeps its label, pinned cards and limits. */
  repair: "board.workers.repair",
  /** Revoke the board's access on the worker if reachable, then forget it. */
  remove: "board.workers.remove",
  /** Make an online worker the default. */
  setDefault: "board.workers.setDefault",
  /** Clone a board project's repository onto a worker. */
  setupProject: "board.workers.setupProject",
  /** Forget a finished or failed setup (dismiss). */
  dismissSetup: "board.workers.dismissSetup",
} as const;

/**
 * How the central server gets its own session on a worker (D19): a one-time
 * token the client minted on the worker (`POST /api/auth/pairing-token`), or
 * a pairing link the human pasted from `t3 pair`.
 */
export const BoardWorkerCredential = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pairing-token"),
    token: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("pairing-url"),
    pairingUrl: TrimmedNonEmptyString,
  }),
]);
export type BoardWorkerCredential = typeof BoardWorkerCredential.Type;

export const BoardWorkersAddInput = Schema.Struct({
  /** The worker's HTTP origin. Optional with a pairing link, which carries it. */
  url: Schema.optionalKey(TrimmedNonEmptyString),
  credential: BoardWorkerCredential,
  label: BoardWorkerLabel,
  /** The environment the client picked, when it picked one: the worker must
      turn out to be that server ("That link is for a different server"). */
  expectedEnvironmentId: Schema.optionalKey(EnvironmentId),
});
export type BoardWorkersAddInput = typeof BoardWorkersAddInput.Type;

export const BoardWorkersRepairInput = Schema.Struct({
  workerId: EnvironmentId,
  url: Schema.optionalKey(TrimmedNonEmptyString),
  credential: BoardWorkerCredential,
});
export type BoardWorkersRepairInput = typeof BoardWorkersRepairInput.Type;

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

/** The success summary Add worker shows (prototype 1.6). */
export const BoardWorkerAddResult = Schema.Struct({
  worker: BoardWorkerView,
  /** Board projects with a checkout on the new worker, out of all of them. */
  coveredProjects: NonNegativeInt,
  totalProjects: NonNegativeInt,
});
export type BoardWorkerAddResult = typeof BoardWorkerAddResult.Type;

/**
 * Every way adding or re-pairing a worker fails, one per prototype error
 * state (1.9).
 *
 * - `unreachable` — the BOARD SERVER cannot reach the worker (the client may
 *   well be able to).
 * - `invalid-credential` — the link or token expired, was used, or is malformed.
 * - `incompatible` — the worker is below the protocol floor, or not T3o.
 * - `different-server` — the credential belongs to another server than the
 *   one picked (or, on re-pair, than the worker being re-paired).
 * - `board-server` — the credential is the board server's own.
 * - `already-worker` — that server is already a worker.
 * - `not-found` — re-pair of a worker that is not registered.
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
    code: Schema.Literals(["not-found", "is-default", "not-online", "no-remote", "internal"]),
    message: TrimmedNonEmptyString,
  },
) {}

export const BOARD_WORKERS_RPCS = [
  Rpc.make(BOARD_WORKERS_WS_METHODS.add, {
    payload: BoardWorkersAddInput,
    success: BoardWorkerAddResult,
    error: Schema.Union([BoardWorkerAddError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.repair, {
    payload: BoardWorkersRepairInput,
    success: BoardWorkerAddResult,
    error: Schema.Union([BoardWorkerAddError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_WORKERS_WS_METHODS.remove, {
    payload: BoardWorkerIdInput,
    success: Schema.Struct({ revoked: Schema.Boolean }),
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
 * Scopes, spread into `BOARD_RPC_SCOPES`. No new scope tier (D19): a worker's
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
  [BOARD_WORKERS_WS_METHODS.add]: AuthOrchestrationOperateScope,
  [BOARD_WORKERS_WS_METHODS.repair]: AuthOrchestrationOperateScope,
  [BOARD_WORKERS_WS_METHODS.remove]: AuthOrchestrationOperateScope,
  [BOARD_WORKERS_WS_METHODS.setDefault]: AuthOrchestrationOperateScope,
  [BOARD_WORKERS_WS_METHODS.setupProject]: AuthSourceControlWriteScope,
  [BOARD_WORKERS_WS_METHODS.dismissSetup]: AuthOrchestrationOperateScope,
} as const;
