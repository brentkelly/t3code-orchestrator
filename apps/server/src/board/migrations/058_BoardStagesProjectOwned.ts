// A NULL `project_id` is a global stage. Guarded by the column check.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_stages)
  `;
  if (columns.some((column) => column.name === "project_id")) return;
  yield* sql`ALTER TABLE board_stages ADD COLUMN project_id TEXT`;
});
