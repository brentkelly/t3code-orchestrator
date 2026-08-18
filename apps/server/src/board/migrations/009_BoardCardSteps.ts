// T3o: agent write-path step-completion ledger (t3o-08, D4). One row per
// (card_id, step_id) — a step is complete only when the agent calls
// board_complete_step, and a retried call re-upserts the identical row
// (idempotent). Rehydrated into `BoardState.stepCompletions`, which the
// decider (idempotency) and the reactor (Building → Review advance) branch on
// (D8). `payload` is the agent's structured payload carried verbatim as a
// JSON string, or NULL.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_card_steps (
      card_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT,
      thread_id TEXT,
      completed_at TEXT NOT NULL,
      UNIQUE (card_id, step_id)
    )
  `;
});
