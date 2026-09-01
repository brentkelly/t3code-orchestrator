/**
 * The board's own database file (t3o-26).
 *
 * Everything t3o owns lives in `boards.sqlite`, attached to the SAME connection
 * as upstream's `state.sqlite` under the schema name `boards`. One connection,
 * not two: SQLite handles the locking, cross-schema reads stay a single
 * statement, and — the reason it matters — a transaction that only writes
 * `boards.*` is confined to one database, so it stays atomic under WAL. SQLite
 * only loses cross-database atomicity for transactions that MODIFY more than one
 * attached file.
 *
 * The path is derived from `PRAGMA database_list` rather than from `ServerConfig`
 * so that no upstream file has to learn about the board's existence (D8), and so
 * the in-memory test layer works unchanged: an attached `:memory:` is its own
 * private database, exactly the isolation the tests want.
 *
 * Resolution rules this module depends on, verified against `node:sqlite`:
 *
 * | Statement                      | Unqualified behaviour        |
 * | ------------------------------ | ---------------------------- |
 * | `CREATE TABLE`                 | lands in `main` — must qualify |
 * | `CREATE INDEX`                 | ERRORS across schemas — must qualify |
 * | `ALTER` / `INSERT` / `SELECT`  | resolves to `boards` correctly |
 * | `PRAGMA table_info`            | resolves to `boards` correctly |
 *
 * That is why the migrations qualify their `CREATE` statements and nothing else:
 * the minimum churn that is still unambiguous.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Schema name the board database is attached under. */
export const BOARD_SCHEMA = "boards";

/** Board database filename, alongside `state.sqlite` in the state directory. */
export const BOARD_DATABASE_FILENAME = "boards.sqlite";

/** Tables belonging to the board lineage, by name prefix and by exact name. */
const BOARD_TABLE_PREFIX = "board_";
const BOARD_LEDGER_TABLE = "t3o_sql_migrations";

/**
 * Where the board database goes, given `main`'s file from `PRAGMA database_list`.
 *
 * An empty main file means `:memory:` — the test layer — and the board gets its
 * own `:memory:`, which SQLite makes a distinct private database rather than a
 * second handle on the same one. Otherwise the board file sits beside
 * `state.sqlite`, so a state directory stays one self-describing unit and
 * `rm boards.sqlite` is the whole of "stop using t3o".
 */
export const resolveBoardDatabasePath = (mainFile: string): string => {
  if (mainFile === "") return ":memory:";
  const separator = Math.max(mainFile.lastIndexOf("/"), mainFile.lastIndexOf("\\"));
  return separator < 0
    ? BOARD_DATABASE_FILENAME
    : `${mainFile.slice(0, separator + 1)}${BOARD_DATABASE_FILENAME}`;
};

/**
 * Attach the board database, idempotently.
 *
 * `journal_mode` is PER-DATABASE: an attached file starts in `delete` mode
 * regardless of what `main` is set to, so WAL has to be asked for again by name.
 * (On `:memory:` it reports `memory` and the pragma is a no-op — harmless.)
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
  yield* sql`PRAGMA boards.journal_mode = WAL`;
  yield* Effect.logDebug("Attached board database").pipe(
    Effect.annotateLogs({ schema: BOARD_SCHEMA, path: target }),
  );
});

/**
 * Move a pre-t3o-26 database's board tables out of `main` and into `boards`.
 *
 * Schema-PRESERVING, deliberately. The obvious alternative — run the whole board
 * lineage against `boards` to build the schema, then copy the rows — breaks a
 * PARTIALLY migrated database: it would apply every migration's schema while the
 * copied rows had only ever been through some of them, and the data migrations
 * in the lineage (007 seeds labels; 012 and 016 recompute `blocked`) would run
 * against empty tables and then be overwritten. Moving each table exactly as it
 * stands, ledger mark included, leaves the Migrator to run whatever is still
 * pending against the moved tables — the normal path, on the normal schedule.
 *
 * The ledger is COPIED, never recreated. An empty ledger in `boards` reads as
 * high-water mark zero and replays the entire lineage, including migration 007's
 * one-time label seed — resurrecting seed labels the user has since deleted.
 *
 * Idempotent: a no-op once `main` holds no board tables, which is every boot
 * after the first and every database created under t3o-26.
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

  const indexes = yield* sql<{
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }>`
    SELECT name, tbl_name, sql FROM main.sqlite_master
    WHERE type = 'index'
      AND (substr(tbl_name, 1, 6) = ${BOARD_TABLE_PREFIX} OR tbl_name = ${BOARD_LEDGER_TABLE})
  `;

  for (const table of tables) {
    // SQLite normalises `IF NOT EXISTS` out of stored DDL, so the text always
    // starts `CREATE TABLE <name>`; inserting the schema after that prefix is
    // the whole rewrite.
    if (table.sql === null) continue;
    yield* sql.unsafe(table.sql.replace(/^CREATE TABLE\s+/i, `CREATE TABLE ${BOARD_SCHEMA}.`));
    yield* sql.unsafe(`INSERT INTO ${BOARD_SCHEMA}.${table.name} SELECT * FROM main.${table.name}`);
  }

  for (const index of indexes) {
    // A null `sql` is an auto-index backing a PRIMARY KEY or UNIQUE constraint —
    // SQLite recreates those from the table DDL, and they cannot be created by
    // hand.
    if (index.sql === null) continue;
    yield* sql.unsafe(
      index.sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (match) => `${match}${BOARD_SCHEMA}.`),
    );
  }

  // Dropping the table drops its indexes with it.
  for (const table of tables) {
    yield* sql.unsafe(`DROP TABLE main.${table.name}`);
  }

  yield* Effect.log("Relocated board schema into the board database").pipe(
    Effect.annotateLogs({
      tables: tables.length,
      indexes: indexes.filter((index) => index.sql !== null).length,
    }),
  );
});
