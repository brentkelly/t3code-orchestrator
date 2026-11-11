// NULL defaults MUST match the decoding default on BoardCard.reviewOverrides.
// `review_summary` is a cache rebuilt from the step completions, never a source
// of truth; NULL means no review history.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
