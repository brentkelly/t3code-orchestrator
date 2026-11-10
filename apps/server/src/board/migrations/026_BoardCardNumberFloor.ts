// The highest card number each project ever issued, written on delete. The
// allocator takes the max of this and `board_cards`, so a deleted card's key is
// never reissued.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_number_floor (
      project_id TEXT PRIMARY KEY,
      max_card_number INTEGER NOT NULL
    )
  `;
});
