// T3o: agent write-path plan store (t3o-08, D8). Plan bodies (markdown) live
// ONLY here; the read model holds plan metadata (title, summary, dependsOn,
// ordinal, locked) that the approve gate / write guard / parent auto-advance
// branch on. board_propose_plans replaces a card's rows wholesale; board_
// write_plan updates one body. `depends_on` is a JSON array of plan ids;
// `locked` is 0/1 (SQLite has no boolean).
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
