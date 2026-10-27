/**
 * Board migration 031 (t3o-26): the board projector's watermark table, carried
 * over from upstream's `projection_state` when that table still exists.
 *
 * Upstream's migration 063 (v0.1.3) drops `main.projection_state`, so on a fresh
 * database the carry-over has nothing to read and must not fail the boot.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 31;

it.effect("creates the board watermark table on a database whose projection_state is gone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , migration] of BOARD_MIGRATIONS) {
      if (id > MIGRATION_ID) break;
      yield* migration;
    }

    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM boards.sqlite_schema WHERE type = 'table' AND name = 'projection_state'
    `;
    assert.deepStrictEqual(
      tables.map((table) => table.name),
      ["projection_state"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
