// T3o: the `merge` stage role. "Ready for merge" becomes a role holder — the
// Merge button, the merge settings (strategy, conflict prompt, branch cleanup)
// and the branch-deletion gate all key on it — but migration 014 seeded
// `board_stages` with its role NULL, and a board touched since then has that
// row persisted.
//
// Backfill the role in place, exactly as 019 did for `plan`;
// `effectiveBoardStageRole` remains the read-side fallback for replaying
// pre-role event payloads. Guarded on the seeded stage id AND a still-null
// role so a hand-rewritten row is never trampled.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`UPDATE board_stages SET role = 'merge' WHERE stage_id = 'merge' AND role IS NULL`;
});
