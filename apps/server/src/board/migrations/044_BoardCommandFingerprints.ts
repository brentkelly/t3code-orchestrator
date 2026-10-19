// T3o: command fingerprints for commandId dedup (issue #120).
//
// Upstream's `orchestration_command_receipts` records only the aggregate a
// commandId was accepted against, so reusing an id for a DIFFERENT command on
// the same aggregate was replayed as success and silently did nothing. This
// table records what each accepted command actually was — its `type` and a
// stable hash of its payload (volatile fields excluded, see
// `board/commandFingerprints.ts`) — so the engine can refuse such a replay.
//
// Kept in a fork-owned table rather than as new columns on the receipt table:
// that table and its migrations belong to upstream, and a fork migration in
// upstream's ledger would pin its high-water mark (see docs/t3o/seams.md).
// Named `board_*` and SCHEMA-QUALIFIED into `boards` like every other table in
// this lineage, so the t3o-26 relocation's prefix discovery treats it as ours.
//
// No backfill: receipts written before this migration have no fingerprint and
// keep the legacy aggregate-only replay behaviour.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_command_fingerprints (
      command_id   TEXT PRIMARY KEY NOT NULL,
      command_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL
    )
  `;
});
