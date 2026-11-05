// T3o: plan review (T3O-39).
//
//   board_cards.plan_review — JSON `{ enabled, rounds }`, the card's own plan
//     review setting. NULL follows the planning stage's Settings default,
//     matching the absent `BoardCard.planReview` key on older payloads.
//   board_card_step_state.plan_review_started_at / plan_review_rounds — when
//     this stage entry's plan review started and the rounds it locked. NULL on
//     every older row, which is "no review started".
//
// Additive and guarded, so re-running is a no-op.
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
