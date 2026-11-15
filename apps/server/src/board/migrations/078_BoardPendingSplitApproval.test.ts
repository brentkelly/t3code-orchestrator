/** Board migration 078: the card's `pending_split_approval`, NULL on existing rows. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 78;
const NOW = "2026-01-01T00:00:00.000Z";

it.effect("adds pending_split_approval as NULL on a populated database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , migration] of BOARD_MIGRATIONS) {
      if (id >= MIGRATION_ID) break;
      yield* migration;
    }
    yield* sql`
      INSERT INTO board_cards (card_id, project_id, title, stage, created_at, updated_at)
      VALUES ('card-1', 'proj', 'Card', 'planning', ${NOW}, ${NOW})
    `;
    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 078 is registered in the lineage");
    yield* migration[2];
    const rows = yield* sql<Record<string, unknown>>`
      SELECT pending_split_approval FROM board_cards
    `;
    assert.deepStrictEqual(rows, [{ pending_split_approval: null }]);
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
