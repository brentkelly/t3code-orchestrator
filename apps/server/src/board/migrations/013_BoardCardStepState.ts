// One live step per card, so `card_id` is the key. `slot_held` (0/1) tracks the
// concurrency slot so it is released exactly once at every terminal outcome.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_step_state (
      card_id TEXT NOT NULL PRIMARY KEY,
      step_id TEXT NOT NULL,
      step_label TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      slot_held INTEGER NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
