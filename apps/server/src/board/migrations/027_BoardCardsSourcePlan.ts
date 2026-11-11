/**
 * NULL for every top-level card, matching `sourcePlanId`'s decoding default, so
 * replay equals rehydration. PRAGMA-guarded so it is re-runnable.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  if (!columns.some((column) => column.name === "source_plan_id")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN source_plan_id TEXT`;
  }
});
