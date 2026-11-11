// Every column defaults to NULL, matching the decoding defaults on `BoardCard`
// and `BoardCardStepState`. ALTERs are unqualified so they join whichever copy
// of the table exists.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const cardColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const hasCardColumn = (name: string) => cardColumns.some((column) => column.name === name);
  if (!hasCardColumn("pinned_worker_id")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN pinned_worker_id TEXT`;
  }
  if (!hasCardColumn("placed_worker_id")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN placed_worker_id TEXT`;
  }
  if (!hasCardColumn("worker_move")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN worker_move TEXT`;
  }

  const stepColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_step_state)
  `;
  if (!stepColumns.some((column) => column.name === "queued_by")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN queued_by TEXT`;
  }
});
