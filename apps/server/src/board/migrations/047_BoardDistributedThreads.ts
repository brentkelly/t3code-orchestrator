// T3o: threads on workers, and the relay that serves them (T3O-63, D3/D9).
//
// `board_card_thread_links.worker_id` — the worker a linked thread lives on,
// its environment id. NULL means `local`, the central server itself, which is
// every link written before workers existed: it must match the absent
// `BoardCardThreadLink.workerId`, so replay equals rehydration. Altered
// unqualified like 043: the column joins whichever copy of the table exists.
//
// The other three are fresh tables, schema-qualified like every board CREATE
// (see 042):
//
//   board_relayed_threads — WORKER side. The threads a central server spawned
//     here, and which board they belong to. A board tool call from one of them
//     is relayed to that board instead of running against this server's own.
//     Persisted, so a relayed thread still forwards after a restart.
//
//   board_worker_cursors — CENTRAL side. How far through each worker's thread
//     signals the board has read, so a reconnect resumes where it left off and
//     delivers what it missed exactly once. Todo signals ride the same feed.
//
//   board_mcp_relay_calls — CENTRAL side. Each relayed call's answer, by its
//     call id. A dropped connection can deliver a call twice; the second
//     delivery gets the first answer instead of running again.
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
