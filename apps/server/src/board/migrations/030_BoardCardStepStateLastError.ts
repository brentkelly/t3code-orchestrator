// The provider's error text for a step whose turn never started. Replaced, not
// merged, on every recovery, so it always describes the current stop.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN last_error TEXT`;
});
