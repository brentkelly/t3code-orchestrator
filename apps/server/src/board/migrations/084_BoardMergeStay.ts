// T3o: the merge fixes a card spent in its current stay in Ready for merge (T3O-116). NULL until
// one is spent; the counts carry their stay's stamp, so no backfill is needed.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  if (columns.some((column) => column.name === "merge_stay")) return;
  yield* sql`ALTER TABLE board_cards ADD COLUMN merge_stay TEXT`;
});
