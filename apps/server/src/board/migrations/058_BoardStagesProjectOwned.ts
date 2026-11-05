// T3o: project-owned stages (T3O-43).
//
// A project's committed `t3o.json` can add stages of its own. Those rows live
// in `board_stages` beside the global list, with `project_id` naming the
// project; a global stage keeps it NULL. Guarded by the column check, so
// re-running is a no-op.
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
