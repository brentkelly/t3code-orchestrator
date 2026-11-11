// T3o: count the priced turns a provider marked `partial`, so their figure reads as a lower
// bound rather than exact (T3O-77).
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_card_usage)`;
  if (columns.some((column) => column.name === "turns_partial")) return;
  yield* sql`
    ALTER TABLE boards.board_card_usage ADD COLUMN turns_partial INTEGER NOT NULL DEFAULT 0
  `;
});
