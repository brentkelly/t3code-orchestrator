// T3o: a schedule run that touched a card keeps its thread, but retention still removes its
// worktree and branch; this marks that done so the run isn't pruned again (T3O-112). Guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA boards.table_info(schedule_run_threads)
  `;
  if (!columns.some((column) => column.name === "workspace_removed")) {
    yield* sql`
      ALTER TABLE boards.schedule_run_threads
      ADD COLUMN workspace_removed INTEGER NOT NULL DEFAULT 0
    `;
  }
});
