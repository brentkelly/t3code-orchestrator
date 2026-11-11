// Older plans read as planned (1); a NULL `split_recommendation` falls back to
// the readers' rules. Additive and guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const planColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_plans)
  `;
  if (!planColumns.some((column) => column.name === "planned")) {
    yield* sql`ALTER TABLE board_plans ADD COLUMN planned INTEGER NOT NULL DEFAULT 1`;
  }
  const cardColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  if (!cardColumns.some((column) => column.name === "split_recommendation")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN split_recommendation TEXT`;
  }
});
