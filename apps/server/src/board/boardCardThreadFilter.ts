// T3o: which threads are board card threads, for the Settled shelf's filter (T3O-78).
//
// A card thread is any thread a card links (any role, tombstoned or not, archived cards too), or,
// on a worker, any thread a central board spawned here. A worker thread linked to a card by hand is
// in neither table on that worker, so it still lists: a known, accepted gap. Clients learn the set
// only from these reads, so the shelf and the server never disagree on it.
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

const cardThreadIds = (sql: SqlClient.SqlClient) => sql`
  SELECT thread_id FROM boards.board_card_thread_links
  UNION SELECT thread_id FROM boards.board_relayed_threads
`;

// Uncorrelated so SQLite builds it once; a correlated scan per card thread blocked the server for
// seconds on real data. NULLs are dropped because `NOT IN` over a NULL is never true.
const subagentAncestorIds = (sql: SqlClient.SqlClient) => sql`
  SELECT ancestor_id FROM (
    SELECT json_extract(payload_json, '$.lineage.parentThreadId') AS ancestor_id,
      json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship
    FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
    UNION ALL
    SELECT json_extract(payload_json, '$.lineage.rootThreadId'),
      json_extract(payload_json, '$.lineage.relationshipToParent')
    FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
  )
  WHERE relationship = 'subagent' AND ancestor_id IS NOT NULL
`;

/**
 * A `card_thread` column (1 or 0) for a query over `orchestration_v2_projection_threads t`. Without
 * the filter it is a constant 0, so the unfiltered query reads no board table.
 */
export const boardCardThreadColumn = (sql: SqlClient.SqlClient, exclude: boolean | undefined) =>
  exclude === true
    ? sql`, (t.thread_id IN (${cardThreadIds(sql)})) AS card_thread`
    : sql`, 0 AS card_thread`;

/** `AND threads.thread_id NOT IN (card threads)` when `exclude` is set, else nothing. */
export const boardCardThreadExclusion = (sql: SqlClient.SqlClient, exclude: boolean) =>
  exclude ? sql`AND threads.thread_id NOT IN (${cardThreadIds(sql)})` : sql``;

/**
 * Card threads a shell cut at `before` may carry: every one except older settled threads that are
 * neither pinned, snoozed, nor above a subagent, which the shell leaves out. Extra ids are
 * harmless; a missing one would show a card thread in Settled, so this errs wide.
 */
export const readShellBoardCardThreadIds = (sql: SqlClient.SqlClient, before: string) =>
  sql<{ readonly thread_id: string }>`
    SELECT t.thread_id FROM orchestration_v2_projection_threads t
    WHERE t.thread_id IN (${cardThreadIds(sql)})
      AND t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.archivedAt') IS NULL
      AND NOT (
        json_extract(t.payload_json, '$.settledOverride') IS 'settled'
        AND json_extract(t.payload_json, '$.settledAt') IS NOT NULL
        AND json_extract(t.payload_json, '$.settledAt') < ${before}
        AND json_extract(t.payload_json, '$.pinnedAt') IS NULL
        AND json_extract(t.payload_json, '$.snoozedUntil') IS NULL
        AND t.thread_id NOT IN (${subagentAncestorIds(sql)})
      )
  `.pipe(Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))));
