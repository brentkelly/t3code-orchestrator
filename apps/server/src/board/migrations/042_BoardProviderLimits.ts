// T3o: the provider-cooldown table (T3O-22, D1/D2).
//
// One row per provider INSTANCE, not per card. A usage limit belongs to a
// provider account: the two cards that motivated this spec hit one in the same
// instant because they share a subscription, and parking only the card that
// noticed leaves every other card on that account to march into the same wall
// seconds later.
//
// Persisted rather than held in memory because the damage happens at BOOT. The
// observed burn began at a server restart's reconcile pass; an in-memory
// cooldown would be lost on restart and every parked card re-nudged the moment
// the server came back — the same bug, reintroduced by its own fix.
//
// A fresh CREATE TABLE, so it is guarded by IF NOT EXISTS and nothing else: this
// lineage is board-owned and numbered from 001 against `t3o_sql_migrations`,
// never upstream's ledger. SCHEMA-QUALIFIED (`boards.`), like every other board
// CREATE TABLE: an unqualified CREATE always lands in `main`, and one board
// table left behind there is enough to make the t3o-26 relocation refuse to run
// — it would read as two divergent copies of the board and halt the boot.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
