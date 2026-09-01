// T3o: the card Activity rail becomes a structured, actor-attributed projection
// of the board's own event log (t3o-18, D10/D11/D12).
//
// `board_card_activity` (migration 008) held free prose written by two agent
// tools — `board_report_progress` and `board_request_input` — both deleted by
// t3o-18 D13. Its only two kinds (`progress`, `input-requested`) go with them,
// and nothing ever rendered a row, so there is nothing to preserve: the table is
// recreated rather than altered, which is also the only clean way to drop the
// NOT NULL on the old `body` column in SQLite.
//
// Rows are now a KIND + a small typed JSON payload + an ACTOR. The server never
// writes English; the client renders the sentence and its links. Otherwise the
// log is unqueryable, unrelabelable, and "who approved it" ends up buried in
// prose.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every existing row is a `progress` or `input-requested` note whose kind no
  // longer exists (D13). Dropping the table drops them, which is the intent.
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
