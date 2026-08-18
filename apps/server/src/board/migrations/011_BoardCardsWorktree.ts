// T3o: add the worktree/branch lifecycle column to board_cards (t3o-09, D6).
// Additive and guarded, like 903 — 900..903 have been applied to real
// databases and must never be edited. The column holds the JSON-encoded
// BoardCardWorktree (or is NULL for a card that has not entered Building).
//
// The default is NULL, which MUST match the decoding default on
// BoardCard.worktree (contracts board.ts): a from-empty replay of a
// pre-t3o-09 event log decodes each card's worktree to null, and a
// pre-t3o-09 row rehydrates to null, so replay equals rehydration.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("worktree")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN worktree TEXT`;
  }
});
