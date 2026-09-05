// T3o: the human's "start it anyway" override, on the step-state row (t3o-33).
//
// `force_start` is set by `board.card.force-start-step` on a step that is
// `queued` for a concurrency slot. The governor admits such a step ahead of the
// queue and takes its slot through `BoardStepSlots.restore` — the unconditional
// take — instead of the capped `acquire`, so a human can deliberately run over
// the agent limit.
//
// It lives on the row rather than in memory because the request must survive a
// restart: a server bounced between the click and the next scheduling pass
// would otherwise drop the override silently, leaving the card queued with no
// sign the user ever asked.
//
// Cleared on admission (the decider writes a fresh row), so it describes ONE
// admission and never bleeds into the card's next step.
//
// A plain ADD COLUMN with a default (SQLite adds it without a table rebuild).
// History is NOT rewritten (D7): existing rows read 0, which already means "no
// override was asked for", so no read-side shim is needed.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN force_start INTEGER NOT NULL DEFAULT 0`;
});
