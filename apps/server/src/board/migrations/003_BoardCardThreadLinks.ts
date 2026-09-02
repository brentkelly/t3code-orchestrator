// T3o: card ↔ thread links (D9). The thread_id primary key makes "which
// card owns this thread" a lookup and enforces one-thread-one-card at the
// storage layer; the card_id index covers the other direction.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_thread_links (
      thread_id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      role TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      tombstoned_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_card_thread_links_card
    ON board_card_thread_links(card_id)
  `;
});
