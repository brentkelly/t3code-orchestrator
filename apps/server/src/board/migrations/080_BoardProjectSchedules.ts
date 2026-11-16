// T3o: t3o.json schedules (T3O-117), plain SQL like 063. `task_id` is allocated before
// any upsert so a retried reconcile reuses it; `applied_json` is what the board last
// wrote, the baseline for "Edited by hand"; a tombstone waits for its task's deletion.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.project_schedules (
      project_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      environment_id TEXT,
      task_id TEXT NOT NULL UNIQUE,
      applied_json TEXT,
      last_error TEXT,
      missing INTEGER NOT NULL DEFAULT 0,
      tombstone INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, file_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.schedule_run_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      launch_error TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_schedule_run_threads_schedule
    ON schedule_run_threads (project_id, file_id, started_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.schedule_created_cards (
      card_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
