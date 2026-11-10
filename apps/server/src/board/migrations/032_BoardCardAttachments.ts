// Read-model mirror of `BoardCard.attachments`, rewritten wholesale per event.
// The decider refuses an id another card holds, so an upsert never moves a row
// between cards. The key's leading column serves the per-card reads.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_attachments (
      attachment_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (card_id, attachment_id)
    )
  `;
});
