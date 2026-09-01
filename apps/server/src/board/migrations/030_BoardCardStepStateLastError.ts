// T3o: why a step stopped, on the step-state row (t3o-30, D2).
//
// `last_error` holds the provider's own error text for a step whose turn never
// started — a CLI that is not installed, a session that failed to spawn, a model
// the instance refuses. Without it a card whose step died at spawn renders a
// spinner forever and names no thread worth opening: the error exists, but only
// inside a thread the card cannot point at.
//
// Replaced rather than merged on every recovery (see the decider), so the column
// always describes the CURRENT stop.
//
// A plain ADD COLUMN (SQLite adds a nullable column without a table rebuild).
// History is NOT rewritten (D7): existing rows get NULL, which already means
// "stopped for no recorded reason", so no read-side resolution shim is needed.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN last_error TEXT`;
});
