// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off tryCatchInEffectGen:off globalDateInEffect:off - owns the plain-Node tunnel and a file watch; Effect is the service wrapper.
/**
 * The worker side (T3O-84): one outbound tunnel per board in `<home>/worker.json`, which
 * `t3o-worker` writes and this watches, with each one's state in `worker-status.json`. The
 * board's session is minted here, subject `t3o-board:<id>`, only when the board asks.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { BOARD_WORKER_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import packageJson from "../../../package.json" with { type: "json" };
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as ManagedLimits from "../../policy/managedLimits.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { BoardWorkerCapacity, SNAPSHOT_INTERVAL_MS } from "../capacity/BoardWorkerCapacity.ts";
import { boardSessionLabel } from "../workers/workerCredential.ts";
import {
  issueBoardSession,
  reconcileBoardUserSessions,
  revokeBoardSessions,
} from "../workers/workerRpc.ts";
import { TunnelWorker, type WorkerTunnelStatus } from "./tunnelWorker.ts";
import {
  localTunnelTarget,
  readWorkerFile,
  tunnelCredentialSecretName,
  upsertWorkerBoard,
  WORKER_FILE_NAME,
  writeWorkerFile,
  writeWorkerStatus,
  type WorkerBoardEntry,
  type WorkerBoardStatus,
  type WorkerCapacityStatus,
} from "./workerFile.ts";

export interface WorkerTunnelsShape {
  /** Re-read `worker.json` now and open or close tunnels to match it. */
  readonly reconcile: Effect.Effect<void>;
}

export class WorkerTunnels extends Context.Service<WorkerTunnels, WorkerTunnelsShape>()(
  "t3/board/tunnel/WorkerTunnels",
) {}

const STATUS_DEBOUNCE_MS = 200;

class WorkerPolicyRefusal extends Schema.TaggedError<WorkerPolicyRefusal>()("WorkerPolicyRefusal", {
  message: Schema.String,
}) {}

/** The release this server runs: the build stamp when there is one, else the package. */
export function readT3oRelease(): string {
  try {
    const stamp = JSON.parse(
      NodeFS.readFileSync(new URL("./t3o-release.json", import.meta.url), "utf8"),
    ) as { readonly version?: unknown };
    if (typeof stamp.version === "string" && stamp.version.length > 0) return stamp.version;
  } catch {
    // Not a stamped build: a dev server or a plain build.
  }
  return packageJson.version;
}

const makeWorkerTunnels = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore;
  const auth = yield* EnvironmentAuth;
  const environment = yield* ServerEnvironment;
  const context = yield* Effect.context<never>();
  const capacity = yield* Effect.serviceOption(BoardWorkerCapacity);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect);

  const home = config.baseDir;
  const environmentId = yield* environment.getEnvironmentId;
  const environmentLabel = (yield* environment.getDescriptor).label;
  const t3oRelease = readT3oRelease();
  const local = localTunnelTarget(config.host, config.port);

  interface Held {
    readonly entry: WorkerBoardEntry;
    readonly credential: string;
    readonly tunnel: TunnelWorker;
  }
  const held = new Map<string, Held>();
  const statuses = new Map<string, WorkerBoardStatus>();
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  let capacityStatus: WorkerCapacityStatus | undefined;
  const flushStatus = () => {
    statusTimer = null;
    try {
      writeWorkerStatus(home, {
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        boards: [...statuses.values()],
        ...(capacityStatus === undefined ? {} : { capacity: capacityStatus }),
      });
    } catch {
      // Status is advisory; `t3o-worker status` says so when it's missing.
    }
  };
  const scheduleStatus = () => {
    if (statusTimer !== null) return;
    statusTimer = setTimeout(flushStatus, STATUS_DEBOUNCE_MS);
    statusTimer.unref?.();
  };

  const recordStatus = (entry: WorkerBoardEntry, status: WorkerTunnelStatus) => {
    statuses.set(entry.boardEnvironmentId, {
      boardEnvironmentId: entry.boardEnvironmentId,
      boardLabel: entry.boardLabel,
      boardUrl: status.boardUrl,
      state: status.state,
      lastConnectedAt: status.lastConnectedAt,
      lastError: status.lastError,
    });
    scheduleStatus();
  };

  const readCredential = (boardId: string) =>
    secrets.get(tunnelCredentialSecretName(boardId)).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const open = (entry: WorkerBoardEntry, credential: string) => {
    const boardId = entry.boardEnvironmentId;
    const tunnel = new TunnelWorker({
      boardUrl: entry.boardUrl,
      credential,
      environmentId,
      label: environmentLabel,
      t3oRelease,
      gatewayProtocol: BOARD_WORKER_PROTOCOL_VERSION,
      local,
      mintBoardSession: () =>
        run(
          Effect.gen(function* () {
            const policy = yield* Effect.serviceOption(ManagedPolicy.ManagedPolicy);
            if (policy._tag === "Some" && !ManagedLimits.allowsRemoteClients(policy.value)) {
              return yield* new WorkerPolicyRefusal({
                message: "This worker's managed policy doesn't allow remote clients.",
              });
            }
            // A board being left (`t3o-worker leave`) is never handed a fresh session.
            const stillJoined = yield* Effect.sync(() => {
              try {
                return readWorkerFile(home).boards.some(
                  (board) => board.boardEnvironmentId === boardId,
                );
              } catch {
                // An unreadable file keeps every tunnel as it is (see reconcile).
                return true;
              }
            });
            if (!stillJoined || Option.isNone(yield* readCredential(boardId))) {
              return yield* new WorkerPolicyRefusal({
                message: "This worker has left that board.",
              });
            }
            const issued = yield* issueBoardSession(
              auth,
              boardId,
              boardSessionLabel(entry.boardLabel),
            );
            return issued.token;
          }),
        ),
      onReady: (ack) => {
        void run(
          reconcileBoardUserSessions(auth, boardId, ack.liveBoardSessionIds ?? []).pipe(
            Effect.ignore,
          ),
        );
      },
      onStatus: (status) => recordStatus(entry, status),
      onRevoked: () => {
        // The board no longer knows this worker: nothing it was given here stays.
        void run(revokeBoardSessions(auth, boardId).pipe(Effect.ignore));
      },
      onAddressAdopted: (boardUrl) => {
        // The tunnel already runs on the new address: reconcile mustn't restart it for this.
        const holding = held.get(boardId);
        if (holding !== undefined) {
          held.set(boardId, { ...holding, entry: { ...holding.entry, boardUrl } });
        }
        try {
          const file = readWorkerFile(home);
          const current = file.boards.find((board) => board.boardEnvironmentId === boardId);
          if (current === undefined) return;
          writeWorkerFile(
            home,
            upsertWorkerBoard(file, { ...current, boardUrl, previousBoardUrl: current.boardUrl }),
          );
        } catch {
          // Kept in memory; the next start dials the old address and learns again.
        }
      },
    });
    held.set(boardId, { entry, credential, tunnel });
    // Replace a previous tunnel's state (a re-join's stale `revoked`) before this one reports.
    recordStatus(entry, {
      state: "connecting",
      lastConnectedAt: statuses.get(boardId)?.lastConnectedAt ?? null,
      lastError: null,
      boardUrl: entry.boardUrl,
    });
    tunnel.start();
  };

  // A watcher reconcile can start while another is still reading credentials: one at a time,
  // or both open a tunnel to the same board.
  const reconcileLock = yield* Semaphore.make(1);
  const reconcile: WorkerTunnelsShape["reconcile"] = Effect.gen(function* () {
    let file: ReturnType<typeof readWorkerFile>;
    try {
      file = readWorkerFile(home);
    } catch (error) {
      // Keep every tunnel as it is until the file reads again.
      yield* Effect.logWarning("worker tunnels: worker.json unreadable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const wanted = new Map(file.boards.map((board) => [board.boardEnvironmentId, board]));
    for (const [boardId, current] of held) {
      const entry = wanted.get(boardId);
      if (entry !== undefined && entry.boardUrl === current.entry.boardUrl) continue;
      held.delete(boardId);
      // Left (`t3o-worker leave`): tell the board while the tunnel is still up.
      if (entry === undefined) void current.tunnel.goodbye();
      else current.tunnel.stop();
      if (entry === undefined) {
        statuses.delete(boardId);
        scheduleStatus();
        // T3o: leaving a board drops its card records and claims here (T3O-86).
        if (Option.isSome(capacity)) yield* capacity.value.forgetBoard(boardId);
      }
    }
    for (const [boardId, entry] of wanted) {
      const credential = yield* readCredential(boardId);
      const current = held.get(boardId);
      if (current !== undefined) {
        if (Option.isSome(credential) && credential.value === current.credential) continue;
        // A re-join stored a new credential: start over with it.
        current.tunnel.stop();
        held.delete(boardId);
      }
      if (Option.isNone(credential)) {
        recordStatus(entry, {
          state: "revoked",
          lastConnectedAt: null,
          lastError: "No tunnel credential stored for this board. Join it again.",
          boardUrl: entry.boardUrl,
        });
        continue;
      }
      open(entry, credential.value);
    }
  }).pipe(reconcileLock.withPermits(1), Effect.withSpan("WorkerTunnels.reconcile"));

  yield* reconcile;

  // T3o: the capacity section `t3o-worker status` prints, on the snapshot's cadence (T3O-86).
  if (Option.isSome(capacity)) {
    yield* Effect.gen(function* () {
      let served = new Set<string>();
      try {
        served = new Set(readWorkerFile(home).boards.map((board) => board.boardEnvironmentId));
      } catch {
        // Unreadable: every record's board reads as served.
        served = new Set(yield* capacity.value.boardIds);
      }
      capacityStatus = yield* capacity.value.status(served);
      scheduleStatus();
    }).pipe(
      Effect.ignoreCause,
      Effect.repeat(Schedule.spaced(SNAPSHOT_INTERVAL_MS)),
      Effect.forkScoped,
    );
  }

  // Watch the directory, not the file: the CLI replaces it atomically by rename.
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let watcher: NodeFS.FSWatcher | null = null;
  try {
    NodeFS.mkdirSync(home, { recursive: true });
    watcher = NodeFS.watch(home, (_event, name) => {
      if (name !== null && NodePath.basename(String(name)) !== WORKER_FILE_NAME) return;
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void run(reconcile);
      }, 150);
      debounce.unref?.();
    });
    watcher.on("error", () => undefined);
  } catch {
    // No watch on this filesystem: joins take effect at the next start.
  }

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      watcher?.close();
      if (debounce !== null) clearTimeout(debounce);
      for (const current of held.values()) current.tunnel.stop();
      held.clear();
      if (statusTimer !== null) clearTimeout(statusTimer);
    }),
  );

  return { reconcile } satisfies WorkerTunnelsShape;
});

export const WorkerTunnelsLive = Layer.effect(WorkerTunnels, makeWorkerTunnels);
