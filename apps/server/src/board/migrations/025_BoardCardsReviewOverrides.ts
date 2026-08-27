// T3o: per-card review-loop columns on board_cards (t3o-22).
//
// Two columns, both additive and guarded exactly like 011's `worktree` and
// 022's `pull_request`, and both defaulting to NULL:
//
//   review_overrides — the JSON-encoded BoardCardReviewOverrides (D2): this
//     card's round budget, its stop-after-round, and its per-round review
//     model. NULL for a card that never touched them, which MUST match the
//     decoding default on BoardCard.reviewOverrides (contracts board.ts), so a
//     from-empty replay of a log written before this spec decodes each card's
//     overrides to null and a pre-existing row rehydrates to null — replay
//     equals rehydration.
//
//   review_summary — the JSON-encoded projection CACHE the column card reads
//     (D7): round counts, severity and issue tallies, and the loop outcome.
//     Never a source of truth. The pane derives the same facts from the step
//     completions themselves, so this can always be rebuilt from the ledger,
//     and NULL simply means "this card has no review history to summarise".
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("review_overrides")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN review_overrides TEXT`;
  }
  if (!has("review_summary")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN review_summary TEXT`;
  }
});
