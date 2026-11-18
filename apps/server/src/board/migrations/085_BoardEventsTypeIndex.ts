// The worktree sweep reads recent `board.card-deleted` events by type and time (T3O-123).
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_events_type_occurred
    ON board_events(event_type, occurred_at)
  `;
});
