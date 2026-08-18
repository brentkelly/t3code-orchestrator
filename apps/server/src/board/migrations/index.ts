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
] as const;

const boardLoader = Migrator.fromRecord(
  Object.fromEntries(BOARD_MIGRATIONS.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

/**
 * Reconcile databases provisioned under the old shared-ledger scheme.
 *
 * Idempotent: safe to run on every boot. A no-op on a fresh database or one
 * already migrated to the split scheme.
 */
const reconcileLegacyLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Board migrations were once numbered 900+ and recorded in upstream's
  // `effect_sql_migrations` ledger, which pins upstream's high-water mark above
  // every later (lower-numbered) upstream migration. Evict those rows so upstream
  // migrations resume; the board lineage is tracked in `t3o_sql_migrations` from
  // here on, and its own Migrator (below) creates that table.
  //
  // No ledger backfill is needed. Every board migration is idempotent (CREATE
  // TABLE/INDEX IF NOT EXISTS, PRAGMA-guarded ADD COLUMN, INSERT OR IGNORE), so
  // the board Migrator simply re-runs the lineage against the fresh ledger: a
  // no-op wherever the schema already exists, and — crucially — it completes a
  // PARTIALLY-migrated legacy database the rest of the way. (Backfilling the
  // ledger instead would mark a partial database's not-yet-run migrations as
  // applied and skip them, reintroducing the "no such column" crash.)
  const legacyRows = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM effect_sql_migrations WHERE migration_id >= ${LEGACY_BOARD_ID_FLOOR}
  `;
  if (legacyRows.length > 0) {
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${LEGACY_BOARD_ID_FLOOR}`;
    yield* Effect.log("Evicted legacy board rows from the upstream migration ledger").pipe(
      Effect.annotateLogs({ evicted: legacyRows.length, floor: LEGACY_BOARD_ID_FLOOR }),
    );
  }
});

/**
 * Run pending board migrations against the `t3o_sql_migrations` ledger.
 *
 * Must run AFTER upstream `runMigrations()` so upstream tables (and the
 * `effect_sql_migrations` ledger the reconciliation reads) already exist.
 */
export const runBoardMigrations = Effect.fn("runBoardMigrations")(function* () {
  yield* reconcileLegacyLedger;
  const executedMigrations = yield* run({ loader: boardLoader, table: BOARD_MIGRATION_TABLE });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Board schema is current")
    : Effect.log("Board migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
