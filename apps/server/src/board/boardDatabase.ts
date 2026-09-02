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
 * | `ALTER` / `INSERT` / `SELECT`  | resolves to `boards` — IF `main` has no table of that name |
 * | `PRAGMA table_info`            | resolves to `boards` — same condition |
 *
 * The search order is `main` first, so an unqualified name only reaches `boards`
 * when `main` cannot satisfy it. That holds for every `board_*` table, which is
 * why the migrations qualify their `CREATE` statements and nothing else. It does
 * NOT hold for a table that exists in both files — `projection_state` does, since
 * migration 031 — and every read of one of those is qualified explicitly.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

/**
 * Both files hold a board schema, and the one in `boards` is not a proven copy of
 * the one in `main`. Relocation refuses rather than pick a side: either choice
 * destroys real data, and only a human knows which copy is the one they want.
 */
export class BoardRelocationConflictError extends Schema.TaggedErrorClass<BoardRelocationConflictError>()(
  "BoardRelocationConflictError",
  {
    mainTables: Schema.Array(Schema.String),
    boardTables: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return (
      "Refusing to relocate the board schema: both state.sqlite and boards.sqlite hold board " +
      "tables, and boards.sqlite is not a copy of state.sqlite. This happens after running an " +
      "older build (which recreated the board tables in state.sqlite) and then upgrading again. " +
      "Keep ONE copy: to keep the newer data in state.sqlite, delete boards.sqlite; to keep the " +
      "older data in boards.sqlite, drop the board_* tables and t3o_sql_migrations from " +
      "state.sqlite. Then start again."
    );
  }
}

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

/** Row-for-row equality of the two migration ledgers, timestamps included. */
const ledgersIdentical = Effect.fn("ledgersIdentical")(function* () {
  const sql = yield* SqlClient.SqlClient;
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
  return (onlyInMain[0]?.n ?? 1) === 0 && (onlyInBoards[0]?.n ?? 1) === 0;
});

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

  // `main` is authoritative ONLY when `boards` holds nothing, or holds exactly
  // the copy this relocation made. There is a third state: an older build ran in
  // between — it knows nothing of `boards.sqlite`, so it recreated the board
  // schema in `main` from scratch and the user worked in it — and now BOTH files
  // hold real, divergent board data. Dropping either side destroys cards.
  //
  // The two states are told apart by the migration LEDGER. This relocation
  // copies it row-for-row in the same transaction as the tables, so a resumed
  // relocation finds `boards.t3o_sql_migrations` identical to `main`'s,
  // timestamps included. An older build re-running the lineage stamps fresh
  // timestamps, so the ledgers differ. Anything other than an identical ledger
  // refuses, loudly, with both copies left exactly as they are.
  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM boards.sqlite_master
    WHERE type = 'table'
      AND (substr(name, 1, 6) = ${BOARD_TABLE_PREFIX} OR name = ${BOARD_LEDGER_TABLE})
    ORDER BY name
  `;
  if (existing.length > 0) {
    const bothHaveLedger =
      tables.some((table) => table.name === BOARD_LEDGER_TABLE) &&
      existing.some((table) => table.name === BOARD_LEDGER_TABLE);
    const provenCopy = bothHaveLedger && (yield* ledgersIdentical());
    if (!provenCopy) {
      return yield* new BoardRelocationConflictError({
        mainTables: tables.map((table) => table.name),
        boardTables: existing.map((table) => table.name),
      });
    }
  }

  // Indexes, and also views and triggers: the board schema defines none today,
  // but `DROP TABLE` would take any that existed with it, and silently losing a
  // database object mid-migration is not a failure mode worth leaving open.
  //
  // Known limit: for a view, `tbl_name` is the view's OWN name, so only views
  // following the `board_` naming convention are discovered. Deciding by
  // definition text instead is not mechanically sound — a view joining board and
  // upstream tables belongs in neither file, and relocating it would break it —
  // so a view over board tables must be named `board_*` to move with them.
  const companions = yield* sql<{
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }>`
    SELECT name, tbl_name, sql FROM main.sqlite_master
    WHERE type IN ('index', 'view', 'trigger')
      AND (substr(tbl_name, 1, 6) = ${BOARD_TABLE_PREFIX} OR tbl_name = ${BOARD_LEDGER_TABLE})
  `;

  // TWO transactions, each confined to ONE database. A single transaction
  // spanning both would be the very thing this module exists to avoid: SQLite
  // does not commit across attached databases atomically under WAL, so a tear
  // could drop `main`'s tables without the copies in `boards` having landed —
  // total, silent loss of every card.
  //
  // Split this way there is no lossy intermediate state. If the copy fails,
  // `boards` rolls back and `main` is untouched. If the copy commits and the
  // drop does not, both copies exist; the next run drops and redoes the copy,
  // then drops again. `main` stays authoritative until the second transaction.
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
