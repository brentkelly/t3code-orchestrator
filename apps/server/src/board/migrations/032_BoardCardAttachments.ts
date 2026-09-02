// T3o-32: a card's brief attachments (K5). One row per file; the bytes live
// in board-owned storage under `<stateDir>/board/attachments/<card_id>/<name>`
// (K1), and this table is the read-model mirror of `BoardCard.attachments`,
// rewritten wholesale from each attach/detach event exactly like
// `board_card_thread_links`. Keyed on (card_id, attachment_id): ids are
// minted per claim and the decider refuses an id any card already holds, so
// a row can never be relocated between cards by an upsert. The card_id index
// covers the shell's COUNT and the detail's list.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_card_attachments_card
    ON board_card_attachments(card_id)
  `;
});
