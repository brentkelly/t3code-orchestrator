// A NULL `plan_review` follows the planning stage's default. Additive and guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cardColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  if (!cardColumns.some((column) => column.name === "plan_review")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN plan_review TEXT`;
  }
  const stepColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_step_state)
  `;
  const hasStep = (name: string) => stepColumns.some((column) => column.name === name);
  if (!hasStep("plan_review_started_at")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN plan_review_started_at TEXT`;
  }
  if (!hasStep("plan_review_rounds")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN plan_review_rounds INTEGER`;
  }
});
