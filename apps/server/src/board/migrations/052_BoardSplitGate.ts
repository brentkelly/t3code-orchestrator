// T3o: the split gate's Planned flag and recommendation (T3O-31).
//
//   board_plans.planned — 1 when a split plan is a full implementation plan, 0
//     when it is a brief that still needs planning. Every older row is 1,
//     matching `BoardPlan.planned` reading absent as planned.
//   board_cards.split_recommendation — JSON `{ autoBuild, mergeTarget }`, the
//     agent's advice for the split it proposed. NULL for every older row and
//     every card without a pending split; readers apply the fallback rules.
//
// Both additive and guarded, so re-running is a no-op.
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
