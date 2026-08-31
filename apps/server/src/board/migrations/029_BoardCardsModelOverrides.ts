// T3o: per-card, per-stage model overrides on board_cards (t3o-29).
//
// One column, additive and guarded exactly like 025's `review_overrides`, and
// defaulting to NULL:
//
//   model_overrides — the JSON-encoded BoardCardModelOverrides (D1): a map from
//     stage id to the model, reasoning options and access level THIS card's run
//     of that stage uses. NULL for a card that never set one, which MUST match
//     the decoding default on BoardCard.modelOverrides (contracts board.ts), so
//     a from-empty replay of a log written before this spec decodes each card's
//     overrides to null and a pre-existing row rehydrates to null — replay
//     equals rehydration.
//
// Keyed by stage id rather than by role even though the popover offers only the
// build and review rows: two rows is a judgement about the UI, and keying the
// COLUMN by role would put that judgement somewhere only a migration could undo.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("model_overrides")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN model_overrides TEXT`;
  }
});
