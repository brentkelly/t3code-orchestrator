// T3o: the base-branch tip at review-round start, on the step-state row
// (t3o-24, D1).
//
// `base_tip_at_round_start` is the commit the card's recorded base branch
// pointed at when the run row's review round started — one `rev-parse` in the
// project root, recorded by the reactor and carried forward onto the round's
// later steps. Staleness at the review→merge boundary is a plain inequality
// against the current tip, which is what gates a sub-board child's sync-base
// step and final gate round.
//
// A plain ADD COLUMN (SQLite supports adding a nullable column without a table
// rebuild). History is NOT rewritten (D7): existing rows get NULL, which
// already means "no tip recorded — not stale" (staleness is measured, never
// assumed), so no read-side resolution shim is needed.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN base_tip_at_round_start TEXT`;
});
