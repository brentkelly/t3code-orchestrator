// T3o: the per-card auto-merge arm and its hold on board_cards (T3O-38).
//
// Two columns, additive and guarded exactly like 039's `auto_start`:
//
//   auto_merge — whether this card merges its own pull request as soon as the
//     forge accepts it, instead of parking in the merge stage until somebody
//     clicks Merge. 0 means "wait here for a click" — today's behaviour and
//     every card that has never been armed. NOT NULL with a default, like
//     `auto_start`: a card is armed or it is not, and a NULL would only invite
//     a reader to invent a meaning for it. Unlike `auto_start` this arm is
//     never SPENT — a card dragged back out of Done and merged again is still
//     armed, which is the honest reading of "always merge this one".
//
//   auto_merge_hold — the forge's last refusal of an armed merge and where the
//     retry ladder stands, as JSON, or NULL when nothing is held. Nullable for
//     the reason `model_overrides` is: NULL is the resting value, and a card
//     whose hold has been cleared must be indistinguishable from one that was
//     never refused, or rehydration would depend on which of the two it is
//     looking at.
//
// Both MUST match the decoding defaults on `BoardCard.autoMerge` /
// `BoardCard.autoMergeHold` (contracts board.ts), so a from-empty replay of a
// log written before this spec decodes each card to (false, null) and a
// pre-existing row rehydrates to the same: replay equals rehydration.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("auto_merge")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0`;
  }
  if (!has("auto_merge_hold")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN auto_merge_hold TEXT`;
  }
});
