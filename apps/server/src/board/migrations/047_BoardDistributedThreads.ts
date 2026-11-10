// A NULL `worker_id` means `local`, matching an absent
// `BoardCardThreadLink.workerId`. `board_mcp_relay_calls` stores each relayed
// call's answer so a redelivered call gets it instead of running twice.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_thread_links)
  `;
  if (!columns.some((column) => column.name === "worker_id")) {
    yield* sql`ALTER TABLE board_card_thread_links ADD COLUMN worker_id TEXT`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_relayed_threads (
      thread_id              TEXT PRIMARY KEY NOT NULL,
      central_environment_id TEXT NOT NULL,
      created_at             TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_worker_cursors (
      worker_id     TEXT PRIMARY KEY NOT NULL,
      signal_cursor INTEGER NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_mcp_relay_calls (
      call_id      TEXT PRIMARY KEY NOT NULL,
      worker_id    TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      completed_at TEXT NOT NULL
    )
  `;
});
