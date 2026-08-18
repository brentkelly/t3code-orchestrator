// T3o: board label catalogue (t3o-06a). The user-managed vocabulary that
// replaces the closed card-type union. Numbered from 900_ upward so it can
// never collide with an upstream migration id. Seeding and card conversion are
// the separate data migration 906_ (a table create and a data backfill are
// kept apart, mirroring 900/903).
//
// No secondary index: the case-insensitive name-uniqueness check is a decision
// gate, so it runs against the in-memory read model in the decider (D8), never
// as a SQL lookup — the whole catalogue is already resident. A `lower(name)`
// SQL index would be unused AND its collation could disagree with the decider's
// JS `toLowerCase`, so it is deliberately omitted (no-speculative-inventory).
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_labels (
      label_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      colour TEXT NOT NULL,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
