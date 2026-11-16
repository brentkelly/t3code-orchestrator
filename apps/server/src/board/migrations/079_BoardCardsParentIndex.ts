// A card's children are read by `parent_card_id` on every card detail load (T3O-108).
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_cards_parent
    ON board_cards(parent_card_id)
  `;
});
