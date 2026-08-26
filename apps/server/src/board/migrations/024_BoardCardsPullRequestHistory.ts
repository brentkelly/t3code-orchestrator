// T3o: add the card's pull-request history and floor columns to board_cards.
//
// Additive and guarded, exactly like 011's `worktree` and 022's `pull_request`.
// A card that is dragged back out of Done after its worktree was reclaimed
// starts a NEW round of work on a re-cut branch, so `pull_request` — which
// tracks the CURRENT round only — retires into `pull_request_history` and
// `pull_request_floor` rises to shut the finished round out of the new one.
//
//   pull_request_history  JSON array of BoardCardPullRequest, oldest first.
//   pull_request_floor    Highest pull-request number belonging to a finished
//                         round; a lookup at or below it is refused.
//
// Both default to NULL, which MUST match the decoding defaults on
// BoardCard.pullRequestHistory (`[]`) and .pullRequestFloor (`null`) in
// contracts board.ts: a from-empty replay of an event log written before this
// spec decodes to those, and a pre-existing row must rehydrate to the same, so
// replay equals rehydration. The read side is therefore responsible for
// reading a NULL history column as the empty array.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("pull_request_history")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN pull_request_history TEXT`;
  }
  if (!has("pull_request_floor")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN pull_request_floor INTEGER`;
  }
});
