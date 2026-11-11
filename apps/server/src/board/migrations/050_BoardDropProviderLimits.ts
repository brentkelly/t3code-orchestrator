// `quota-exhausted` is rewritten to `gave-up` rather than left to fail the row's
// schema. The UPDATE is unqualified so it hits whichever copy of the table exists.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS boards.board_provider_limits`;
  yield* sql`
    UPDATE board_card_step_state
    SET stalled_reason = 'gave-up', retry_at = NULL
    WHERE stalled_reason = 'quota-exhausted'
  `;
});
