// A plan review's round, its end, its armed state and the policy delivered to the agent, on
// the step; and the review round that last revised each plan (T3O-104). Additive and guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const STEP_COLUMNS = [
  ["plan_review_round", "INTEGER"],
  ["plan_review_done_at", "TEXT"],
  ["plan_review_awaiting_start", "TEXT"],
  ["plan_review_policy_sent", "TEXT"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const stepColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_step_state)
  `;
  for (const [name, type] of STEP_COLUMNS) {
    if (stepColumns.some((column) => column.name === name)) continue;
    yield* sql.unsafe(`ALTER TABLE board_card_step_state ADD COLUMN ${name} ${type}`);
  }
  const planColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_plans)`;
  if (!planColumns.some((column) => column.name === "revised_in_round")) {
    yield* sql`ALTER TABLE board_plans ADD COLUMN revised_in_round INTEGER`;
  }
});
