// No `lower(name)` index: name uniqueness is checked in the decider against the
// resident catalogue, and a SQL collation could disagree with JS `toLowerCase`.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_labels (
      label_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      colour TEXT NOT NULL,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
