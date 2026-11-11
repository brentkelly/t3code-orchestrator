// @effect-diagnostics nodeBuiltinImport:off
/**
 * Keeps `boards.sqlite` as a v1 build left it (`boards.pre-v2.sqlite`), since v2
 * migrates it in place. "v1" means a ledger without migration 045; a fresh
 * install keeps nothing, and an existing backup is never overwritten.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { BOARD_SCHEMA } from "./boardDatabase.ts";

export const BOARD_PRE_V2_BACKUP_FILENAME = "boards.pre-v2.sqlite";

/** The board migration a v2 build records on its first boot. */
const FIRST_V2_BOARD_MIGRATION = 45;

class BoardPreV2BackupError extends Schema.TaggedError<BoardPreV2BackupError>()(
  "BoardPreV2BackupError",
  { backup: Schema.String, cause: Schema.Defect() },
) {}

export const backupBoardDatabaseBeforeV2 = Effect.fn("backupBoardDatabaseBeforeV2")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ readonly name: string; readonly file: string }>`
    PRAGMA database_list
  `;
  const file = databases.find((database) => database.name === BOARD_SCHEMA)?.file ?? "";
  if (file === "") return; // in memory: nothing to roll back to

  const ledger = yield* sql<{ readonly name: string }>`
    SELECT name FROM boards.sqlite_master WHERE type = 'table' AND name = 't3o_sql_migrations'
  `;
  if (ledger.length === 0) return; // a fresh board database
  const [latest] = yield* sql<{ readonly id: number | null }>`
    SELECT MAX(migration_id) AS id FROM boards.t3o_sql_migrations
  `;
  if ((latest?.id ?? 0) >= FIRST_V2_BOARD_MIGRATION) return;

  const backup = NodePath.join(NodePath.dirname(file), BOARD_PRE_V2_BACKUP_FILENAME);
  if (NodeFS.existsSync(backup)) return;
  const partial = `${backup}.partial`;
  yield* Effect.tryPromise({
    try: async () => {
      NodeFS.rmSync(partial, { force: true });
      const source = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        await NodeSqlite.backup(source, partial);
      } finally {
        source.close();
      }
      // Only a complete copy takes the name a rollback looks for.
      NodeFS.renameSync(partial, backup);
    },
    catch: (cause) => new BoardPreV2BackupError({ backup, cause }),
  }).pipe(
    Effect.tap(() =>
      Effect.log("Kept the board database as a v1 build left it").pipe(
        Effect.annotateLogs({ backup }),
      ),
    ),
    // A failed copy must not stop the server starting; it is a rollback aid.
    Effect.catch((cause) =>
      Effect.logWarning("Could not keep a pre-v2 copy of the board database", {
        backup,
        cause,
      }),
    ),
  );
});
