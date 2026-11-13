/**
 * Board migrations keep their own ledger (`t3o_sql_migrations`): effect's
 * `Migrator` keeps one high-water mark per table, so sharing upstream's would
 * silently skip lower-numbered upstream migrations.
 */
import * as Migrator from "effect/sql/Migrator";
import { backupBoardDatabaseBeforeV2 } from "../boardPreV2Backup.ts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { attachBoardDatabase, BOARD_SCHEMA, relocateBoardSchema } from "../boardDatabase.ts";

import Migration001 from "./001_BoardCards.ts";
import Migration002 from "./002_BoardCardBodies.ts";
import Migration003 from "./003_BoardCardThreadLinks.ts";
import Migration004 from "./004_BoardCardsColumns.ts";
import Migration005 from "./005_BoardLabels.ts";
import Migration006 from "./006_BoardCardLabels.ts";
import Migration007 from "./007_BoardCardLabelSeed.ts";
import Migration008 from "./008_BoardCardActivity.ts";
import Migration009 from "./009_BoardCardSteps.ts";
import Migration010 from "./010_BoardPlans.ts";
import Migration011 from "./011_BoardCardsWorktree.ts";
import Migration012 from "./012_BoardCardsRecomputeBlocked.ts";
import Migration013 from "./013_BoardCardStepState.ts";
import Migration014 from "./014_BoardStages.ts";
import Migration015 from "./015_BoardCardStepStall.ts";
import Migration016 from "./016_BoardCardsRecomputeBlockedBuildOnward.ts";
import Migration017 from "./017_BoardThreadTodos.ts";
import Migration018 from "./018_BoardCardActivityStructured.ts";
import Migration019 from "./019_BoardStagePlanRole.ts";
import Migration020 from "./020_BoardCardStepStateLabels.ts";
import Migration021 from "./021_BoardCardStepStateRuntimeMode.ts";
import Migration022 from "./022_BoardCardsPullRequest.ts";
import Migration023 from "./023_BoardStageMergeRole.ts";
import Migration024 from "./024_BoardCardsPullRequestHistory.ts";
import Migration025 from "./025_BoardCardsReviewOverrides.ts";
import Migration026 from "./026_BoardCardNumberFloor.ts";
import Migration027 from "./027_BoardCardsSourcePlan.ts";
import Migration028 from "./028_BoardCardStepStateBaseTip.ts";
import Migration029 from "./029_BoardCardsModelOverrides.ts";
import Migration030 from "./030_BoardCardStepStateLastError.ts";
import Migration031 from "./031_BoardProjectionState.ts";
import Migration032 from "./032_BoardCardAttachments.ts";
import Migration033 from "./033_BoardCardStepStateForceStart.ts";
import Migration034 from "./034_BoardCardStepStateAwaitingReason.ts";
import Migration035 from "./035_BoardCardsSplitRationale.ts";
import Migration036 from "./036_BoardCardsBaseBranch.ts";
import Migration037 from "./037_BoardCardStepStateStageEntryRecoveries.ts";
import Migration038 from "./038_BoardCardsScheduledStart.ts";
import Migration039 from "./039_BoardCardsAutoStart.ts";
import Migration040 from "./040_BoardCardStepStateHumanTurn.ts";
import Migration041 from "./041_BoardCardStepStateRetry.ts";
import Migration042 from "./042_BoardProviderLimits.ts";
import Migration043 from "./043_BoardCardsAutoMerge.ts";
import Migration044 from "./044_BoardEventLog.ts";
import Migration045 from "./045_BoardOrchestrationV2.ts";
import Migration046 from "./046_BoardWorkers.ts";
import Migration047 from "./047_BoardDistributedThreads.ts";
import Migration048 from "./048_BoardCardPlacement.ts";
import Migration049 from "./049_BoardCardPlacementOrphaned.ts";
import Migration050 from "./050_BoardDropProviderLimits.ts";
import Migration051 from "./051_BoardCardGroups.ts";
import Migration052 from "./052_BoardSplitGate.ts";
import Migration053 from "./053_BoardCardDecisions.ts";
import Migration054 from "./054_BoardCardsPlanReview.ts";
import Migration055 from "./055_BoardCardAutomation.ts";
import Migration056 from "./056_BoardThreadLinkRetired.ts";
import Migration057 from "./057_BoardCardsMergeStrategy.ts";
import Migration058 from "./058_BoardStagesProjectOwned.ts";
import Migration059 from "./059_BoardProjectStageConfigs.ts";
import Migration060 from "./060_BoardCi.ts";
import Migration061 from "./061_BoardStageDefaults.ts";
import Migration062 from "./062_BoardThreadLinkRound.ts";
import Migration063 from "./063_ScheduledTaskBoardActions.ts";
import Migration064 from "./064_BoardCardUsage.ts";
import Migration065 from "./065_BoardUsageNoUsageKey.ts";
import Migration066 from "./066_BoardUsageTurnsPartial.ts";
import Migration067 from "./067_BoardStepReopenedAt.ts";
import Migration068 from "./068_BoardWorkerJoin.ts";
import Migration069 from "./069_BoardCardsPriority.ts";

/** Ledger table for the board migration lineage, independent of upstream. */
export const BOARD_MIGRATION_TABLE = "t3o_sql_migrations";

/**
 * Qualified into the board database. The client splits on the dot; a single
 * quoted identifier would silently create a table literally named
 * `boards.t3o_sql_migrations` inside `main`.
 */
export const BOARD_MIGRATION_TABLE_QUALIFIED = `${BOARD_SCHEMA}.${BOARD_MIGRATION_TABLE}`;

/**
 * `main`, beside a legacy database's unrelocated board tables, so the relocation
 * copies ledger and tables together and a torn relocation reads as a resume.
 */
const LEGACY_SEED_TABLE = `main.${BOARD_MIGRATION_TABLE}`;

/** Ids the board lineage used before it was split into its own ledger. */
const LEGACY_BOARD_ID_FLOOR = 900;

export const BOARD_MIGRATIONS = [
  [1, "BoardCards", Migration001],
  [2, "BoardCardBodies", Migration002],
  [3, "BoardCardThreadLinks", Migration003],
  [4, "BoardCardsColumns", Migration004],
  [5, "BoardLabels", Migration005],
  [6, "BoardCardLabels", Migration006],
  [7, "BoardCardLabelSeed", Migration007],
  [8, "BoardCardActivity", Migration008],
  [9, "BoardCardSteps", Migration009],
  [10, "BoardPlans", Migration010],
  [11, "BoardCardsWorktree", Migration011],
  [12, "BoardCardsRecomputeBlocked", Migration012],
  [13, "BoardCardStepState", Migration013],
  [14, "BoardStages", Migration014],
  [15, "BoardCardStepStall", Migration015],
  [16, "BoardCardsRecomputeBlockedBuildOnward", Migration016],
  [17, "BoardThreadTodos", Migration017],
  [18, "BoardCardActivityStructured", Migration018],
  [19, "BoardStagePlanRole", Migration019],
  [20, "BoardCardStepStateLabels", Migration020],
  [21, "BoardCardStepStateRuntimeMode", Migration021],
  [22, "BoardCardsPullRequest", Migration022],
  [23, "BoardStageMergeRole", Migration023],
  [24, "BoardCardsPullRequestHistory", Migration024],
  [25, "BoardCardsReviewOverrides", Migration025],
  [26, "BoardCardNumberFloor", Migration026],
  [27, "BoardCardsSourcePlan", Migration027],
  [28, "BoardCardStepStateBaseTip", Migration028],
  [29, "BoardCardsModelOverrides", Migration029],
  [30, "BoardCardStepStateLastError", Migration030],
  [31, "BoardProjectionState", Migration031],
  [32, "BoardCardAttachments", Migration032],
  [33, "BoardCardStepStateForceStart", Migration033],
  [34, "BoardCardStepStateAwaitingReason", Migration034],
  [35, "BoardCardsSplitRationale", Migration035],
  [36, "BoardCardsBaseBranch", Migration036],
  [37, "BoardCardStepStateStageEntryRecoveries", Migration037],
  [38, "BoardCardsScheduledStart", Migration038],
  [39, "BoardCardsAutoStart", Migration039],
  [40, "BoardCardStepStateHumanTurn", Migration040],
  [41, "BoardCardStepStateRetry", Migration041],
  [42, "BoardProviderLimits", Migration042],
  [43, "BoardCardsAutoMerge", Migration043],
  [44, "BoardEventLog", Migration044],
  [45, "BoardOrchestrationV2", Migration045],
  [46, "BoardWorkers", Migration046],
  [47, "BoardDistributedThreads", Migration047],
  [48, "BoardCardPlacement", Migration048],
  [49, "BoardCardPlacementOrphaned", Migration049],
  [50, "BoardDropProviderLimits", Migration050],
  [51, "BoardCardGroups", Migration051],
  [52, "BoardSplitGate", Migration052],
  [53, "BoardCardDecisions", Migration053],
  [54, "BoardCardsPlanReview", Migration054],
  [55, "BoardCardAutomation", Migration055],
  [56, "BoardThreadLinkRetired", Migration056],
  [57, "BoardCardsMergeStrategy", Migration057],
  [58, "BoardStagesProjectOwned", Migration058],
  [59, "BoardProjectStageConfigs", Migration059],
  [60, "BoardCi", Migration060],
  [61, "BoardStageDefaults", Migration061],
  [62, "BoardThreadLinkRound", Migration062],
  [63, "ScheduledTaskBoardActions", Migration063],
  [64, "BoardCardUsage", Migration064],
  [65, "BoardUsageNoUsageKey", Migration065],
  [66, "BoardUsageTurnsPartial", Migration066],
  [67, "BoardStepReopenedAt", Migration067],
  [68, "BoardWorkerJoin", Migration068],
  [69, "BoardCardsPriority", Migration069],
] as const;

const boardLoader = Migrator.fromRecord(
  Object.fromEntries(BOARD_MIGRATIONS.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

/**
 * MUST run before upstream `runMigrations()`: legacy 900+ board rows pin
 * upstream's high-water mark. Seeds only the recorded ids rather than re-running
 * the lineage, because 007's data backfill would resurrect removed seed labels.
 * Idempotent.
 */
const reconcileLegacyBoardLedger = Effect.fn("reconcileLegacyBoardLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upstreamLedger = yield* sql<{ readonly name: string }>`
    SELECT name FROM main.sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (upstreamLedger.length === 0) return; // fresh database — nothing to reconcile

  const legacyRows = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM main.effect_sql_migrations
    WHERE migration_id >= ${LEGACY_BOARD_ID_FLOOR} ORDER BY migration_id
  `;
  if (legacyRows.length === 0) return; // already reconciled / never used the 900 scheme

  // Create the board ledger now so we can seed it before the board Migrator reads
  // its high-water mark (that Migrator would also CREATE IF NOT EXISTS).
  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(LEGACY_SEED_TABLE)} (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;

  const seeded = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM ${sql(LEGACY_SEED_TABLE)}
  `;
  if ((seeded[0]?.count ?? 0) === 0) {
    // Legacy id 900+k maps to new id k+1. Mark exactly those recorded ids applied
    // (and no more), so a partially-migrated database leaves its pending
    // migrations for the board Migrator to run.
    const nameById = new Map<number, string>(BOARD_MIGRATIONS.map(([id, name]) => [id, name]));
    const seedRows = legacyRows
      .map((row) => row.migration_id - (LEGACY_BOARD_ID_FLOOR - 1))
      .filter((id): id is number => nameById.has(id))
      .map((id) => ({ migration_id: id, name: nameById.get(id) as string }));
    if (Arr.isArrayNonEmpty(seedRows)) {
      yield* sql`INSERT INTO ${sql(LEGACY_SEED_TABLE)} ${sql.insert(seedRows)}`;
    }
  }

  yield* sql`DELETE FROM main.effect_sql_migrations WHERE migration_id >= ${LEGACY_BOARD_ID_FLOOR}`;
  yield* Effect.log("Reconciled legacy board migration ledger").pipe(
    Effect.annotateLogs({ evicted: legacyRows.length, table: LEGACY_SEED_TABLE }),
  );
});

/**
 * Runs before upstream `runMigrations()`. The ledger is reconciled before the
 * relocation, which copies ledger and tables together; reconciling after would
 * leave a torn legacy relocation with no ledger on either side, refused forever.
 */
export const initialiseBoardDatabase = Effect.fn("initialiseBoardDatabase")(function* () {
  yield* attachBoardDatabase();
  // Before anything below writes to it.
  yield* backupBoardDatabaseBeforeV2();
  yield* reconcileLegacyBoardLedger();
  yield* relocateBoardSchema();
});

/**
 * Run pending board migrations against the `t3o_sql_migrations` ledger.
 *
 * Run AFTER upstream `runMigrations()` (upstream tables exist first) and AFTER
 * `reconcileLegacyBoardLedger()` (which seeds already-applied board ids).
 */
export const runBoardMigrations = Effect.fn("runBoardMigrations")(function* () {
  const executedMigrations = yield* run({
    loader: boardLoader,
    table: BOARD_MIGRATION_TABLE_QUALIFIED,
  });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Board schema is current")
    : Effect.log("Board migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
