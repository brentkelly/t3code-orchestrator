// T3o: the stage entry's RECOVERY total on the step-state row (T3O-12, D4).
//
// The per-stage-entry runaway ceiling used to be read off `attempt`, which
// every PLANNED review-phase selection carried forward. Five rounds of three
// phases is already 15 of the default 20, so a loop given extra rounds blew a
// ceiling that was never meant to bound successful work, and from then on the
// first stall of any kind escalated instantly with no ladder. This column
// counts only what `board.card.recover-step` spends.
//
// A plain ADD COLUMN with a NOT NULL default (SQLite adds a defaulted column
// without a table rebuild). History is NOT rewritten (seams D7), and the
// default of 0 is the DESIRED outcome rather than a compromise: every card
// currently wedged past the old ceiling stops being falsely escalated the
// moment the server restarts.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE board_card_step_state
    ADD COLUMN stage_entry_recoveries INTEGER NOT NULL DEFAULT 0
  `;
});
