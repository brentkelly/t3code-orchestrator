/**
 * Sub-boards (t3o-23): `source_plan_id` records which plan a materialised
 * child card was cut from, pairing the parent's plan pane with its children.
 * Nullable and NULL for every pre-existing row and every top-level card —
 * matching `sourcePlanId`'s decoding default on the contracts side, so a
 * from-empty replay equals rehydration. PRAGMA-guarded so it is re-runnable.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  if (!columns.some((column) => column.name === "source_plan_id")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN source_plan_id TEXT`;
  }
});
