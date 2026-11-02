// T3o: which threads are board card threads, for the Settled shelf's filter (T3O-78).
//
// A card thread is any thread a card links (any role, tombstoned or not, archived cards too), or,
// on a worker, any thread a central board spawned here. A worker thread linked to a card by hand is
// in neither table on that worker, so it still lists: a known, accepted gap.
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * A `card_thread` column (1 or 0) for a query over `orchestration_v2_projection_threads t`. Without
 * the filter it is a constant 0, so the unfiltered query reads no board table.
 */
export const boardCardThreadColumn = (sql: SqlClient.SqlClient, exclude: boolean | undefined) =>
  exclude === true
    ? sql`, (t.thread_id IN (
          SELECT thread_id FROM board_card_thread_links
          UNION SELECT thread_id FROM boards.board_relayed_threads
        )) AS card_thread`
    : sql`, 0 AS card_thread`;
