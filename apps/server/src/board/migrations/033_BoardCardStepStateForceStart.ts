// Persisted so a "start it anyway" click survives a restart before the next
// scheduling pass. Cleared on admission, so it never bleeds into the next step.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN force_start INTEGER NOT NULL DEFAULT 0`;
});
