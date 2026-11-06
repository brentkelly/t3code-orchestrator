/**
 * Board migration 050 (T3O-72): the board's own usage-limit cooldowns retire.
 *
 * The provider-limit table goes, and a step parked on the retired
 * `quota-exhausted` reason reads as `gave-up` — the human-needed stall it
 * always was — instead of failing the row's schema on the next load.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 50;

const runBoardLineageThrough = (lastId: number) =>
  Effect.gen(function* () {
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , migration] of BOARD_MIGRATIONS) {
      if (id > lastId) break;
      yield* migration;
    }
  });

const insertStalledStep = (cardId: string, reason: string, retryAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_card_step_state (
        card_id, step_id, attempt, stall_count, prompt, provider_instance_id, model,
        mode, human_in_loop, max_attempts, timeout_ms, thread_id, status, slot_held,
        started_at, updated_at, stalled_reason, retry_at
      ) VALUES (
        ${cardId}, 'build', 1, 0, 'build it', 'claudeAgent', 'claude-opus',
        'build', 0, 5, 1800000, ${`thread-${cardId}`}, 'stalled', 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${reason}, ${retryAt}
      )
    `;
  });

it.effect("drops the provider-limit table and rewrites quota-exhausted parks to gave-up", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runBoardLineageThrough(MIGRATION_ID - 1);
    yield* sql`
      INSERT INTO boards.board_provider_limits (
        provider_instance_id, kind, until, detected_at, last_checked_at
      ) VALUES (
        'claudeAgent', 'wait', '2026-01-01T03:00:00.000Z',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* insertStalledStep("card-exhausted", "quota-exhausted", null);
    yield* insertStalledStep("card-limited", "usage-limit", "2026-01-01T03:10:00.000Z");

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 050 is registered in the lineage");
    yield* migration[2];

    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM boards.sqlite_master
      WHERE type = 'table' AND name = 'board_provider_limits'
    `;
    assert.deepStrictEqual(tables, []);

    const rows = yield* sql<{
      readonly cardId: string;
      readonly stalledReason: string;
      readonly retryAt: string | null;
    }>`
      SELECT card_id AS "cardId", stalled_reason AS "stalledReason", retry_at AS "retryAt"
      FROM board_card_step_state ORDER BY card_id
    `;
    assert.deepStrictEqual(rows, [
      { cardId: "card-exhausted", stalledReason: "gave-up", retryAt: null },
      // A usage-limit park is still the bridge's, and keeps its wake time.
      { cardId: "card-limited", stalledReason: "usage-limit", retryAt: "2026-01-01T03:10:00.000Z" },
    ]);

    // Re-running is a no-op rather than an error.
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
