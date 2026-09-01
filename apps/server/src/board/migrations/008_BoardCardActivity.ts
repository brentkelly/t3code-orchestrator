// T3o: agent write-path activity log (t3o-08) — progress notes and
// human-input requests an agent emits over MCP. Append-only, card-scoped,
// read on demand by board_get_card_context; bodies never enter the read
// model (D8). One table for both kinds, discriminated by `kind`.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_activity (
      activity_id TEXT NOT NULL PRIMARY KEY,
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_card_activity_card
      ON board_card_activity (card_id)
  `;
});
