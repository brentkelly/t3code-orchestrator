/**
 * T3o board migration lineage.
 *
 * Board migrations are tracked in their OWN ledger table (`t3o_sql_migrations`),
 * separate from upstream's `effect_sql_migrations`. This is deliberate: effect's
 * `Migrator` advances a single high-water mark per table and skips any migration
 * whose id is <= that mark. Sharing one table with upstream (the old "number
 * board migrations from 900" scheme) meant that once a board migration ran, every
 * later upstream migration — all numbered below 900 — was silently skipped. Two
 * tables give the two lineages independent high-water marks, so board ids restart
 * at 1 and never interfere with upstream numbering again.
 *
 * New board migrations: add `NNN_Name.ts` here and append it to BOARD_MIGRATIONS.
 */
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

/** Ledger table for the board migration lineage, independent of upstream. */
export const BOARD_MIGRATION_TABLE = "t3o_sql_migrations";

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
] as const;

const boardLoader = Migrator.fromRecord(
  Object.fromEntries(BOARD_MIGRATIONS.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

/**
 * Reconcile a database provisioned under the old shared-ledger scheme, in which
 * board migrations were numbered 900+ and recorded in upstream's
 * `effect_sql_migrations`.
 *
 * MUST run BEFORE upstream `runMigrations()`: while the legacy rows are present
 * they pin upstream's high-water mark to the top board id (e.g. 910), so on that
 * first boot upstream would skip every pending migration numbered below it — the
 * exact "no such column" crash this split fixes.
 *
 * Maps each recorded legacy board id back to its new id and marks it applied in
 * `t3o_sql_migrations`, then evicts the legacy rows. Seeding the already-applied
 * ids (rather than letting the board Migrator re-run the whole lineage) is
 * deliberate: migration 007 is a one-time DATA backfill, and replaying it would
 * resurrect seed labels a user has since removed. Seeding ONLY the ids the legacy
 * ledger actually recorded keeps a PARTIALLY-migrated database correct too — its
 * not-yet-run migrations stay unseeded, so the board Migrator runs them normally.
 *
 * Idempotent: a no-op on a fresh database (no `effect_sql_migrations` yet) or one
 * already migrated to the split scheme (no legacy rows left).
 */
export const reconcileLegacyBoardLedger = Effect.fn("reconcileLegacyBoardLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upstreamLedger = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (upstreamLedger.length === 0) return; // fresh database — nothing to reconcile

  const legacyRows = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM effect_sql_migrations
    WHERE migration_id >= ${LEGACY_BOARD_ID_FLOOR} ORDER BY migration_id
  `;
  if (legacyRows.length === 0) return; // already reconciled / never used the 900 scheme

  // Create the board ledger now so we can seed it before the board Migrator reads
  // its high-water mark (that Migrator would also CREATE IF NOT EXISTS).
  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(BOARD_MIGRATION_TABLE)} (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;

  const seeded = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM ${sql(BOARD_MIGRATION_TABLE)}
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
    if (seedRows.length > 0) {
      yield* sql`INSERT INTO ${sql(BOARD_MIGRATION_TABLE)} ${sql.insert(seedRows)}`;
    }
  }

  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${LEGACY_BOARD_ID_FLOOR}`;
  yield* Effect.log("Reconciled legacy board migration ledger").pipe(
    Effect.annotateLogs({ evicted: legacyRows.length, table: BOARD_MIGRATION_TABLE }),
  );
});

/**
 * Run pending board migrations against the `t3o_sql_migrations` ledger.
 *
 * Run AFTER upstream `runMigrations()` (upstream tables exist first) and AFTER
 * `reconcileLegacyBoardLedger()` (which seeds already-applied board ids).
 */
export const runBoardMigrations = Effect.fn("runBoardMigrations")(function* () {
  const executedMigrations = yield* run({ loader: boardLoader, table: BOARD_MIGRATION_TABLE });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Board schema is current")
    : Effect.log("Board migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
