/**
 * T3o: the board migration lineage was split out of upstream's shared
 * `effect_sql_migrations` ledger into its own `t3o_sql_migrations` table (board
 * ids restart at 1). Databases provisioned under the old "number from 900"
 * scheme carry board rows 900+ in the upstream ledger, which pins upstream's
 * high-water mark above every future upstream migration. `runBoardMigrations`
 * reconciles those databases on boot; this verifies it heals a legacy database
 * without replaying already-applied board migrations, and is idempotent.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { BOARD_MIGRATION_TABLE, BOARD_MIGRATIONS, runBoardMigrations } from "./index.ts";

const LEGACY_FLOOR = 900;
const expectedBoardIds = BOARD_MIGRATIONS.map(([id]) => id);
const legacyBoardIds = BOARD_MIGRATIONS.map(([id]) => LEGACY_FLOOR - 1 + id);

/** Reproduce a database as the old shared-ledger scheme left it. */
const seedLegacyDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Upstream schema + its ledger.
  yield* runMigrations();
  // Board tables applied the old way: run each migration effect, then record it
  // in the UPSTREAM ledger under its old 900+ id.
  for (const [id, name, migration] of BOARD_MIGRATIONS) {
    yield* migration;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${LEGACY_FLOOR - 1 + id}, ${name})
    `;
  }
});

describe("board migration reconciliation", () => {
  it.effect("heals a legacy 900+ database without replaying board migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyDatabase;

      // A row of real board data that must survive reconciliation untouched.
      yield* sql`
        INSERT INTO board_cards (card_id, project_id, title, created_at, updated_at)
        VALUES ('card-legacy', 'proj', 'Legacy card', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;

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

      // Reconcile. If any board migration were replayed (004 adds a column with an
      // unguarded ALTER TABLE), this would die — so completing at all is a proof.
      yield* runBoardMigrations();

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

      // Idempotent: a second boot changes nothing and does not error.
      yield* runBoardMigrations();
      const boardLedgerAgain = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM ${sql(BOARD_MIGRATION_TABLE)} ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        boardLedgerAgain.map((r) => r.migration_id),
        expectedBoardIds,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("runs the board lineage from 1 on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runBoardMigrations();

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
