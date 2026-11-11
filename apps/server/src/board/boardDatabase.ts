/**
 * The board's own database file, `boards.sqlite`, attached to upstream's connection as schema
 * `boards`. Unqualified `CREATE TABLE` lands in `main` and `CREATE INDEX` errors across schemas;
 * other statements resolve to `boards` only when `main` has no table of that name, so a table in
 * both files (`projection_state`) is always qualified.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Schema name the board database is attached under. */
export const BOARD_SCHEMA = "boards";

/** Board database filename, alongside `state.sqlite` in the state directory. */
export const BOARD_DATABASE_FILENAME = "boards.sqlite";

/**
 * Quote an identifier for the raw statements the relocation builds by hand
 * (`sql.unsafe` takes no bindings). The names come from `sqlite_master` in this
 * same database, so this is defence in depth rather than an injection boundary —
 * but an unquoted identifier would break on any name that needs quoting.
 */
const quoted = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/**
 * Both files hold a board schema, and the one in `boards` is not a proven copy of
 * the one in `main`. Relocation refuses rather than pick a side: either choice
 * destroys real data, and only a human knows which copy is the one they want.
 */
export class BoardRelocationConflictError extends Schema.TaggedError<BoardRelocationConflictError>()(
  "BoardRelocationConflictError",
  {
    /** The main database's file name, from `PRAGMA database_list`. */
    mainFile: Schema.String,
    mainTables: Schema.Array(Schema.String),
    boardTables: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const main = this.mainFile;
    return (
      `Refusing to relocate the board schema: both ${main} and boards.sqlite hold board ` +
      `tables, and boards.sqlite is not a copy of ${main}. This happens after running an ` +
      `older build (which recreated the board tables in ${main}) and then upgrading again. ` +
      `Keep ONE copy: to keep the newer data in ${main}, delete boards.sqlite; to keep the ` +
      `older data in boards.sqlite, drop the board_* tables and t3o_sql_migrations from ` +
      `${main}. Then start again.`
    );
  }
}

/** The bare file name of `main`, for a message a human acts on. */
const mainFileName = Effect.fn("mainFileName")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ readonly name: string; readonly file: string }>`
    PRAGMA database_list
  `;
  const file = databases.find((database) => database.name === "main")?.file ?? "";
  const name = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
  return name === "" ? "the main database" : name;
});

/** Tables belonging to the board lineage, by name prefix and by exact name. */
const BOARD_TABLE_PREFIX = "board_";
const BOARD_LEDGER_TABLE = "t3o_sql_migrations";

/**
 * Where the board database goes, given `main`'s file from `PRAGMA database_list`. An empty main
 * file is the `:memory:` test layer, and an attached `:memory:` is its own private database.
 */
export const resolveBoardDatabasePath = (mainFile: string): string => {
  if (mainFile === "") return ":memory:";
  const separator = Math.max(mainFile.lastIndexOf("/"), mainFile.lastIndexOf("\\"));
  return separator < 0
    ? BOARD_DATABASE_FILENAME
    : `${mainFile.slice(0, separator + 1)}${BOARD_DATABASE_FILENAME}`;
};

/** The board database for the SQLite reader worker, which opens `main` alone. */
export const boardReaderAttachments = (mainFile: string) => [
  { schema: BOARD_SCHEMA, filename: resolveBoardDatabasePath(mainFile) },
];

/** Row-for-row equality of the two migration ledgers, timestamps included. */
const ledgersIdentical = Effect.fn("ledgersIdentical")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // At least one shared row is REQUIRED: two EMPTY ledgers also EXCEPT to zero, which would read
  // as a proven copy and let the relocation overwrite `boards` from `main`. Fail closed.
  const shared = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM (
      SELECT migration_id, name, created_at FROM main.t3o_sql_migrations
      INTERSECT
      SELECT migration_id, name, created_at FROM boards.t3o_sql_migrations
    )
  `;
  const onlyInMain = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM (
      SELECT migration_id, name, created_at FROM main.t3o_sql_migrations
      EXCEPT
      SELECT migration_id, name, created_at FROM boards.t3o_sql_migrations
    )
  `;
  const onlyInBoards = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM (
      SELECT migration_id, name, created_at FROM boards.t3o_sql_migrations
      EXCEPT
      SELECT migration_id, name, created_at FROM main.t3o_sql_migrations
    )
  `;
  return (
    (shared[0]?.n ?? 0) > 0 && (onlyInMain[0]?.n ?? 1) === 0 && (onlyInBoards[0]?.n ?? 1) === 0
  );
});

/** The -wal size the board file is cut back to after a reset; `main`'s own
    limit (`persistence/Sqlite.ts`), which the board must not import. */
const BOARD_WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Attach the board database, idempotently. `journal_mode`, `synchronous` and
 * `journal_size_limit` are PER-DATABASE, so each is set again by name for the attached file.
 */
export const attachBoardDatabase = Effect.fn("attachBoardDatabase")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const databases = yield* sql<{ readonly name: string; readonly file: string }>`
    PRAGMA database_list
  `;
  if (databases.some((database) => database.name === BOARD_SCHEMA)) return;

  const mainFile = databases.find((database) => database.name === "main")?.file ?? "";
  const target = resolveBoardDatabasePath(mainFile);

  yield* sql`ATTACH DATABASE ${target} AS ${sql(BOARD_SCHEMA)}`;
  // The pragma reports the mode actually in force, which is worth logging: an
  // attached database silently starts in `delete` mode regardless of `main`, and
  // ':memory:' reports `memory` and cannot take WAL at all.
  const journal = yield* sql<{ readonly journal_mode: string }>`
    PRAGMA boards.journal_mode = WAL
  `;
  // A board file that refuses WAL is a durability regression, so it warns (`:memory:` cannot take
  // WAL and is expected). NORMAL as `main`: in WAL it fsyncs only at checkpoints.
  yield* sql`PRAGMA boards.synchronous = NORMAL`;
  yield* sql.unsafe(`PRAGMA boards.journal_size_limit = ${BOARD_WAL_SIZE_LIMIT_BYTES}`);
  const journalMode = journal[0]?.journal_mode ?? "unknown";
  const expected = target === ":memory:" ? "memory" : "wal";
  yield* journalMode === expected
    ? Effect.logDebug("Attached board database").pipe(
        Effect.annotateLogs({ schema: BOARD_SCHEMA, path: target, journalMode }),
      )
    : Effect.logWarning("Board database is not in the expected journal mode").pipe(
        Effect.annotateLogs({ schema: BOARD_SCHEMA, path: target, journalMode, expected }),
      );
});

/**
 * Move a legacy database's board tables, ledger COPIED with them, from `main` into `boards`
 * exactly as they stand, so a partially migrated database keeps its high-water mark (an empty
 * ledger would replay one-time seeds). Re-runnable: each target is dropped on entry, since a
 * relocation that died partway leaves some tables already created.
 */
export const relocateBoardSchema = Effect.fn("relocateBoardSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string; readonly sql: string | null }>`
    SELECT name, sql FROM main.sqlite_master
    WHERE type = 'table'
      AND (substr(name, 1, 6) = ${BOARD_TABLE_PREFIX} OR name = ${BOARD_LEDGER_TABLE})
    ORDER BY name
  `;
  if (tables.length === 0) return;

  // `main` is authoritative ONLY when `boards` is empty or holds this relocation's own copy. An
  // older build may have recreated the schema in `main` since, leaving BOTH with real data. The
  // ledger, copied row-for-row with identical timestamps, tells them apart; anything else refuses.
  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM boards.sqlite_master
    WHERE type = 'table'
      AND (substr(name, 1, 6) = ${BOARD_TABLE_PREFIX} OR name = ${BOARD_LEDGER_TABLE})
    ORDER BY name
  `;
  // A conflict needs DATA on both sides. The ledger is bookkeeping: `main`
  // holding only a freshly seeded ledger (the legacy 900+ reconciler puts it
  // there just before this runs) while `boards` already holds the tables is a
  // ledger move, not two copies of the user's cards.
  const isData = (name: string) => name !== BOARD_LEDGER_TABLE;
  const mainHasData = tables.some((table) => isData(table.name));
  const boardsHasData = existing.some((table) => isData(table.name));
  if (mainHasData && boardsHasData) {
    const bothHaveLedger =
      tables.some((table) => table.name === BOARD_LEDGER_TABLE) &&
      existing.some((table) => table.name === BOARD_LEDGER_TABLE);
    const provenCopy = bothHaveLedger && (yield* ledgersIdentical());
    if (!provenCopy) {
      return yield* new BoardRelocationConflictError({
        mainFile: yield* mainFileName(),
        mainTables: tables.map((table) => table.name),
        boardTables: existing.map((table) => table.name),
      });
    }
  }

  // Indexes, views and triggers move too, or `DROP TABLE` would silently take them. A view is
  // found by its own name, so a view over board tables must be named `board_*` to move.
  const companions = yield* sql<{
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }>`
    SELECT name, tbl_name, sql FROM main.sqlite_master
    WHERE type IN ('index', 'view', 'trigger')
      AND (substr(tbl_name, 1, 6) = ${BOARD_TABLE_PREFIX} OR tbl_name = ${BOARD_LEDGER_TABLE})
  `;

  // TWO transactions, each confined to ONE database: SQLite does not commit across attached
  // databases atomically under WAL. A failed copy rolls back; a failed drop leaves both copies,
  // and the next run redoes the copy. `main` stays authoritative until the drop commits.
  const copyIntoBoardDatabase = Effect.gen(function* () {
    for (const table of tables) {
      // SQLite normalises `IF NOT EXISTS` out of stored DDL, so the text always
      // starts `CREATE TABLE <name>`; inserting the schema after that prefix is
      // the whole rewrite. Dropping first is what lets a resumed relocation
      // succeed — `main` still holds the authoritative rows at this point.
      if (table.sql === null) continue;
      yield* sql.unsafe(`DROP TABLE IF EXISTS ${BOARD_SCHEMA}.${quoted(table.name)}`);
      yield* sql.unsafe(table.sql.replace(/^CREATE TABLE\s+/i, `CREATE TABLE ${BOARD_SCHEMA}.`));
      yield* sql.unsafe(
        `INSERT INTO ${BOARD_SCHEMA}.${quoted(table.name)} SELECT * FROM main.${quoted(table.name)}`,
      );
    }

    for (const companion of companions) {
      // A null `sql` is an auto-index backing a PRIMARY KEY or UNIQUE constraint
      // — SQLite recreates those from the table DDL, and they cannot be created
      // by hand.
      if (companion.sql === null) continue;
      // Indexes and triggers were discarded by the table drops above, but a VIEW
      // survives them — `DROP TABLE IF EXISTS` cannot remove a view — so a
      // relocation resumed after the copy committed would otherwise die on
      // "view already exists", on the boot path.
      if (/^CREATE\s+VIEW/i.test(companion.sql)) {
        yield* sql.unsafe(`DROP VIEW IF EXISTS ${BOARD_SCHEMA}.${quoted(companion.name)}`);
      }
      yield* sql.unsafe(
        companion.sql.replace(
          /^CREATE\s+(UNIQUE\s+)?(INDEX|VIEW|TRIGGER)\s+/i,
          (match) => `${match}${BOARD_SCHEMA}.`,
        ),
      );
    }
  });

  const dropFromMain = Effect.gen(function* () {
    // A view is not dropped by `DROP TABLE`, so copied views are dropped by name
    // first; indexes and triggers do go with their table.
    for (const companion of companions) {
      if (companion.sql === null || !/^CREATE\s+VIEW/i.test(companion.sql)) continue;
      yield* sql.unsafe(`DROP VIEW IF EXISTS main.${quoted(companion.name)}`);
    }
    for (const table of tables) {
      yield* sql.unsafe(`DROP TABLE main.${quoted(table.name)}`);
    }
  });

  yield* sql.withTransaction(copyIntoBoardDatabase);
  yield* sql.withTransaction(dropFromMain);

  yield* Effect.log("Relocated board schema into the board database").pipe(
    Effect.annotateLogs({
      tables: tables.length,
      companions: companions.filter((companion) => companion.sql !== null).length,
    }),
  );
});
