// T3o: when a HUMAN last started a turn on a step's thread (T3O-17, D4).
//
// A human typing into a running unattended step must never draw a resume nudge
// on top of what they just said. The signal that suppresses it is durable
// rather than in-memory so it survives a restart, a crash and a projection
// rebuild — a kill between the human's message and the turn ending must not
// bring the nudge back.
//
// A plain ADD COLUMN (SQLite adds a nullable column without a table rebuild).
// History is not rewritten: existing rows get NULL, which already MEANS "no
// human turn is owed a free ending" — the schema's decoding default. No
// read-side resolution shim is needed.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN human_turn_at TEXT`;
});
