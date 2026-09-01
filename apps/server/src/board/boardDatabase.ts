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

/**
 * Quote an identifier for the raw statements the relocation builds by hand
 * (`sql.unsafe` takes no bindings). The names come from `sqlite_master` in this
 * same database, so this is defence in depth rather than an injection boundary —
 * but an unquoted identifier would break on any name that needs quoting.
 */
const quoted = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

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
  // The pragma reports the mode actually in force, which is worth logging: an
  // attached database silently starts in `delete` mode regardless of `main`, and
  // ':memory:' reports `memory` and cannot take WAL at all.
  const journal = yield* sql<{ readonly journal_mode: string }>`
    PRAGMA boards.journal_mode = WAL
  `;
  // A board file that refuses WAL is a durability regression, and Debug sits
  // below the default minimum level — so the unexpected case is a warning, not a
  // line nobody sees. ':memory:' reports `memory` and cannot take WAL at all,
  // which is expected rather than notable.
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
 * RE-RUNNABLE, which matters more than it sounds. SQLite normalises
 * `IF NOT EXISTS` out of stored DDL, so a relocation that dies partway — disk
 * full, power loss, a killed process — leaves some tables already created in
 * `boards` and the rest still in `main`. A naive retry then fails with
 * "table board_cards already exists" ON THE BOOT PATH, and the install never
 * starts again. Dropping each target on entry discards a partial copy and redoes
 * it, which is safe because `main` stays authoritative until the final drops.
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

  // Indexes, and also views and triggers: the board schema defines none today,
  // but `DROP TABLE` would take any that existed with it, and silently losing a
  // database object mid-migration is not a failure mode worth leaving open.
  const companions = yield* sql<{
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }>`
    SELECT name, tbl_name, sql FROM main.sqlite_master
    WHERE type IN ('index', 'view', 'trigger')
      AND (substr(tbl_name, 1, 6) = ${BOARD_TABLE_PREFIX} OR tbl_name = ${BOARD_LEDGER_TABLE})
  `;

  const move = Effect.gen(function* () {
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
      yield* sql.unsafe(
        companion.sql.replace(
          /^CREATE\s+(UNIQUE\s+)?(INDEX|VIEW|TRIGGER)\s+/i,
          (match) => `${match}${BOARD_SCHEMA}.`,
        ),
      );
    }

    // Dropping the table drops its indexes and triggers with it.
    for (const table of tables) {
      yield* sql.unsafe(`DROP TABLE main.${quoted(table.name)}`);
    }
  });

  // One transaction: an error rolls the copy back rather than leaving a
  // half-populated board database behind.
  yield* sql.withTransaction(move);

  yield* Effect.log("Relocated board schema into the board database").pipe(
    Effect.annotateLogs({
      tables: tables.length,
      companions: companions.filter((companion) => companion.sql !== null).length,
    }),
  );
});
