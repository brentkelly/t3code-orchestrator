/**
 * T3o migration 020 (t3o-19, D4/D5): `board_card_step_state.step_label` becomes
 * nullable and `stage_label` is added.
 *
 * The rebuild is the risk — SQLite has no ALTER COLUMN, so relaxing NOT NULL
 * means create-copy-drop-rename, and a copy that forgot a column added by 014
 * or 015 would silently discard a running card's frozen execution config. These
 * lock the shape: every column survives with its value, history is not rewritten
 * (D7), and a null step label can now be written where it could not before.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { BOARD_MIGRATIONS } from "./index.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import Migration020 from "./020_BoardCardStepStateLabels.ts";

const NOW = "2026-01-01T00:00:00.000Z";

/** Everything up to (but not including) 020, applied directly — 014's ALTERs
    are not idempotent, so the lineage is run once, by hand, exactly as 016's
    test does. */
const migrateToPrevious = Effect.gen(function* () {
  // T3o-26: board tables live in the attached board database now, so the
  // attach has to happen before any board migration, exactly as at boot.
  yield* attachBoardDatabase();
  yield* runMigrations();
  for (const [id, , migration] of BOARD_MIGRATIONS) {
    if (id >= 20) break;
    yield* migration;
  }
});

/** A pre-020 run row: `step_label` non-null (it had to be), every 014/015
    column populated with a value distinguishable from its DEFAULT so a copy
    that dropped the column would be caught. */
const insertLegacyRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO board_card_step_state (
      card_id, step_id, step_label, attempt, max_attempts, thread_id, status,
      slot_held, started_at, updated_at, prompt, provider_instance_id, model,
      mode, human_in_loop, timeout_ms, stall_count, last_nudge_at
    ) VALUES (
      'card-legacy', 'building', 'Building', 3, 5, 'thread-7', 'running',
      1, ${NOW}, ${NOW}, 'Implement the brief.', 'codex', 'gpt-5-codex',
      'build', 1, 600000, 2, ${NOW}
    )
  `;
});

describe("migration 020: nullable step label + frozen stage label", () => {
  it.effect("carries every column of a pre-020 row through the table rebuild", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrateToPrevious;
      yield* insertLegacyRow;

      yield* Migration020;

      const rows = yield* sql<Record<string, unknown>>`
        SELECT * FROM board_card_step_state WHERE card_id = 'card-legacy'
      `;
      assert.strictEqual(rows.length, 1);
      // Every 013/014/015 column, by value — a rebuild that omitted one from
      // its copy list would reset it to the column DEFAULT, not lose the row.
      assert.deepStrictEqual(rows[0], {
        card_id: "card-legacy",
        step_id: "building",
        // D7: history is NOT rewritten. The legacy row keeps the label it
        // recorded, so it renders exactly as it did before this migration.
        step_label: "Building",
        // New column: null on every pre-existing row.
        stage_label: null,
        attempt: 3,
        max_attempts: 5,
        thread_id: "thread-7",
        status: "running",
        slot_held: 1,
        started_at: NOW,
        updated_at: NOW,
        prompt: "Implement the brief.",
        provider_instance_id: "codex",
        model: "gpt-5-codex",
        mode: "build",
        human_in_loop: 1,
        timeout_ms: 600000,
        stall_count: 2,
        last_nudge_at: NOW,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("accepts a null step label, which the NOT NULL column rejected", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrateToPrevious;

      // Before: the whole reason for the rebuild.
      const before = yield* Effect.exit(sql`
        INSERT INTO board_card_step_state (
          card_id, step_id, step_label, attempt, max_attempts, status, slot_held, updated_at
        ) VALUES ('card-a', 'planning', NULL, 1, 3, 'pending', 0, ${NOW})
      `);
      assert.isTrue(before._tag === "Failure");

      yield* Migration020;

      yield* sql`
        INSERT INTO board_card_step_state (
          card_id, step_id, step_label, stage_label, attempt, max_attempts,
          status, slot_held, updated_at
        ) VALUES ('card-a', 'planning', NULL, 'Planning', 1, 3, 'pending', 0, ${NOW})
      `;
      const rows = yield* sql<{
        readonly step_label: string | null;
        readonly stage_label: string | null;
      }>`SELECT step_label, stage_label FROM board_card_step_state WHERE card_id = 'card-a'`;
      assert.strictEqual(rows[0]?.step_label, null);
      assert.strictEqual(rows[0]?.stage_label, "Planning");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("keeps card_id a primary key, so the projector's upsert still works", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrateToPrevious;
      yield* insertLegacyRow;
      yield* Migration020;

      // The projector upserts on card_id (one live step per card, D4). A
      // rebuild that lost the PRIMARY KEY would silently turn that into an
      // append and duplicate every step transition.
      yield* sql`
        INSERT INTO board_card_step_state (
          card_id, step_id, step_label, stage_label, attempt, max_attempts,
          status, slot_held, updated_at
        ) VALUES ('card-legacy', 'review', 'Review · round 1', 'Code review', 1, 3, 'pending', 0, ${NOW})
        ON CONFLICT (card_id) DO UPDATE SET
          step_id = excluded.step_id,
          step_label = excluded.step_label,
          stage_label = excluded.stage_label
      `;
      const rows = yield* sql<{
        readonly step_id: string;
        readonly step_label: string | null;
      }>`SELECT step_id, step_label FROM board_card_step_state`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.step_id, "review");
      assert.strictEqual(rows[0]?.step_label, "Review · round 1");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
