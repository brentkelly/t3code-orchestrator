// SQLite has no ALTER COLUMN, so relaxing `step_label` NOT NULL is a
// create-copy-drop-rename. The column list is spelled out in full, so the copy
// can't silently drop a frozen-config column. Existing rows keep their labels.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
    CREATE TABLE boards.board_card_step_state_new (
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

  yield* sql`DROP TABLE boards.board_card_step_state`;
  yield* sql`ALTER TABLE board_card_step_state_new RENAME TO board_card_step_state`;
});
