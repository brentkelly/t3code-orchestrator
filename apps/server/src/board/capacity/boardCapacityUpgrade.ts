/**
 * The one-time upgrade from the board's concurrency ceilings to worker-owned capacity
 * (T3O-86). It can't be a SQL migration: worker capacity only arrives in snapshots, and the
 * old limits live in board settings. It runs once, on the first snapshots from `local` and
 * every worker live at boot (waiting at most 60 s), and records completion in a board table.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_RESOURCE_DIMENSIONS,
  BOARD_RESOURCE_PROFILE_KEYS,
  boardCardStepState,
  boardProjectStageConfig,
  DEFAULT_BOARD_PROJECT_BASELINE,
  EMPTY_BOARD_PROJECT_RESOURCES,
  resolveBoardWorkerConcurrency,
  type BoardCommand,
  type BoardConcurrencySettings,
  type BoardResourceProfile,
  type BoardState,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import type { BoardCapacityClientShape } from "./BoardCapacityClient.ts";
import {
  ciActive,
  requestedProfileOf,
  stepActiveInWorktree,
  stepQueuedInWorktree,
} from "./boardCapacityAdmission.ts";

const UPGRADE_ID = "t3o-86";
/** Room left beside the n old builds for planning threads and a human's own turn. */
const UPGRADE_SHARE = 0.9;

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The declared baseline that keeps the old throttle: per dimension, the largest of
 * 0.9 x capacity(w) / n(w) over the workers that reported, n(w) being the worker's old limit,
 * else the board's. Disk keeps the placeholder. Null when no worker reported.
 */
export function upgradeBaseline(input: {
  readonly concurrency: BoardConcurrencySettings;
  readonly snapshots: ReadonlyMap<BoardWorkerId, BoardWorkerCapacitySnapshot>;
}): BoardResourceProfile | null {
  if (input.snapshots.size === 0) return null;
  const best: Record<"cpuCores" | "ramGiB", number> = { cpuCores: 0, ramGiB: 0 };
  for (const [workerId, snapshot] of input.snapshots) {
    const limit =
      resolveBoardWorkerConcurrency(input.concurrency, workerId).maxConcurrent ??
      input.concurrency.globalMaxConcurrent;
    const n = Math.max(1, limit);
    for (const dimension of BOARD_RESOURCE_DIMENSIONS) {
      if (dimension === "disk") continue;
      const key = BOARD_RESOURCE_PROFILE_KEYS[dimension] as "cpuCores" | "ramGiB";
      best[key] = Math.max(best[key], round2((UPGRADE_SHARE * snapshot.declared[key]) / n));
    }
  }
  return {
    cpuCores: best.cpuCores,
    ramGiB: best.ramGiB,
    diskGB: DEFAULT_BOARD_PROJECT_BASELINE.diskGB,
  };
}

export interface BoardCapacityUpgradeDeps {
  readonly sql: SqlClient.SqlClient;
  readonly client: BoardCapacityClientShape;
  readonly readBoard: Effect.Effect<BoardState>;
  readonly concurrency: Effect.Effect<BoardConcurrencySettings>;
  /** Workers whose tunnel is live now. */
  readonly liveWorkers: Effect.Effect<ReadonlyArray<BoardWorkerId>>;
  readonly dispatch: (command: BoardCommand) => Effect.Effect<boolean>;
  readonly commandId: (tag: string) => Effect.Effect<BoardCommand["commandId"]>;
  readonly nowIso: Effect.Effect<string>;
}

const capacityUpgradeDone = (sql: SqlClient.SqlClient) =>
  sql<{ readonly id: string }>`
    SELECT id FROM board_capacity_upgrade WHERE id = ${UPGRADE_ID}
  `.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.orElseSucceed(() => false),
  );

/** Run the upgrade unless it has run; true once it has. */
export const runBoardCapacityUpgrade = Effect.fn("runBoardCapacityUpgrade")(function* (
  deps: BoardCapacityUpgradeDeps,
) {
  if (yield* capacityUpgradeDone(deps.sql)) return true;
  const expected = [BOARD_LOCAL_WORKER_ID, ...(yield* deps.liveWorkers)];
  const allReported = deps.client.all.pipe(
    Effect.map((all) => expected.every((workerId) => all.has(workerId))),
  );
  if (!(yield* allReported)) {
    yield* deps.client.changes.pipe(
      Stream.mapEffect(() => allReported),
      Stream.takeUntil((done) => done),
      Stream.runDrain,
      Effect.timeoutOption("60 seconds"),
    );
  }
  const all = yield* deps.client.all;
  const snapshots = new Map(
    expected.flatMap((workerId) => {
      const snapshot = all.get(workerId);
      return snapshot === undefined ? [] : [[workerId, snapshot] as const];
    }),
  );
  // Not even `local` reported: try again on the next pass.
  if (!snapshots.has(BOARD_LOCAL_WORKER_ID)) return false;
  const board = yield* deps.readBoard;
  const baseline = upgradeBaseline({ concurrency: yield* deps.concurrency, snapshots });

  // 1. Baselines, so the upgrade doesn't remove the only throttle.
  const projects = new Set<ProjectId>(
    board.cards.filter((card) => card.archivedAt === null).map((card) => card.projectId),
  );
  // A command that didn't land leaves the marker unwritten: the next pass finishes the job,
  // skipping what did land.
  let landed = true;
  for (const projectId of projects) {
    const config = boardProjectStageConfig(board, projectId);
    const resources = config?.resources ?? EMPTY_BOARD_PROJECT_RESOURCES;
    if (resources.baseline !== null || baseline === null) continue;
    const set = yield* deps.dispatch({
      type: "board.project.set-resources",
      commandId: yield* deps.commandId("upgrade-baseline"),
      projectId,
      resources: { ...resources, baseline: { ...baseline, setAtUpgrade: true } },
      createdAt: yield* deps.nowIso,
    });
    landed = landed && set;
  }

  // 2. Every card holding a worktree is granted baseline x its size, heavy by the phase rule.
  const after = yield* deps.readBoard;
  for (const card of after.cards) {
    if (card.group !== null || card.worktree === null) continue;
    if (card.worktree.status !== "provisioning" && card.worktree.status !== "ready") continue;
    if (card.resources?.grant != null) continue;
    const state = boardCardStepState(after, card.id);
    const recorded = yield* deps.dispatch({
      type: "board.card.record-grant",
      commandId: yield* deps.commandId("upgrade-backfill"),
      cardId: card.id,
      profile: requestedProfileOf(after, card),
      heavy: stepActiveInWorktree(state) || stepQueuedInWorktree(state) || ciActive(card),
      settled: true,
      createdAt: yield* deps.nowIso,
    });
    landed = landed && recorded;
  }

  if (!landed) return false;
  yield* deps.sql`
    INSERT INTO board_capacity_upgrade (id, completed_at) VALUES (${UPGRADE_ID}, ${yield* deps.nowIso})
    ON CONFLICT (id) DO NOTHING
  `.pipe(Effect.ignore);
  return true;
});
