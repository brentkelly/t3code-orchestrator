// Outbound-only workers (T3O-84). Join codes and tunnel credentials keep only SHA-256
// hashes. `board_workers` is rebuilt so `url` may be null (workers dial the board now),
// with the abbreviation, release and join time beside it. Guarded, so a re-run is a no-op.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_worker_join_codes (
      code_id           TEXT PRIMARY KEY NOT NULL,
      code_hash         TEXT NOT NULL UNIQUE,
      created_at        TEXT NOT NULL,
      expires_at        TEXT NOT NULL,
      used_at           TEXT,
      used_by_worker_id TEXT,
      used_by_label     TEXT,
      used_from         TEXT,
      used_release      TEXT,
      rejoin            INTEGER NOT NULL DEFAULT 0,
      cancelled_at      TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_worker_tunnel_credentials (
      credential_hash TEXT PRIMARY KEY NOT NULL,
      worker_id       TEXT NOT NULL,
      issued_at       TEXT NOT NULL,
      revoked_at      TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.board_worker_tunnel_credentials_worker
    ON board_worker_tunnel_credentials (worker_id)
  `;

  const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
    PRAGMA boards.table_info(board_workers)
  `;
  if (columns.some((column) => column.name === "abbreviation")) return;
  yield* sql`
    CREATE TABLE boards.board_workers_068 (
      worker_id    TEXT PRIMARY KEY NOT NULL,
      label        TEXT NOT NULL,
      url          TEXT,
      added_at     TEXT NOT NULL,
      abbreviation TEXT,
      t3o_release  TEXT,
      joined_at    TEXT
    )
  `;
  yield* sql`
    INSERT INTO boards.board_workers_068 (worker_id, label, url, added_at)
    SELECT worker_id, label, url, added_at FROM boards.board_workers
  `;
  yield* sql`DROP TABLE boards.board_workers`;
  yield* sql`ALTER TABLE boards.board_workers_068 RENAME TO board_workers`;
});
