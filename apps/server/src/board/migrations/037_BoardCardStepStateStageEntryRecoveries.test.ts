/**
 * Board migration 037 (T3O-12, D4/D8): the stage entry's RECOVERY total on the
 * step-state row.
 *
 * The point of the test is the DEFAULT. The runaway ceiling used to be read off
 * `attempt`, which every planned review-phase selection carried forward, so a
 * long loop's counter was permanently past the ceiling and every card in that
 * state escalated its first stall instantly. Defaulting the new column to 0 is
 * what un-wedges those cards on upgrade, so a row written before the column
 * existed has to read as "this stage entry has spent nothing on recovery" —
 * not NULL, which would fail the row's schema, and not a backfill from
 * `attempt`, which would carry the bug forward.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 37;

/** Run the board lineage up to (and optionally including) one migration. */
const runBoardLineageThrough = (lastId: number) =>
  Effect.gen(function* () {
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , migration] of BOARD_MIGRATIONS) {
      if (id > lastId) break;
      yield* migration;
    }
  });

it.effect("a step-state row written before 037 reads a recovery total of 0", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runBoardLineageThrough(MIGRATION_ID - 1);

    // A card mid-flight when the server was upgraded: the shape the old ceiling
    // had already blown, with `attempt` far past `max_attempts`.
    yield* sql`
      INSERT INTO board_card_step_state (
        card_id, step_id, attempt, stall_count, prompt, provider_instance_id, model,
        mode, human_in_loop, max_attempts, timeout_ms, thread_id, status, slot_held,
        started_at, updated_at
      ) VALUES (
        'card-1', 'review@10', 45, 1, 'review it', 'codex', 'gpt-5-codex',
        'build', 0, 5, 1800000, 'thread-1', 'running', 1,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 037 is registered in the lineage");
    yield* migration[2];

    const columns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(board_card_step_state)
    `;
    assert.ok(columns.some((column) => column.name === "stage_entry_recoveries"));

    const rows = yield* sql<{
      readonly attempt: number;
      readonly stage_entry_recoveries: number;
    }>`SELECT attempt, stage_entry_recoveries FROM board_card_step_state`;
    assert.strictEqual(rows.length, 1);
    // Not backfilled from `attempt` (D8): the card's blown counter is exactly
    // what has to go away, so it starts over at zero and the card stops being
    // falsely escalated the moment the server restarts.
    assert.strictEqual(rows[0]?.attempt, 45);
    assert.strictEqual(rows[0]?.stage_entry_recoveries, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("a row written after 037 without the column still defaults to 0", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runBoardLineageThrough(MIGRATION_ID);

    yield* sql`
      INSERT INTO board_card_step_state (
        card_id, step_id, attempt, stall_count, prompt, provider_instance_id, model,
        mode, human_in_loop, max_attempts, timeout_ms, thread_id, status, slot_held,
        started_at, updated_at
      ) VALUES (
        'card-2', 'building', 1, 0, 'build it', 'codex', 'gpt-5-codex',
        'build', 0, 5, 1800000, 'thread-2', 'running', 1,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;

    // NOT NULL with a default, so the column can never be read as null — which
    // is what lets the read model type it as a plain number.
    const rows = yield* sql<{ readonly stage_entry_recoveries: number }>`
      SELECT stage_entry_recoveries FROM board_card_step_state WHERE card_id = 'card-2'
    `;
    assert.strictEqual(rows[0]?.stage_entry_recoveries, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
