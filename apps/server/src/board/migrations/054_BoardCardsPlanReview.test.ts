/**
 * Board migration 054 (plan review): the card's plan-review column and
 * the step state's review columns, all NULL on existing rows.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 54;
const NOW = "2026-01-01T00:00:00.000Z";

const runBoardLineageThrough = (lastId: number) =>
  Effect.gen(function* () {
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , migration] of BOARD_MIGRATIONS) {
      if (id > lastId) break;
      yield* migration;
    }
  });

it.effect("adds the plan-review columns as NULL on a populated database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runBoardLineageThrough(MIGRATION_ID - 1);

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
        'plan', 1, 5, 1800000, 'thread-1', 'running', 1, ${NOW}, ${NOW}
      )
    `;

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 054 is registered in the lineage");
    yield* migration[2];

    const cards = yield* sql<{ readonly planReview: string | null }>`
      SELECT plan_review AS "planReview" FROM board_cards
    `;
    assert.deepStrictEqual(cards, [{ planReview: null }]);
    const steps = yield* sql<{
      readonly startedAt: string | null;
      readonly rounds: number | null;
    }>`
      SELECT plan_review_started_at AS "startedAt", plan_review_rounds AS "rounds"
      FROM board_card_step_state
    `;
    assert.deepStrictEqual(steps, [{ startedAt: null, rounds: null }]);

    // Re-running is a no-op rather than an error.
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
