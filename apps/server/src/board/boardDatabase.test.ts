/**
 * The board database attach and the legacy relocation (t3o-26 P1).
 *
 * The relocation is the one piece of this phase that touches a user's existing
 * data, so it is tested against the shape a real pre-t3o-26 database has: board
 * tables and their indexes sitting in `main`, with rows in them.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  attachBoardDatabase,
  BOARD_DATABASE_FILENAME,
  relocateBoardSchema,
  resolveBoardDatabasePath,
} from "./boardDatabase.ts";

/** A pre-t3o-26 layout: board tables in `main`, with data and an index. */
const seedLegacyLayout = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE main.board_cards (
      card_id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX main.idx_board_cards_project ON board_cards(project_id)`;
  yield* sql`
    CREATE TABLE main.t3o_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;
  yield* sql`INSERT INTO main.board_cards VALUES ('card-1', 'proj', 'Kept')`;
  yield* sql`INSERT INTO main.board_cards VALUES ('card-2', 'proj', 'Also kept')`;
  yield* sql`INSERT INTO main.t3o_sql_migrations (migration_id, name) VALUES (1, 'BoardCards')`;
  yield* sql`INSERT INTO main.t3o_sql_migrations (migration_id, name) VALUES (2, 'BoardCardBodies')`;
});

const tableNames = (schema: "main" | "boards") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      schema === "main"
        ? yield* sql<{ readonly name: string }>`
            SELECT name FROM main.sqlite_master WHERE type = 'table' ORDER BY name`
        : yield* sql<{ readonly name: string }>`
            SELECT name FROM boards.sqlite_master WHERE type = 'table' ORDER BY name`;
    return rows.map((row) => row.name);
  });

describe("board database", () => {
  describe("path resolution", () => {
    it("puts the board file beside state.sqlite", () => {
      assert.strictEqual(
        resolveBoardDatabasePath("/home/u/.t3/userdata/state.sqlite"),
        `/home/u/.t3/userdata/${BOARD_DATABASE_FILENAME}`,
      );
    });

    // An attached ':memory:' is its own private database, not a second handle on
    // main — which is exactly the isolation the in-memory test layer wants.
    it("keeps an in-memory main in memory", () => {
      assert.strictEqual(resolveBoardDatabasePath(""), ":memory:");
    });

    it("handles a windows path and a bare filename", () => {
      assert.strictEqual(
        resolveBoardDatabasePath("C:\\t3\\state.sqlite"),
        `C:\\t3\\${BOARD_DATABASE_FILENAME}`,
      );
      assert.strictEqual(resolveBoardDatabasePath("state.sqlite"), BOARD_DATABASE_FILENAME);
    });
  });

  it.effect("attaches once and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* attachBoardDatabase();
      yield* attachBoardDatabase();

      const databases = yield* sql<{ readonly name: string }>`PRAGMA database_list`;
      assert.strictEqual(databases.filter((db) => db.name === "boards").length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("moves a legacy layout's tables, indexes, rows and ledger into the board file", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyLayout;
      yield* attachBoardDatabase();
      yield* relocateBoardSchema();

      // Nothing t3o-owned is left in the file stock t3code reads.
      assert.deepStrictEqual(yield* tableNames("main"), []);
      assert.deepStrictEqual(yield* tableNames("boards"), ["board_cards", "t3o_sql_migrations"]);

      // Rows survive.
      const cards = yield* sql<{ readonly card_id: string; readonly title: string }>`
        SELECT card_id, title FROM boards.board_cards ORDER BY card_id`;
      assert.deepStrictEqual(
        cards.map((row) => row.title),
        ["Kept", "Also kept"],
      );

      // The LEDGER MARK survives. Recreating it empty instead would read as
      // high-water mark zero and replay the whole lineage — including migration
      // 007's one-time label seed, resurrecting labels a user had deleted.
      const ledger = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM boards.t3o_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        ledger.map((row) => row.migration_id),
        [1, 2],
      );

      // The explicit index came across; the PRIMARY KEY's auto-index was rebuilt
      // from the table DDL rather than copied (it cannot be created by hand).
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM boards.sqlite_master WHERE type = 'index' ORDER BY name`;
      assert.ok(indexes.some((row) => row.name === "idx_board_cards_project"));

      // And the moved schema is still a working table, constraints intact.
      const duplicate = yield* Effect.result(
        sql`INSERT INTO boards.board_cards VALUES ('card-1', 'proj', 'Duplicate')`,
      );
      assert.strictEqual(duplicate._tag, "Failure");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("is a no-op when there is nothing to relocate", () =>
    Effect.gen(function* () {
      yield* attachBoardDatabase();
      yield* relocateBoardSchema();
      yield* relocateBoardSchema();

      assert.deepStrictEqual(yield* tableNames("boards"), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
  // Finding-driven: a relocation that dies partway used to leave a table already
  // created in `boards` while `main` still held the rest, and the retry died on
  // "table board_cards already exists" — on the boot path, permanently.
  it.effect("resumes after a relocation that died partway", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyLayout;
      yield* attachBoardDatabase();

      // Simulate the interrupted run: the copy transaction committed — a table
      // AND a view landed in `boards` — but the drop-from-main did not.
      yield* sql`CREATE TABLE boards.board_cards (card_id TEXT NOT NULL PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL)`;
      yield* sql`INSERT INTO boards.board_cards VALUES ('card-1', 'proj', 'Half-copied')`;
      yield* sql`CREATE VIEW main.board_titles AS SELECT title FROM board_cards`;
      yield* sql`CREATE VIEW boards.board_titles AS SELECT title FROM board_cards`;

      // The table drop cannot discard a view, so the retry must drop it by name
      // before recreating it — or this call dies on "view already exists".
      yield* relocateBoardSchema();

      assert.deepStrictEqual(yield* tableNames("main"), []);
      const cards = yield* sql<{ readonly title: string }>`
        SELECT title FROM boards.board_cards ORDER BY card_id`;
      // The partial copy was discarded and redone from `main`, not appended to.
      assert.deepStrictEqual(
        cards.map((row) => row.title),
        ["Kept", "Also kept"],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  // `DROP TABLE` takes a table's triggers with it, so anything defined on a board
  // table has to come across too — silently losing a database object mid-migration
  // is not a failure mode worth leaving open.
  it.effect("carries a trigger defined on a board table across", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyLayout;
      yield* sql`
        CREATE TRIGGER main.board_cards_touch AFTER UPDATE ON board_cards
        BEGIN SELECT 1; END
      `;
      yield* attachBoardDatabase();
      yield* relocateBoardSchema();

      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name FROM boards.sqlite_master WHERE type = 'trigger'`;
      assert.deepStrictEqual(
        triggers.map((row) => row.name),
        ["board_cards_touch"],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
