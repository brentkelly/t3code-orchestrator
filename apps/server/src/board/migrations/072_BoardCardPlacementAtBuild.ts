// T3o: placement is recorded only at build start (T3O-87). A card placed on a worker with no
// worktree there was placed by a planning spawn: clear it so the gate ranks the card again.
// Cards holding a worktree, and integration branches (`branch-only`), keep theirs.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE board_cards
    SET placed_worker_id = NULL
    WHERE placed_worker_id IS NOT NULL
      AND (
        worktree IS NULL
        OR json_extract(worktree, '$.status') NOT IN ('provisioning', 'ready', 'branch-only')
      )
  `;
});
