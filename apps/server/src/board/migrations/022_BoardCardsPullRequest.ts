// T3o: add the card→pull-request link column to board_cards.
//
// Additive and guarded, exactly like 011's `worktree` column. The column holds
// the JSON-encoded BoardCardPullRequest (or is NULL for a card no lookup has
// found a pull request for).
//
// The default is NULL, which MUST match the decoding default on
// BoardCard.pullRequest (contracts board.ts): a from-empty replay of an event
// log written before this spec decodes each card's pullRequest to null, and a
// pre-existing row rehydrates to null, so replay equals rehydration.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("pull_request")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN pull_request TEXT`;
  }
});
