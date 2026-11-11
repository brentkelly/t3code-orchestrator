// The board watermark lives in the board database: SQLite in WAL mode commits
// attached databases separately, so a watermark in `main` could land without the
// board rows it covers and the projector would skip events.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Carry an existing watermark across: restarting at zero would replay the whole
  // log and stall boot on a large one. Upstream's 063 drops
  // `main.projection_state`, so a fresh database has none to carry.
  const upstreamState = yield* sql`
    SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'projection_state'
  `;
  if (upstreamState.length === 0) return;
  yield* sql`
    INSERT OR IGNORE INTO boards.projection_state (projector, last_applied_sequence, updated_at)
    SELECT projector, last_applied_sequence, updated_at
    FROM main.projection_state
    WHERE projector LIKE 'projection.board-%'
  `;
  yield* sql`DELETE FROM main.projection_state WHERE projector LIKE 'projection.board-%'`;
});
