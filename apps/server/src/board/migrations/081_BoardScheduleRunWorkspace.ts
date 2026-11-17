// T3o: a schedule run's branch, fixed at launch, and its worktree path once known (T3O-117),
// so retention removes exactly what the run made, whatever the thread later says. Guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA boards.table_info(schedule_run_threads)
  `;
  if (!columns.some((column) => column.name === "branch")) {
    yield* sql`ALTER TABLE boards.schedule_run_threads ADD COLUMN branch TEXT`;
  }
  if (!columns.some((column) => column.name === "worktree_path")) {
    yield* sql`ALTER TABLE boards.schedule_run_threads ADD COLUMN worktree_path TEXT`;
  }
});
