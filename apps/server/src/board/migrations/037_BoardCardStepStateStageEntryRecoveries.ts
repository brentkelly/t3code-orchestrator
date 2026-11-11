// Counts only what `board.card.recover-step` spends; the runaway ceiling reads
// this, not `attempt`. Defaulting to 0 is deliberate: it un-wedges cards that a
// planned review loop had pushed past the ceiling.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE board_card_step_state
    ADD COLUMN stage_entry_recoveries INTEGER NOT NULL DEFAULT 0
  `;
});
