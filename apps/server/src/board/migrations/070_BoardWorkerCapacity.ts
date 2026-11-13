// T3O-86, the worker side: each board's card records and last accepted `seq`, one row per
// board this server works for, and the worker's own computed defaults. Guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_worker_capacity (
      board_id   TEXT PRIMARY KEY NOT NULL,
      last_seq   INTEGER,
      records    TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_worker_settings (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `;
});
