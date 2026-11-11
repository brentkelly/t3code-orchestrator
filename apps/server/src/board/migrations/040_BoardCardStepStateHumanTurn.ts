// Durable so a restart between a human's message and the turn ending can't
// bring back a resume nudge on top of it.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN human_turn_at TEXT`;
});
