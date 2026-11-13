// T3o: re-price stored card usage after the Claude otherUsage fix (T3O-90). The rows the
// backfill can rebuild are cleared and its marker dropped, so it reruns at the next start:
// live local links plus their app-owned delegate children, which it walks the same way.
// Worker-hosted rows stay, since the backfill cannot reach them.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const RECOMPUTED_THREADS = `
  WITH RECURSIVE recomputed(thread_id) AS (
    SELECT thread_id FROM boards.board_card_thread_links
    WHERE tombstoned_at IS NULL AND (worker_id IS NULL OR worker_id = 'local')
    UNION
    SELECT subagents.child_thread_id
    FROM main.orchestration_v2_projection_subagents AS subagents
    JOIN recomputed ON subagents.thread_id = recomputed.thread_id
    WHERE subagents.origin = 'app_owned' AND subagents.child_thread_id IS NOT NULL
  )
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    ${RECOMPUTED_THREADS}
    DELETE FROM boards.board_usage_ingested
    WHERE thread_id IN (SELECT thread_id FROM recomputed)
  `);
  yield* sql.unsafe(`
    ${RECOMPUTED_THREADS}
    DELETE FROM boards.board_card_usage
    WHERE thread_id IN (SELECT thread_id FROM recomputed)
  `);
  yield* sql`
    DELETE FROM boards.projection_state WHERE projector = 'projection.board-usage-backfill'
  `;
});
