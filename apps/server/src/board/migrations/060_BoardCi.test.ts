/**
 * Board migration 060: the CI seed stage row, the card's CI columns
 * and the CI pass table.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const migration = (id: number) => BOARD_MIGRATIONS.find(([candidate]) => candidate === id)![2];

it.effect("seeds the CI stage once, and adds the card CI columns and pass table", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , step] of BOARD_MIGRATIONS) {
      if (id > 59) break;
      yield* step;
    }

    yield* migration(60);

    const stages = yield* sql<{ readonly stageId: string; readonly orderKey: string }>`
      SELECT stage_id AS "stageId", order_key AS "orderKey" FROM board_stages ORDER BY order_key
    `;
    assert.deepStrictEqual(
      stages.map((stage) => stage.stageId),
      ["backlog", "sprint", "planning", "ready", "building", "review", "ci", "merge", "done"],
    );

    // A renamed CI row survives a re-run untouched, and nothing is duplicated.
    yield* sql`UPDATE board_stages SET label = 'Checks' WHERE stage_id = 'ci'`;
    yield* migration(60);
    const ci = yield* sql<{ readonly label: string }>`
      SELECT label FROM board_stages WHERE stage_id = 'ci'
    `;
    assert.deepStrictEqual(
      ci.map((row) => row.label),
      ["Checks"],
    );

    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
    assert.isTrue(columns.some((column) => column.name === "ci"));
    assert.isTrue(columns.some((column) => column.name === "ci_last_outcome"));

    yield* sql`
      INSERT INTO board_ci_passes (run_id, card_id, entry, ordinal, started_at, steps)
      VALUES ('run-1', 'card-1', 1, 1, '2026-01-01T00:00:00.000Z', '[]')
    `;
    const [passes] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM board_ci_passes`;
    assert.strictEqual(passes?.n, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
