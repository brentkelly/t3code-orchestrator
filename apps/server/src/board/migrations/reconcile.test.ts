/**
 * T3o: the board migration lineage was split out of upstream's shared
 * `effect_sql_migrations` ledger into its own `t3o_sql_migrations` table (board
 * ids restart at 1). Databases provisioned under the old "number from 900"
 * scheme carry board rows 900+ in the upstream ledger, which pins upstream's
 * high-water mark above every future upstream migration.
 *
 * `reconcileLegacyBoardLedger` (run before upstream migrations) evicts those rows
 * and seeds the already-applied board ids into the new ledger; `runBoardMigrations`
 * then runs whatever remains. These tests exercise the real boot sequence
 * (reconcile → runMigrations → runBoardMigrations) and verify it: heals a
 * fully-migrated legacy database WITHOUT replaying the one-time data backfill
 * (007), completes a PARTIALLY-migrated one, is idempotent, and runs cleanly on a
 * fresh database.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  BOARD_MIGRATION_TABLE,
  BOARD_MIGRATIONS,
  reconcileLegacyBoardLedger,
  runBoardMigrations,
} from "./index.ts";

const LEGACY_FLOOR = 900;
const expectedBoardIds = BOARD_MIGRATIONS.map(([id]) => id);
const legacyBoardIds = BOARD_MIGRATIONS.map(([id]) => LEGACY_FLOOR - 1 + id);

/** The exact server boot sequence (persistence/Layers/Sqlite.ts). */
const boot = Effect.gen(function* () {
  yield* reconcileLegacyBoardLedger();
  yield* runMigrations();
  yield* runBoardMigrations();
});

/**
 * Reproduce a database as the old shared-ledger scheme left it, having applied
 * the first `throughCount` board migrations (default: all of them). A count
 * below the total yields a partially-migrated legacy database.
 */
const seedLegacyDatabase = (throughCount: number = BOARD_MIGRATIONS.length) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Upstream schema + its ledger.
    yield* runMigrations();
    // Board tables applied the old way: run each migration effect, then record it
    // in the UPSTREAM ledger under its old 900+ id.
    for (const [id, name, migration] of BOARD_MIGRATIONS.slice(0, throughCount)) {
      yield* migration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${LEGACY_FLOOR - 1 + id}, ${name})
      `;
    }
  });

describe("board migration reconciliation", () => {
  it.effect("heals a fully-migrated legacy 900+ database without replaying data backfills", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyDatabase();

      // A row of real board data that must survive reconciliation untouched.
      yield* sql`
        INSERT INTO board_cards (card_id, project_id, title, created_at, updated_at)
        VALUES ('card-legacy', 'proj', 'Legacy card', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      // A user later removed a seed label (the projector hard-deletes the row).
      // Replaying migration 007 (INSERT OR IGNORE) would resurrect it — the split
      // must NOT re-run applied migrations, only evict + seed the ledger.
      yield* sql`DELETE FROM board_labels WHERE label_id = 'label-chore'`;

      // Precondition: legacy board rows sit in the upstream ledger; no board ledger yet.
      const legacyBefore = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id >= ${LEGACY_FLOOR} ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        legacyBefore.map((r) => r.migration_id),
        legacyBoardIds,
      );
      const boardTableBefore = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${BOARD_MIGRATION_TABLE}
      `;
      assert.strictEqual(boardTableBefore.length, 0);

      yield* boot;

      // Legacy rows evicted from the upstream ledger → upstream migrations resume.
      const legacyAfter = yield* sql`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id >= ${LEGACY_FLOOR}
      `;
      assert.strictEqual(legacyAfter.length, 0);

      // Board lineage now tracked in its own table at ids 1..N.
      const boardLedger = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM ${sql(BOARD_MIGRATION_TABLE)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        boardLedger.map((r) => r.migration_id),
        expectedBoardIds,
      );

      // Board data untouched.
      const cards = yield* sql<{ readonly card_id: string }>`
        SELECT card_id FROM board_cards ORDER BY card_id
      `;
      assert.deepStrictEqual(
        cards.map((r) => r.card_id),
        ["card-legacy"],
      );

      // 007 was NOT replayed: the user-removed seed label stays removed.
      const chore = yield* sql`SELECT label_id FROM board_labels WHERE label_id = 'label-chore'`;
      assert.strictEqual(chore.length, 0);

      // Idempotent: a second boot changes nothing and does not error.
      yield* boot;
      const boardLedgerAgain = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM ${sql(BOARD_MIGRATION_TABLE)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        boardLedgerAgain.map((r) => r.migration_id),
        expectedBoardIds,
      );
      const choreAgain =
        yield* sql`SELECT label_id FROM board_labels WHERE label_id = 'label-chore'`;
      assert.strictEqual(choreAgain.length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("completes a partially-migrated legacy database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Legacy database that only ran the first 6 board migrations (old ids
      // 900..905) — board_card_activity (8), board_card_steps (9), board_plans
      // (10) and the worktree column (11) do not exist yet.
      const applied = 6;
      yield* seedLegacyDatabase(applied);

      const missingBefore = yield* sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('board_card_activity', 'board_card_steps', 'board_plans')
      `;
      assert.strictEqual(missingBefore.length, 0);

      yield* boot;

      // Reconcile seeded only the 6 applied ids; the board Migrator then ran 7..11.
      // The ledger records the full lineage and the missing tables now exist — no
      // "no such column"/"no such table" left behind.
      const boardLedger = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM ${sql(BOARD_MIGRATION_TABLE)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        boardLedger.map((r) => r.migration_id),
        expectedBoardIds,
      );
      const presentAfter = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('board_card_activity', 'board_card_steps', 'board_plans')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        presentAfter.map((r) => r.name),
        ["board_card_activity", "board_card_steps", "board_plans"],
      );
      const worktreeColumn = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
      assert.ok(worktreeColumn.some((c) => c.name === "worktree"));

      // Upstream ledger cleared of legacy board rows.
      const legacyAfter = yield* sql`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id >= ${LEGACY_FLOOR}
      `;
      assert.strictEqual(legacyAfter.length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("runs the board lineage from 1 on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // reconcile runs before effect_sql_migrations exists — it must no-op cleanly.
      yield* boot;

      const boardLedger = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM ${sql(BOARD_MIGRATION_TABLE)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        boardLedger.map((r) => r.migration_id),
        expectedBoardIds,
      );

      const boardCards = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'board_cards'
      `;
      assert.strictEqual(boardCards.length, 1);

      // The board lineage never touches the upstream ledger.
      const upstreamHighRows = yield* sql`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id >= ${LEGACY_FLOOR}
      `;
      assert.strictEqual(upstreamHighRows.length, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
