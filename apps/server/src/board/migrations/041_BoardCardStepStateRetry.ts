// A NULL `stalled_reason` reads as `gave-up`, matching the decoding default on
// BoardCardStepState.stalledReason. A NULL `retry_at` means nothing scheduled.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_step_state)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("stalled_reason")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN stalled_reason TEXT`;
  }
  if (!has("retry_at")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN retry_at TEXT`;
  }
});
