// T3O-86, the board side: a step's queue detail beside its reason, legacy concurrency reasons
// cleared so the next pass writes a real one, the per-worker `seq` the board stamps claims and
// syncs with, and the one-time upgrade's completion marker. Guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const steps = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_card_step_state)`;
  if (!steps.some((column) => column.name === "queued_detail")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN queued_detail TEXT`;
  }
  yield* sql`
    UPDATE board_card_step_state
    SET queued_by = NULL
    WHERE queued_by IN ('board', 'worker', 'provider')
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_capacity_seq (
      worker_id TEXT PRIMARY KEY NOT NULL,
      seq       INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_capacity_upgrade (
      id           TEXT PRIMARY KEY NOT NULL,
      completed_at TEXT NOT NULL
    )
  `;
});
