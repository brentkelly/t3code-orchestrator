// Recreated rather than altered: SQLite can't drop the old `body` NOT NULL, and
// no old row was ever rendered. Rows are kind + typed JSON payload + actor; the
// client renders the sentence.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every existing row is a `progress` or `input-requested` note whose kind no
  // longer exists. Dropping the table drops them, which is the intent.
  yield* sql`DROP TABLE IF EXISTS boards.board_card_activity`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_activity (
      activity_id TEXT NOT NULL PRIMARY KEY,
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      -- The typed payload (from/to stage, plan id, step id, outcome), carried
      -- verbatim as a JSON string so replay and rehydration are a trivial
      -- round-trip with no re-serialisation to drift.
      payload TEXT NOT NULL,
      -- human | agent | system (D11), stamped at the dispatch boundary.
      actor_kind TEXT NOT NULL,
      -- The resolved human name, frozen at write time so it stays correct after
      -- the project's git config changes.
      actor_name TEXT,
      -- The agent's provider instance; the client resolves its display name and
      -- accent from this, so a renamed instance relabels its own history.
      actor_provider_instance_id TEXT,
      actor_thread_id TEXT,
      thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_card_activity_card
      ON board_card_activity (card_id)
  `;
});
