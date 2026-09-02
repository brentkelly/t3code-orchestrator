// T3o: the per-project card-number high-water mark that outlives deleted cards.
//
// Card keys ("T3-195") are allocated from `MAX(card_number)` over `board_cards`,
// which was exact for as long as a card could only ever be archived — an
// archived card keeps its row, so it keeps its number reserved. Deleting a card
// drops the row, and with it the evidence that its number was ever used: delete
// the newest card in a project and the next card created re-issues its key.
//
// This table is that evidence. One row per project, written only by a delete,
// holding the highest number that project has EVER issued. The allocator takes
// the max across it and `board_cards`, so live cards cover the common case and
// this covers the numbers no live card can account for any more.
//
// No backfill: every number issued so far is still represented by a row in
// `board_cards` (nothing has been able to delete one until now), so an empty
// table is already correct.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_number_floor (
      project_id TEXT PRIMARY KEY,
      max_card_number INTEGER NOT NULL
    )
  `;
});
