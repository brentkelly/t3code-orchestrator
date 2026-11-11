// NULL means move as soon as the pipeline reaches it; the supervisor clears it
// in the pass that acts on it. MUST match BoardCard.scheduledStartAt's decoding
// default.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("scheduled_start_at")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN scheduled_start_at TEXT`;
  }
});
