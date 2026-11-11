// The round a thread link belongs to (T3O-75). No backfill: a null round reads
// as round 0, which is only consulted while the card itself is on round 0.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_thread_links)
  `;
  if (columns.some((column) => column.name === "pull_request_round")) return;
  yield* sql`ALTER TABLE board_card_thread_links ADD COLUMN pull_request_round INTEGER`;
});
