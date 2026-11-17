/** Board migration 080: the t3o.json schedule store's tables (T3O-117). */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

it.effect("creates the schedule store, its run threads and the cards its runs touch", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [, , migration] of BOARD_MIGRATIONS) yield* migration;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM boards.sqlite_master WHERE type = 'table' AND name IN (
        'project_schedules', 'schedule_run_threads', 'schedule_created_cards', 'schedule_touched_cards'
      ) ORDER BY name
    `;
    assert.deepStrictEqual(
      tables.map((table) => table.name),
      [
        "project_schedules",
        "schedule_created_cards",
        "schedule_run_threads",
        "schedule_touched_cards",
      ],
    );
    const columns = yield* sql<{
      readonly name: string;
    }>`PRAGMA boards.table_info(project_schedules)`;
    assert.includeMembers(
      columns.map((column) => column.name),
      ["task_id", "applied_json", "environment_id", "missing", "tombstone", "export_linked"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
