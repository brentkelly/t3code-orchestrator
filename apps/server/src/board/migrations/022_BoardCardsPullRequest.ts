// The NULL default MUST match the decoding default on BoardCard.pullRequest
// (contracts board.ts), so replay equals rehydration.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
