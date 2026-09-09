// T3o: why a `stalled` step stopped, and when it next tries (T3O-22, D10).
//
// Two columns, additive and guarded exactly like 034's `awaiting_reason`:
//
//   stalled_reason — one of `usage-limit` | `quota-exhausted` | `waiting-retry`
//     | `gave-up`. NULL reads as `gave-up`, which is what every stalled row
//     written before this spec actually was: recovery giving up. It MUST match
//     the decoding default on BoardCardStepState.stalledReason (contracts
//     board.ts), so a from-empty replay of a log written before this spec
//     decodes each step to `gave-up` and a pre-existing row rehydrates to
//     `gave-up`: replay equals rehydration.
//
//   retry_at — the ISO instant the board will try this step again, or NULL when
//     nothing is scheduled. NULL is the honest resting value: before this spec
//     the next nudge went instantly, so no row had a time to record.
//
// Nullable rather than NOT NULL with a default, because `retry_at` genuinely has
// a third state ("nothing scheduled") and the two columns should read the same
// way. History is NOT rewritten: existing rows get NULL on both.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_step_state)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("stalled_reason")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN stalled_reason TEXT`;
  }
  if (!has("retry_at")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN retry_at TEXT`;
  }
});
