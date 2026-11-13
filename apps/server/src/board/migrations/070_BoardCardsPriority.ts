// The card's priority (T3O-95). Additive and guarded; the 'normal' default MUST match the
// decoding default on BoardCard.priority (contracts board.ts) so replay equals rehydration.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA boards.table_info(board_cards)
  `;
  if (!columns.some((column) => column.name === "priority")) {
    yield* sql`ALTER TABLE boards.board_cards ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`;
  }
});
