// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { BOARD_PRE_V2_BACKUP_FILENAME } from "./boardPreV2Backup.ts";

const latestBoardMigration = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare("SELECT MAX(migration_id) AS id FROM t3o_sql_migrations").get();
    return (row as { readonly id: number }).id;
  } finally {
    database.close();
  }
};

it.effect("keeps one copy of a board database a v1 build left, as it was (T3O-59)", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-board-pre-v2-"));
  const statePath = NodePath.join(directory, "statev2.sqlite");
  const boardsPath = NodePath.join(directory, "boards.sqlite");
  const backupPath = NodePath.join(directory, BOARD_PRE_V2_BACKUP_FILENAME);
  const open = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(
      Effect.provide(
        SqlitePersistence.layerFromPath(statePath).pipe(Layer.provide(NodeServices.layer)),
      ),
    );

  return Effect.gen(function* () {
    // A fresh install: nothing was there before v2, so nothing is kept.
    yield* open(Effect.void);
    assert.isFalse(NodeFS.existsSync(backupPath));
    assert.strictEqual(latestBoardMigration(boardsPath), 45);

    // The board as a v1 build left it: its ledger stops short of the v2 marker.
    yield* open(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`DELETE FROM boards.t3o_sql_migrations WHERE migration_id >= 45`.pipe(Effect.asVoid),
      ),
    );
    yield* open(Effect.void);
    assert.isTrue(NodeFS.existsSync(backupPath));
    assert.strictEqual(latestBoardMigration(backupPath), 44);
    assert.strictEqual(latestBoardMigration(boardsPath), 45);

    // Kept once: later boots leave the copy alone.
    const kept = NodeFS.statSync(backupPath).mtimeMs;
    yield* open(Effect.void);
    assert.strictEqual(NodeFS.statSync(backupPath).mtimeMs, kept);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
