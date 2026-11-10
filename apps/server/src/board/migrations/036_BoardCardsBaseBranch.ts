// NULL follows the project default, resolved live, so a project that moves its
// default doesn't strand cards. MUST match BoardCard.baseBranch's decoding default.
// Also re-adds `split_rationale`: a dev ledger that ran an earlier 035 skips 035.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("base_branch")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN base_branch TEXT`;
  }

  // See the renumber note above. Identical to 035's own guarded add, so a
  // database that ran 035 normally reaches this already satisfied.
  if (!has("split_rationale")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN split_rationale TEXT`;
  }
});
