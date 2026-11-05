// T3o: per-project stage configs (T3O-43).
//
// The projection of `board.project-stage-config-set`: one row per project
// whose `t3o.json` the board has reconciled, holding the resolved config
// (removed stages, declared stage ids, execution overrides, warnings and the
// file's source) as JSON. Never the raw file. No row means the project follows
// the global pipeline, so a board that never read one rehydrates exactly as a
// from-empty replay.
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
