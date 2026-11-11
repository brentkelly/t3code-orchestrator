// T3o: the per-card merge strategy on board_cards.
//
// One column, additive and guarded like 036's `base_branch`, defaulting to
// NULL — "follow the default" — which MUST match the decoding default on
// BoardCard.mergeStrategy (contracts board.ts) so replay equals rehydration.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  if (!columns.some((column) => column.name === "merge_strategy")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN merge_strategy TEXT`;
  }
});
