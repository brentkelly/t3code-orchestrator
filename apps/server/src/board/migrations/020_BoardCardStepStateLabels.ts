// T3o: nullable step label + frozen stage label (t3o-19, D4/D5).
//
// `step_label` becomes NULLABLE — null means "this stage has no steps", which
// is every stage but the review loop. Migration 013 declared it NOT NULL
// because a single-step stage always had one: the stage's own label, rendered
// into the prompt as the tautology `Stage: planning. Step: Planning.`.
//
// `stage_label` is added so the preamble can name the stage by its LABEL (a
// custom stage's id is a UUID) and so every `stepLabel` reader — thread title,
// stall message, activity rail — resolves `stepLabel ?? stageLabel` without a
// board read.
//
// History is NOT rewritten (D7): existing rows keep their `step_label` and get
// `stage_label = NULL`, so they render exactly as they did today and a table
// rehydration still equals a from-empty replay of the events that produced
// them. A card already mid-stage at deploy keeps its old preamble until that
// stage ends.
//
// SQLite has no ALTER COLUMN, so relaxing NOT NULL is a create-copy-drop-rename.
// The column list is spelled out in full — 013's ten, 014's six frozen-config
// columns and 015's two stall columns — rather than `SELECT *`, so the copy is
// explicit about what it carries. Nothing references this table: no index, no
// trigger, no foreign key.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Every column of `board_card_step_state` as of migration 015, in the order
    the rebuilt table declares them. `stage_label` is excluded: it is new here,
    so the old table has no value to copy. */
const CARRIED_COLUMNS = [
  "card_id",
  "step_id",
  "step_label",
  "attempt",
  "max_attempts",
  "thread_id",
  "status",
  "slot_held",
  "started_at",
  "updated_at",
  "prompt",
  "provider_instance_id",
  "model",
  "mode",
  "human_in_loop",
  "timeout_ms",
  "stall_count",
  "last_nudge_at",
].join(", ");

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE board_card_step_state_new (
      card_id TEXT NOT NULL PRIMARY KEY,
      step_id TEXT NOT NULL,
      step_label TEXT,
      stage_label TEXT,
      attempt INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      slot_held INTEGER NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      provider_instance_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'plan',
      human_in_loop INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER NOT NULL DEFAULT 0,
      stall_count INTEGER NOT NULL DEFAULT 0,
      last_nudge_at TEXT
    )
  `;

  yield* sql.unsafe(
    `INSERT INTO board_card_step_state_new (${CARRIED_COLUMNS}) ` +
      `SELECT ${CARRIED_COLUMNS} FROM board_card_step_state`,
  );

  yield* sql`DROP TABLE board_card_step_state`;
  yield* sql`ALTER TABLE board_card_step_state_new RENAME TO board_card_step_state`;
});
