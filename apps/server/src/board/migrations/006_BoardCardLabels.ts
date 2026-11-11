// `ordinal` keeps the card's label order so rehydration reproduces the decider's
// array. Indexed both ways, so a by-label lookup is never a scan.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_labels (
      card_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (card_id, label_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_card_labels_card
    ON board_card_labels(card_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_card_labels_label
    ON board_card_labels(label_id)
  `;
});
