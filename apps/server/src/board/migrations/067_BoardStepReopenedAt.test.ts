/**
 * Board migration 062: the step state's `reopened_at` column, NULL on existing rows.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 62;
const NOW = "2026-01-01T00:00:00.000Z";

it.effect("adds reopened_at as NULL on a populated database", () =>
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
    yield* sql`
      INSERT INTO board_card_step_state (
        card_id, step_id, attempt, stall_count, prompt, provider_instance_id, model,
        mode, human_in_loop, max_attempts, timeout_ms, thread_id, status, slot_held,
        started_at, updated_at
      ) VALUES (
        'card-1', 'planning', 1, 0, 'plan it', 'codex', 'gpt-5-codex',
        'plan', 1, 5, 1800000, 'thread-1', 'succeeded', 0, ${NOW}, ${NOW}
      )
    `;

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 062 is registered in the lineage");
    yield* migration[2];
    const steps = yield* sql<{ readonly reopenedAt: string | null }>`
      SELECT reopened_at AS "reopenedAt" FROM board_card_step_state
    `;
    assert.deepStrictEqual(steps, [{ reopenedAt: null }]);
    // Re-running is a no-op rather than an error.
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
