// Schema-qualified (`boards.`) like every board CREATE: an unqualified one lands
// in `main`, and a board table left there makes the board relocation refuse to
// run.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_provider_limits (
      provider_instance_id TEXT PRIMARY KEY NOT NULL,
      kind                 TEXT NOT NULL,
      until                TEXT NOT NULL,
      detected_at          TEXT NOT NULL,
      last_checked_at      TEXT NOT NULL,
      reason               TEXT,
      rule_id              TEXT,
      source_card_id       TEXT,
      known_time           INTEGER NOT NULL DEFAULT 0,
      blind_since          TEXT,
      probe_card_id        TEXT,
      set_by_human         INTEGER NOT NULL DEFAULT 0
    )
  `;
});
