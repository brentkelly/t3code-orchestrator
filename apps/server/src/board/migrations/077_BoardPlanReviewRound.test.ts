/**
 * Board migration 077: the step state's plan review round, end, armed and policy columns, and
 * the plans' `revised_in_round`, NULL on existing rows.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 77;
const NOW = "2026-01-01T00:00:00.000Z";

it.effect("adds the plan review columns as NULL on a populated database", () =>
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
        'plan', 1, 5, 1800000, 'thread-1', 'running', 0, ${NOW}, ${NOW}
      )
    `;
    yield* sql`
      INSERT INTO board_plans (
        plan_id, card_id, title, summary, depends_on, ordinal, locked, body, created_at, updated_at
      ) VALUES ('card-1::a', 'card-1', 'A', 'A plan', '[]', 0, 0, 'body', ${NOW}, ${NOW})
    `;

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 077 is registered in the lineage");
    yield* migration[2];
    const steps = yield* sql<Record<string, unknown>>`
      SELECT plan_review_round, plan_review_done_at, plan_review_awaiting_start,
        plan_review_policy_sent
      FROM board_card_step_state
    `;
    assert.deepStrictEqual(steps, [
      {
        plan_review_round: null,
        plan_review_done_at: null,
        plan_review_awaiting_start: null,
        plan_review_policy_sent: null,
      },
    ]);
    const plans = yield* sql<Record<string, unknown>>`SELECT revised_in_round FROM board_plans`;
    assert.deepStrictEqual(plans, [{ revised_in_round: null }]);
    // Re-running is a no-op rather than an error.
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
