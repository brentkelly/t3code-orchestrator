// When turning Auto-plan on reopened a finished plan step (T3O-80). Additive and guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const stepColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_step_state)
  `;
  if (!stepColumns.some((column) => column.name === "reopened_at")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN reopened_at TEXT`;
  }
});
