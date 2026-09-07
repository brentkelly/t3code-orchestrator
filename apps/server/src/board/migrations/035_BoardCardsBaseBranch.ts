// T3o: the per-card base branch on board_cards (T3O-5).
//
// One column, additive and guarded exactly like 029's `model_overrides`, and
// defaulting to NULL:
//
//   base_branch — the LOCAL branch name this card's work is cut from and merges
//     back into (D1). NULL means "follow the project default, resolved at
//     provisioning time" — today's behaviour — and MUST match the decoding
//     default on BoardCard.baseBranch (contracts board.ts), so a from-empty
//     replay of a log written before this spec decodes each card's base to null
//     and a pre-existing row rehydrates to null: replay equals rehydration.
//
// A nullable OVERRIDE rather than a materialised branch name, so a project that
// later moves its default does not strand a fleet of cards pinned to a branch
// that no longer exists.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("base_branch")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN base_branch TEXT`;
  }
});
