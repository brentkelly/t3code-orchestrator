// The `local` worker is never a row; no default-worker row means `local`.
// `board_worker_snapshots` is not a projection: the connection manager writes
// each worker's last report so an offline worker still shows it.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_workers (
      worker_id TEXT PRIMARY KEY NOT NULL,
      label     TEXT NOT NULL,
      url       TEXT NOT NULL,
      added_at  TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_default_worker (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      worker_id TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_worker_snapshots (
      worker_id        TEXT PRIMARY KEY NOT NULL,
      t3o_version      TEXT,
      protocol_version INTEGER,
      last_seen_at     TEXT,
      snapshot_json    TEXT
    )
  `;
});
