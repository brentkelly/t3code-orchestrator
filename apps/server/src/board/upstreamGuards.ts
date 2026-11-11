// Board checks that upstream-owned services call through one-line `T3o:` seams. They are plain
// SQL functions rather than a service because the settlement worker and the storage sweep sit
// outside the board's layer graph. Board tables exist whenever the database is open.
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";

import { CENTRAL_OWNER_MARKER } from "./workspace/LocalBoardWorkspace.ts";

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
 * Whether a worker's checkout belongs to a central board: the marker sits in the worktree's own
 * git dir, so it outlives the card's threads and goes with the worktree. Read errors answer true.
 */
const isCentralOwnedWorktree = (fs: FileSystem.FileSystem, path: Path.Path, worktreePath: string) =>
  fs.readFileString(path.join(worktreePath, ".git")).pipe(
    Effect.map((dotGit) => /^gitdir:\s*(.+?)\s*$/m.exec(dotGit)?.[1] ?? null),
    // No `.git` file: not a linked worktree, which storage cleanup already refuses.
    Effect.orElseSucceed(() => null),
    Effect.flatMap((gitDir) =>
      gitDir === null
        ? Effect.succeed(false)
        : fs
            .exists(path.join(path.resolve(worktreePath, gitDir), CENTRAL_OWNER_MARKER))
            .pipe(Effect.orElseSucceed(() => true)),
    ),
  );

/**
 * Worktrees the board still owns: on central every path a card records (cleared once reclaimed),
 * on a worker every checkout a central board provisioned. Answers an effectful predicate over
 * resolved paths; a read error keeps everything for that sweep.
 */
export const boardKeptWorktrees = (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) =>
  sql<{ readonly path: string }>`
    SELECT json_extract(c.worktree, '$.path') AS path
    FROM boards.board_cards c
    WHERE json_extract(c.worktree, '$.path') IS NOT NULL
  `.pipe(
    Effect.map((rows) => {
      const paths = new Set(rows.map((row) => path.resolve(row.path)));
      return (worktreePath: string) =>
        paths.has(worktreePath)
          ? Effect.succeed(true)
          : isCentralOwnedWorktree(fs, path, worktreePath);
    }),
    Effect.catch((error) =>
      Effect.logWarning("board worktree read failed; keeping every worktree this sweep", {
        error,
      }).pipe(Effect.as((_worktreePath: string) => Effect.succeed(true))),
    ),
  );
