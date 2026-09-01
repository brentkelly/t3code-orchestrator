// T3o: card↔label join (t3o-06a). `ordinal` preserves the card's label order
// so table rehydration reproduces the array the decider computed. Indexed both
// ways: by card_id (a card's labels — read on every rehydration and shell) and
// by label_id ("which cards use this label" — the reverse lookup a future
// board-by-label filter needs; t3o-06a itself never queries it, but the plan
// mandates the join be indexed both ways so that filter is a lookup, not a
// scan). Numbered from 900_ upward so it can never collide with upstream.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
