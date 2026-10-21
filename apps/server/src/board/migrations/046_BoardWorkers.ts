// T3o: the worker registry (T3O-62, D8/D19).
//
// `board_workers` is the projection of the registry events: one row per
// registered worker, keyed on the worker's environment id. The built-in
// `local` worker is never a row.
//
// `board_default_worker` holds the default-worker choice as a single row. No
// row means `local`, so a board that never chose one rehydrates exactly as a
// from-empty replay.
//
// `board_worker_snapshots` is NOT a projection: it is the last providers and
// checkouts each worker reported, written by the connection manager whenever
// it hears from the worker, so an offline worker still shows what it had. It
// is deleted with the worker on remove.
//
// Fresh CREATE TABLEs, guarded by IF NOT EXISTS and schema-qualified like every
// other board table (see 042).
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
