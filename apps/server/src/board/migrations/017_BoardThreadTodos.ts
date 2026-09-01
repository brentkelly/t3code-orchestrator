// T3o: board-owned cache of each linked thread's current todo list (t3o-18, D1).
//
// A PROJECTION-ONLY side table: written directly by the board projector off the
// thread's `turn.plan.updated` activity, never a board domain command or event,
// never replayed as one. That is licensed by the board's own D8 rule — nothing
// branches on a todo. No stage transition, no step outcome, no gate, no
// concurrency decision reads one; it is display state, plus the stall-reset
// signal t3o-18 D16 re-points onto it.
//
// This is a CACHE, not a source of truth. The authoritative record already
// exists upstream and durably: every `turn.plan.updated` is persisted as a
// thread activity carrying the full plan. That is what makes a
// non-event-sourced board table safe to own here.
//
// One row per thread (a todo list belongs to a thread, not a card), so
// `thread_id` is the primary key; the `card_id` index covers the "this card's
// threads" direction the shell snapshot reads.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_thread_todos (
      thread_id TEXT NOT NULL PRIMARY KEY,
      card_id TEXT NOT NULL,
      statuses TEXT NOT NULL,
      current_text TEXT,
      done_count INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      current_started_at TEXT,
      advanced_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_thread_todos_card
      ON board_thread_todos (card_id)
  `;
});
