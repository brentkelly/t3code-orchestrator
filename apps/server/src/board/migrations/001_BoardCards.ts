// T3o: board card projection table. Board migrations are a separate lineage
// tracked in `t3o_sql_migrations` (see ../migrations/index.ts), so they never
// share a high-water mark with upstream migrations.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_cards (
      card_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_cards_project_created
    ON board_cards(project_id, created_at)
  `;
});
