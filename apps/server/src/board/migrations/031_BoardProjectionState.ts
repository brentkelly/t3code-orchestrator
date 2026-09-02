// T3o-26 P1: the board projector's watermark moves into the board database.
//
// The projection pipeline commits a projector's writes and its watermark in ONE
// transaction. With the board tables in `boards.sqlite` and the watermark still
// in `main.projection_state`, that transaction spans two attached databases —
// and SQLite gives up cross-database atomicity in WAL mode, committing each
// database separately. The dangerous half of that split is the watermark landing
// while the board rows do not: the projector would then skip events it never
// applied, losing a card update with no way to notice.
//
// Same schema as upstream's `projection_state` (Migrations/005_Projections.ts),
// deliberately: this is the same concept, just owned by the board so the board's
// transaction stays inside one file.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Carry an existing board watermark across rather than restarting it at zero:
  // a fresh watermark would replay the whole log through the board projector.
  // That is idempotent (every board write is an upsert) but needlessly expensive,
  // and on a large log it would stall boot.
  yield* sql`
    INSERT OR IGNORE INTO boards.projection_state (projector, last_applied_sequence, updated_at)
    SELECT projector, last_applied_sequence, updated_at
    FROM main.projection_state
    WHERE projector LIKE 'projection.board-%'
  `;
  yield* sql`DELETE FROM main.projection_state WHERE projector LIKE 'projection.board-%'`;
});
