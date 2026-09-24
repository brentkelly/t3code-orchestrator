// T3o: the per-card publish-on-done attempt on board_cards.
//
// Additive and nullable, matching 043's `auto_merge_hold`:
//
//   publish — JSON of the last publish-on-done attempt for this card's current
//     round, or NULL when none has run. NULL is the resting value, and a card
//     whose attempt has been cleared for Retry must be indistinguishable from
//     one that has never published, or rehydration would depend on which of
//     the two it is looking at.
//
// MUST match the decoding default on `BoardCard.publish` (contracts board.ts),
// so a from-empty replay of a log written before this spec decodes each card
// to null and a pre-existing row rehydrates to the same: replay equals
// rehydration.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("publish")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN publish TEXT`;
  }
});
