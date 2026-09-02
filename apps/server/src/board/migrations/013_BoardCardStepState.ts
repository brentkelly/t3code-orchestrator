// T3o: supervisor step machine (t3o-10, D4/D8). One row per card holding its
// live step status — where the card's current step sits in the lifecycle
// (pending | queued | running | awaiting-input | completing | succeeded |
// failed | abandoned). The supervisor reactor and the decider branch on it
// (death detection, recovery escalation, boot reconciliation), so it lives in
// the read model and is rehydrated from here (`BoardState.stepStates`). One
// step at a time per card (D4), so `card_id` is the primary key. `slot_held`
// is 0/1 (SQLite has no boolean), tracked so a concurrency slot is released
// exactly once at every terminal outcome, including a crash.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_step_state (
      card_id TEXT NOT NULL PRIMARY KEY,
      step_id TEXT NOT NULL,
      step_label TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      slot_held INTEGER NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
