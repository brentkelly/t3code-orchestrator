// Holds the resolved config, never the raw file. No row means the project follows
// the global pipeline, so replay equals rehydration.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_project_stage_configs (
      project_id  TEXT PRIMARY KEY NOT NULL,
      config_json TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `;
});
