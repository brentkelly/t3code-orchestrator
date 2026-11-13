/**
 * The worker capacity service's ports on a real server (T3O-86): `worker.json` for its
 * settings, this server's own threads for what runs, the provider registry for quota and
 * accounts, the board database for records, and the worktree markers for adoption.
 */
import {
  boardRepositoryGroupingKey,
  DEFAULT_BOARD_READINESS_SCRIPT_PATH,
  type BoardWorkerReadiness,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { LocalThreadGateway } from "../ThreadGateway.ts";
import { readWorkerFile, resolveWorkerCapacitySettings } from "../tunnel/workerFile.ts";
import { BoardRelayStore } from "../workers/BoardRelayStore.ts";
import { parseRegisteredWorktrees } from "../worktree.ts";
import {
  adoptBoardWorktree,
  boardWorktreeOwner,
  boardWorktreeOwnerOf,
  type BoardWorktreeOwner,
} from "../workspace/LocalBoardWorkspace.ts";
import {
  BoardWorkerCapacity,
  makeBoardWorkerCapacity,
  type BoardWorkerCapacityShape,
  type CapacityThread,
  type WorkerCapacityPorts,
} from "./BoardWorkerCapacity.ts";
import { EMPTY_CAPACITY_STATE, type CapacityRecord } from "./capacityModel.ts";
import { BoardMachine, bytesToGB } from "./machine.ts";

const RecordJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      boardId: Schema.String,
      cardId: Schema.String,
      repositoryKey: Schema.NullOr(Schema.String),
      branch: Schema.String,
      worktreePath: Schema.NullOr(Schema.String),
      profile: Schema.Struct({
        cpuCores: Schema.Number,
        ramGiB: Schema.Number,
        diskGB: Schema.Number,
      }),
      phase: Schema.Literals(["heavy", "light"]),
      settled: Schema.Boolean,
      seq: Schema.Number,
      diskFromMeasurement: Schema.Boolean,
      measuredDiskGB: Schema.NullOr(Schema.Number),
      measuredAt: Schema.NullOr(Schema.Number),
      heavySince: Schema.NullOr(Schema.Number),
    }),
  ),
);
const decodeRecords = Schema.decodeUnknownEffect(RecordJson);
const encodeRecords = Schema.encodeEffect(RecordJson);

/** Whether a thread's turn counts as running for capacity: a turn or background work, but
    never a thread held on a human's question or permission prompt. */
export const capacityThreadRunning = (state: {
  readonly activeTurnRef: string | null;
  readonly backgroundWork: string | null;
  readonly waitingOnBackground: boolean;
  readonly awaitingUserInput: boolean;
  readonly awaitingPermission: boolean;
}) =>
  (state.activeTurnRef !== null || state.backgroundWork !== null || state.waitingOnBackground) &&
  !state.awaitingUserInput &&
  !state.awaitingPermission;

export const makeBoardWorkerCapacityLive = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const local = yield* LocalThreadGateway;
  const relays = yield* BoardRelayStore;
  // The board on this server registers its own threads at start: the engine is built
  // above this layer (it needs the thread gateway this service sits beside).
  let ownBoardThreads: Effect.Effect<ReadonlySet<string>> = Effect.succeed(new Set());
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ownBoardId = yield* Effect.flatMap(ServerEnvironment, (env) => env.getEnvironmentId);
  const registry = yield* Effect.serviceOption(ProviderRegistry);

  const ownerFor = (boardId: string): BoardWorktreeOwner =>
    boardId === ownBoardId ? "self" : boardWorktreeOwnerOf(boardId);

  const threads: WorkerCapacityPorts["threads"] = Effect.gen(function* () {
    const ids = yield* local.listLiveThreadIds().pipe(Effect.orElseSucceed(() => []));
    const ownThreads = yield* ownBoardThreads;
    const out: CapacityThread[] = [];
    for (const threadId of ids) {
      const state = yield* local.threadState(threadId).pipe(Effect.orElseSucceed(() => null));
      if (state === null || state.deleted) continue;
      const central = yield* relays
        .relayedThreadCentral(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      out.push({
        threadId,
        boardId: central ?? (ownThreads.has(threadId) ? ownBoardId : null),
        worktreePath: state.worktreePath,
        running: capacityThreadRunning(state),
        providerInstanceId: state.modelSelection?.instanceId ?? null,
      });
    }
    return out;
  });

  const repositoryKeys = Effect.gen(function* () {
    const projects = yield* local.projects().pipe(Effect.orElseSucceed(() => []));
    const keys = new Set<string>();
    for (const project of projects) {
      if (project.deleted) continue;
      const detail = yield* local.project(project.id).pipe(Effect.orElseSucceed(() => null));
      const key = boardRepositoryGroupingKey(detail?.repositoryIdentity ?? null);
      if (key !== null) keys.add(key);
    }
    return keys;
  });

  /** Sizes of unowned worktrees, kept five minutes: `status` is written every 5 s. */
  const sizes = new Map<string, { readonly at: number; readonly gb: number | null }>();
  const machine = yield* BoardMachine;
  const unownedWorktrees: WorkerCapacityPorts["unownedWorktrees"] = Effect.fn(
    "BoardWorkerCapacity.unownedWorktrees",
  )(function* (served) {
    const now = yield* Clock.currentTimeMillis;
    const projects = yield* local.projects().pipe(Effect.orElseSucceed(() => []));
    const out: Array<{ path: string; sizeGB: number | null; boardEnvironmentId: string | null }> =
      [];
    const seen = new Set<string>();
    for (const project of projects) {
      if (project.deleted || project.workspaceRoot.length === 0) continue;
      const listed = yield* git
        .execute({
          operation: "board.capacity.unowned",
          cwd: project.workspaceRoot,
          args: ["worktree", "list", "--porcelain"],
          allowNonZeroExit: true,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (listed === null || listed.exitCode !== 0) continue;
      for (const worktree of parseRegisteredWorktrees(listed.stdout).slice(1)) {
        if (worktree.prunable || seen.has(worktree.path)) continue;
        if (worktree.branch === null || !worktree.branch.startsWith("board/")) continue;
        seen.add(worktree.path);
        const owner = yield* boardWorktreeOwner({ git, fileSystem, path }, worktree.path);
        const boardId =
          owner === "legacy"
            ? null
            : owner !== null && owner.startsWith("board:")
              ? owner.slice("board:".length)
              : undefined;
        if (boardId === undefined || (boardId !== null && served.has(boardId))) continue;
        const cached = sizes.get(worktree.path);
        let gb = cached?.gb ?? null;
        if (cached === undefined || now - cached.at >= 5 * 60_000) {
          const bytes = yield* machine.diskUsageBytes(worktree.path);
          gb = bytes === null ? null : Math.round(bytesToGB(bytes) * 10) / 10;
          sizes.set(worktree.path, { at: now, gb });
        }
        out.push({ path: worktree.path, sizeGB: gb, boardEnvironmentId: boardId });
      }
    }
    return out;
  });

  const ports: WorkerCapacityPorts = {
    unownedWorktrees,
    settings: Effect.sync(() => {
      try {
        return resolveWorkerCapacitySettings(readWorkerFile(config.baseDir).config);
      } catch {
        return resolveWorkerCapacitySettings({});
      }
    }),
    threads,
    providers: Option.match(registry, {
      onNone: () => Effect.succeed([]),
      onSome: (service) => service.getProviders,
    }),
    refreshProviderUsage: (instanceId) =>
      Option.match(registry, {
        onNone: () => Effect.void,
        onSome: (service) =>
          service.refreshInstance(instanceId as ProviderInstanceId).pipe(Effect.asVoid),
      }),
    // Section 5 replaces this: a checkout of the repository counts as ready.
    notReady: (repositoryKey) =>
      repositoryKey === null
        ? Effect.succeed(null)
        : repositoryKeys.pipe(
            Effect.map((keys) =>
              keys.has(repositoryKey) ? null : "This worker has no checkout of the project.",
            ),
          ),
    readiness: repositoryKeys.pipe(
      Effect.map((keys) =>
        [...keys].map((repositoryKey): BoardWorkerReadiness => ({
          repositoryKey,
          path: DEFAULT_BOARD_READINESS_SCRIPT_PATH,
          state: "ready",
          version: null,
          checkedAt: null,
        })),
      ),
    ),
    worktreePresence: (boardId, entry) =>
      entry.worktreePath === null
        ? Effect.succeed("missing" as const)
        : adoptBoardWorktree({ git, fileSystem, path }, entry.worktreePath, ownerFor(boardId)),
    worktreeVolume: config.worktreesDir,
    store: {
      load: Effect.gen(function* () {
        const rows = yield* sql<{
          readonly boardId: string;
          readonly lastSeq: number | null;
          readonly records: string;
        }>`SELECT board_id AS "boardId", last_seq AS "lastSeq", records FROM board_worker_capacity`;
        const records: CapacityRecord[] = [];
        const lastSeq = new Map<string, number>();
        for (const row of rows) {
          if (row.lastSeq !== null) lastSeq.set(row.boardId, row.lastSeq);
          records.push(...(yield* decodeRecords(row.records).pipe(Effect.orElseSucceed(() => []))));
        }
        return { ...EMPTY_CAPACITY_STATE, records, lastSeq };
      }).pipe(Effect.orElseSucceed(() => EMPTY_CAPACITY_STATE)),
      saveBoard: Effect.fn("BoardWorkerCapacity.saveBoard")(
        function* (
          boardId: string,
          lastSeq: number | null,
          records: ReadonlyArray<CapacityRecord>,
        ) {
          const json = yield* encodeRecords(records);
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO board_worker_capacity (board_id, last_seq, records, updated_at)
            VALUES (${boardId}, ${lastSeq}, ${json}, ${now})
            ON CONFLICT (board_id) DO UPDATE SET
              last_seq = excluded.last_seq,
              records = excluded.records,
              updated_at = excluded.updated_at
          `;
        },
        (effect, boardId) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("worker capacity: records not saved", { boardId, cause }),
            ),
          ),
      ),
      deleteBoard: (boardId) =>
        sql`DELETE FROM board_worker_capacity WHERE board_id = ${boardId}`.pipe(Effect.ignore),
      setting: (key) =>
        sql<{ readonly value: string }>`
          SELECT value FROM board_worker_settings WHERE key = ${key}
        `.pipe(
          Effect.map((rows) => rows[0]?.value ?? null),
          Effect.orElseSucceed(() => null),
        ),
      saveSetting: (key, value) =>
        sql`
          INSERT INTO board_worker_settings (key, value) VALUES (${key}, ${value})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value
        `.pipe(Effect.ignore),
    },
  };
  const made = yield* makeBoardWorkerCapacity(ports);
  yield* Effect.forkScoped(made.background);
  return {
    ...made.service,
    registerLocalBoardThreads: (read) =>
      Effect.sync(() => {
        ownBoardThreads = read;
      }),
  } satisfies BoardWorkerCapacityShape;
});

export const BoardWorkerCapacityLive = Layer.effect(
  BoardWorkerCapacity,
  makeBoardWorkerCapacityLive,
);
