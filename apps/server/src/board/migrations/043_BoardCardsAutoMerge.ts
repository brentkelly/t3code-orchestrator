// `auto_merge` is never spent: a card merged again is still armed.
// `auto_merge_hold` NULL means nothing is held, so a cleared hold rehydrates
// like one never refused. Both MUST match BoardCard's decoding defaults.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("auto_merge")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0`;
  }
  if (!has("auto_merge_hold")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN auto_merge_hold TEXT`;
  }
});
