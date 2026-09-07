// T3o: the split justification on board_cards (card 11).
//
// One column, additive and guarded exactly like 029's `model_overrides`, and
// defaulting to NULL:
//
//   split_rationale — why the card's latest plan proposal SPLIT it (two or more
//     plans, one child card each, behind a human approval gate). NULL for a card
//     whose latest proposal was a single plan, which MUST match the decoding
//     default on BoardCard.splitRationale (contracts board.ts), so a from-empty
//     replay of a log written before this spec decodes each card's rationale to
//     null and a pre-existing row rehydrates to null — replay equals rehydration.
//
// Plain TEXT rather than JSON: it is one prose paragraph the human reads at the
// gate, not a structure anything parses.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("split_rationale")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN split_rationale TEXT`;
  }
});
