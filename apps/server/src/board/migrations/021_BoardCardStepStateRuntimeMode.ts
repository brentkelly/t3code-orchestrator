// Existing rows get NULL; the projection resolves a NULL `runtime_mode` to the
// old behaviour (`full-access` for build mode, else `approval-required`) so a
// card mid-stage at deploy keeps the authority it was running under.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN runtime_mode TEXT`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN model_options TEXT`;
});
