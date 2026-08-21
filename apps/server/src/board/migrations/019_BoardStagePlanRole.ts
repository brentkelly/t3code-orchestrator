// T3o: the `plan` stage role (board settings redesign). Planning becomes a
// role holder — plan-mode forcing, the plan deliverable envelope segment and
// the delete guard all key on it — but migration 014 seeded `board_stages`
// with Planning's role NULL, and a board touched since then has that row
// persisted. Backfill the role in place; `effectiveBoardStageRole` remains
// the read-side fallback for replaying pre-role event payloads. Guarded on
// the seeded stage id AND a still-null role so a hand-rewritten row is never
// trampled.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`UPDATE board_stages SET role = 'plan' WHERE stage_id = 'planning' AND role IS NULL`;
});
