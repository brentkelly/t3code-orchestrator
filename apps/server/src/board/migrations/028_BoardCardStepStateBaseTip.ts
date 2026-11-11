// The base-branch tip when the review round started. NULL means no tip
// recorded, which reads as not stale: staleness is measured, never assumed.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN base_tip_at_round_start TEXT`;
});
