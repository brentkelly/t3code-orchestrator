// Board checks that upstream-owned services call through one-line `T3o:` seams. They are plain
// SQL functions rather than a service because the settlement worker and the storage sweep sit
// outside the board's layer graph. Board tables exist whenever the database is open.
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";

import { CENTRAL_OWNER_MARKER } from "./workspace/LocalBoardWorkspace.ts";

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

/**
 * Whether a settled thread's worktree is one the board still owns, so its settle script waits for
 * the card's retirement. Keyed on the worktree, not the link: an unlinked thread can still sit in a
 * card's checkout, and a linked one can have its own. Read errors answer true.
 */
export const isBoardKeptWorktree = (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  worktreePath: string,
) =>
  boardKeptWorktrees(sql, fs, path).pipe(
    Effect.flatMap((kept) => kept(path.resolve(worktreePath))),
  );
