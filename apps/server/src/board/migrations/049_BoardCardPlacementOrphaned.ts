// NULL default matches `BoardCard`'s decoding default. Unqualified ALTER, so it
// joins whichever copy of the table exists.
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
