// A webhook task's board rule, keyed by upstream's task id, and which cards a rule
// archived, so reopening restores only those (T3O-78). Orphans of deleted tasks are inert.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.scheduled_task_board_actions (
      task_id TEXT PRIMARY KEY,
      action_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.webhook_archived_cards (
      card_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      archived_at TEXT NOT NULL
    )
  `;
});
