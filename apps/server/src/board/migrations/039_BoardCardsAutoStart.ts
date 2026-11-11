// The decider clears it in the move out of the pre-build stage. The 0 default
// MUST match BoardCard.autoStart's decoding default.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("auto_start")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0`;
  }
});
