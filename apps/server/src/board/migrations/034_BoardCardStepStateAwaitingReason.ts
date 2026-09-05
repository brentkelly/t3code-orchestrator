// T3o: why an `awaiting-input` step is waiting, on the step-state row (t3o-34, D3).
//
// `awaiting-input` already means "parked until a human acts", and both ways a
// step reaches it are that state — a question to answer, or a human-in-the-loop
// turn that simply ended. So the split is a reason on one status, not a second
// status: the card renders violet "Input needed" for `question` and amber
// "Needs a human" for `stopped`.
//
// A plain ADD COLUMN (SQLite adds a nullable column without a table rebuild).
// History is NOT rewritten (D7): existing rows get NULL, and every step that
// reached `awaiting-input` before t3o-34 did so through the structured-question
// path — which is exactly `question`, the schema's decoding default. No
// read-side resolution shim is needed.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN awaiting_reason TEXT`;
});
