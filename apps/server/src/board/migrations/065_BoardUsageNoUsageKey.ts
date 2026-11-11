// T3o: a turn first stored as reporting no usage remembers which usage row counted it, so
// a later finished event for the same turn that does carry usage can replace it (T3O-77).
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_usage_ingested)`;
  if (columns.some((column) => column.name === "no_usage_card_id")) return;
  yield* sql`ALTER TABLE boards.board_usage_ingested ADD COLUMN no_usage_card_id TEXT`;
  yield* sql`ALTER TABLE boards.board_usage_ingested ADD COLUMN no_usage_step_id TEXT`;
  yield* sql`ALTER TABLE boards.board_usage_ingested ADD COLUMN no_usage_provider TEXT`;
  yield* sql`ALTER TABLE boards.board_usage_ingested ADD COLUMN no_usage_model TEXT`;
});
