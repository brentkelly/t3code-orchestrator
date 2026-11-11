// `stall_count` counts CONSECUTIVE stalls (reset on progress) and gates recovery;
// `attempt` keeps counting for display. NOT NULL columns need defaults in SQLite;
// the projector writes resolved values for every real row.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN stall_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN last_nudge_at TEXT`;
});
