// T3o: a card whose worker was removed while it had work there (T3O-66, D22).
//
// `board_cards.placement_orphaned` — the removed worker's id and label and
// when it went, as JSON; NULL for every card whose worker is still on the
// board. Defaults to NULL, matching the decoding default on `BoardCard`, so a
// from-empty replay of an older log equals a table rehydration. Altered
// unqualified like 048: the column joins whichever copy of the table exists.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  if (!columns.some((column) => column.name === "placement_orphaned")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN placement_orphaned TEXT`;
  }
});
