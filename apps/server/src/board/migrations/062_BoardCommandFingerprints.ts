// T3o: type + payload hash per accepted commandId. No backfill; pre-062
// receipts keep aggregate-only replay. SCHEMA-QUALIFIED into `boards`.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
