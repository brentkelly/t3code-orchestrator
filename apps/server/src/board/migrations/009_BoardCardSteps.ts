// One row per (card_id, step_id); a retried board_complete_step re-upserts the
// identical row. `payload` is the agent's JSON payload verbatim, or NULL.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_steps (
      card_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT,
      thread_id TEXT,
      completed_at TEXT NOT NULL,
      UNIQUE (card_id, step_id)
    )
  `;
});
