// A projection-only cache, never a domain event: nothing branches on a todo, and
// the durable record is upstream's `turn.plan.updated` thread activity.
// One row per thread; the `card_id` index serves the shell snapshot.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_thread_todos (
      thread_id TEXT NOT NULL PRIMARY KEY,
      card_id TEXT NOT NULL,
      statuses TEXT NOT NULL,
      current_text TEXT,
      done_count INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      current_started_at TEXT,
      advanced_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_thread_todos_card
      ON board_thread_todos (card_id)
  `;
});
