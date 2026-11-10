// Plan bodies live only here; the read model holds plan metadata.
// `depends_on` is a JSON array of plan ids; `locked` is 0/1.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_plans (
      plan_id TEXT NOT NULL PRIMARY KEY,
      card_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      locked INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_plans_card
      ON board_plans (card_id)
  `;
});
