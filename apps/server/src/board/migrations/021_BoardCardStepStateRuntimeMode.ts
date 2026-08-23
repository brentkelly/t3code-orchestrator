// T3o: per-run agent authority + model options on the step-state row (t3o-21).
//
// `runtime_mode` is the user-chosen access posture (approval-required |
// auto-accept-edits | auto | full-access), frozen at stage entry so a settings
// edit mid-flight cannot change a live agent's authority, and read verbatim by
// the reactor — the board no longer derives `full-access` from build mode.
//
// `model_options` is the JSON-encoded reasoning/effort selection frozen for the
// run, passed into the spawned thread's `modelSelection.options`.
//
// Both are plain ADD COLUMNs (SQLite supports adding a nullable column without a
// table rebuild). History is NOT rewritten (D7): existing rows get NULL, and
// the projection resolves a NULL `runtime_mode` to the OLD behaviour
// (`full-access` for a build-mode row, `approval-required` otherwise) so a card
// already mid-stage at deploy keeps the authority it was running under.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN runtime_mode TEXT`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN model_options TEXT`;
});
