/**
 * Board migration 061 (T3O-49): the stage default column, the CI pass
 * snapshot columns, re-keyed duplicate order keys, and stages moved out from
 * between CI and the merge stage.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const migration = (id: number) => BOARD_MIGRATIONS.find(([candidate]) => candidate === id)![2];

it.effect("adds the columns and puts every stage in one valid order", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , step] of BOARD_MIGRATIONS) {
      if (id > 60) break;
      yield* step;
    }
    const at = "2026-01-01T00:00:00.000Z";
    // Three T3O-43 project stages added after review share a key, and one was
    // added after CI.
    yield* sql`
      INSERT INTO board_stages (stage_id, label, role, order_key, created_at, updated_at, project_id)
      VALUES
        ('p1:qa', 'QA', NULL, 'lm', ${at}, ${at}, 'p1'),
        ('p2:qa', 'QA', NULL, 'lm', ${at}, ${at}, 'p2'),
        ('p3:qa', 'QA', NULL, 'lm', ${at}, ${at}, 'p3'),
        ('p1:late', 'Late', NULL, 'mm', ${at}, ${at}, 'p1')
    `;

    yield* migration(61);
    yield* migration(61);

    const stages = yield* sql<{ readonly stageId: string; readonly orderKey: string }>`
      SELECT stage_id AS "stageId", order_key AS "orderKey" FROM board_stages ORDER BY order_key, stage_id
    `;
    assert.deepStrictEqual(
      stages.map((stage) => stage.stageId),
      [
        "backlog",
        "sprint",
        "planning",
        "ready",
        "building",
        "review",
        "p1:qa",
        "p2:qa",
        "p3:qa",
        "p1:late",
        "ci",
        "merge",
        "done",
      ],
    );
    assert.strictEqual(new Set(stages.map((stage) => stage.orderKey)).size, stages.length);

    const stageColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_stages)`;
    assert.isTrue(stageColumns.some((column) => column.name === "default_for_projects"));
    const passColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_ci_passes)`;
    assert.isTrue(passColumns.some((column) => column.name === "snapshot"));
    assert.isTrue(passColumns.some((column) => column.name === "config_version"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
