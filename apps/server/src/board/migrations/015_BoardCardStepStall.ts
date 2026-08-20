// T3o: stall detection (t3o-17, D1/D2). The step-state row splits the single
// recovery counter into two: `attempt` (cumulative invocations this stage
// entry, already present) keeps counting for display and the D5 ceiling, and a
// new `stall_count` (CONSECUTIVE stalls, reset on progress) is what recovery
// gates on. `last_nudge_at` records when recovery last nudged the step, the
// boundary the reactor resolves the progress signal against. NOT NULL columns
// added with defaults, as SQLite requires; every real row is written by the
// projector with resolved values. Greenfield (D14): no backfill, the dev
// database may be recreated.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN stall_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN last_nudge_at TEXT`;
});
