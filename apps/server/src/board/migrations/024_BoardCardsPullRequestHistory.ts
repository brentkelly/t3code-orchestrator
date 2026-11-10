// `pull_request_floor`: the highest PR number of a finished round; a lookup at or
// below it is refused. Both default to NULL; the read side MUST read a NULL
// history as `[]` to match BoardCard.pullRequestHistory's decoding default.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
