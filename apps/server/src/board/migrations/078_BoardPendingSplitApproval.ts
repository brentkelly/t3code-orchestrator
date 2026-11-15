// A split approved to take effect when the card's plan review finishes, as JSON on the card
// (T3O-105). Additive and guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  if (!columns.some((column) => column.name === "pending_split_approval")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN pending_split_approval TEXT`;
  }
});
