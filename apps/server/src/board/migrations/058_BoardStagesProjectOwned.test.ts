/**
 * Board migrations 058 and 059 (T3O-43): project-owned stage rows and the
 * per-project stage config table.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const migration = (id: number) => BOARD_MIGRATIONS.find(([candidate]) => candidate === id)![2];

it.effect("adds a nullable project_id to stages and the project stage config table", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , step] of BOARD_MIGRATIONS) {
      if (id > 57) break;
      yield* step;
    }

    yield* migration(58);
    yield* migration(59);

    const stages = yield* sql<{ readonly stageId: string; readonly projectId: string | null }>`
      SELECT stage_id AS "stageId", project_id AS "projectId" FROM board_stages
    `;
    assert.isAbove(stages.length, 0);
    assert.isTrue(stages.every((stage) => stage.projectId === null));

    yield* sql`
      INSERT INTO board_stages (stage_id, label, role, order_key, created_at, updated_at, project_id)
      VALUES ('p:security', 'Security', NULL, 'm', '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z', 'p')
    `;
    yield* sql`
      INSERT INTO board_project_stage_configs (project_id, config_json, updated_at)
      VALUES ('p', '{}', '2026-01-01T00:00:00.000Z')
    `;

    // Re-running both is a no-op rather than an error.
    yield* migration(58);
    yield* migration(59);
    const [owned] = yield* sql<{ readonly projectId: string | null }>`
      SELECT project_id AS "projectId" FROM board_stages WHERE stage_id = 'p:security'
    `;
    assert.strictEqual(owned?.projectId, "p");
    const [configs] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM board_project_stage_configs
    `;
    assert.strictEqual(configs?.n, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
