// Board checks that upstream-owned services call through one-line `T3o:` seams. They are plain
// SQL functions rather than a service because the settlement worker and the storage sweep sit
// outside the board's layer graph. Board tables exist whenever the database is open.
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Whether a card links this thread (tombstoned links included) or, on a worker, a central board
 * spawned it. Fails closed: a read error answers true.
 */
export const isBoardCardThread = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly found: number }>`
    SELECT 1 AS found FROM boards.board_card_thread_links WHERE thread_id = ${threadId}
    UNION ALL
    SELECT 1 AS found FROM boards.board_relayed_threads WHERE thread_id = ${threadId}
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.catch((error) =>
      Effect.logWarning("board card thread check failed; treating it as a card thread", {
        threadId,
        error,
      }).pipe(Effect.as(true)),
    ),
  );

/**
 * Worktrees the board still owns: on central every path a card records (cleared once reclaimed),
 * on a worker every relayed thread's worktree. Answers a predicate over resolved paths; a read
 * error keeps everything for that sweep.
 */
export const boardKeptWorktrees = (sql: SqlClient.SqlClient, resolve: (path: string) => string) =>
  sql<{ readonly path: string }>`
    SELECT json_extract(c.worktree, '$.path') AS path
    FROM boards.board_cards c
    WHERE json_extract(c.worktree, '$.path') IS NOT NULL
    UNION
    SELECT json_extract(t.payload_json, '$.worktreePath') AS path
    FROM orchestration_v2_projection_threads t
    JOIN boards.board_relayed_threads r ON r.thread_id = t.thread_id
    WHERE json_extract(t.payload_json, '$.worktreePath') IS NOT NULL
  `.pipe(
    Effect.map((rows) => {
      const paths = new Set(rows.map((row) => resolve(row.path)));
      return (worktreePath: string) => paths.has(worktreePath);
    }),
    Effect.catch((error) =>
      Effect.logWarning("board worktree read failed; keeping every worktree this sweep", {
        error,
      }).pipe(Effect.as((_worktreePath: string) => true)),
    ),
  );
