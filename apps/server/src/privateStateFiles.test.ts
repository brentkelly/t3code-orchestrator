// @effect-diagnostics nodeBuiltinImport:off
/** T3o: owner-only state files and durable atomic writes (#123, #139). */
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { deriveServerPaths, ensureServerDirectories } from "./config.ts";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite.ts";
import { sqliteDatabaseFiles } from "./privateStateFiles.ts";

const modeOf = (filePath: string) => NodeFS.statSync(filePath).mode & 0o777;

describe.skipIf(process.platform === "win32")("private state files", () => {
  it.effect("creates a new atomically written file owner-only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-private-atomic-" });
      const filePath = path.join(dir, "settings.json");

      yield* writeFileStringAtomically({ filePath, contents: '{"a":1}\n' });

      assert.strictEqual(NodeFS.readFileSync(filePath, "utf8"), '{"a":1}\n');
      assert.strictEqual(modeOf(filePath), 0o600);
      // The scoped temp directory is gone; only the target remains.
      assert.deepStrictEqual(NodeFS.readdirSync(dir), ["settings.json"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the existing mode of the file it replaces", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-private-atomic-" });
      const privatePath = path.join(dir, "private.json");
      const sharedPath = path.join(dir, "shared.json");
      NodeFS.writeFileSync(privatePath, "old");
      NodeFS.chmodSync(privatePath, 0o600);
      NodeFS.writeFileSync(sharedPath, "old");
      NodeFS.chmodSync(sharedPath, 0o644);

      yield* writeFileStringAtomically({ filePath: privatePath, contents: "new" });
      yield* writeFileStringAtomically({ filePath: sharedPath, contents: "new" });

      assert.strictEqual(NodeFS.readFileSync(privatePath, "utf8"), "new");
      assert.strictEqual(modeOf(privatePath), 0o600);
      assert.strictEqual(modeOf(sharedPath), 0o644);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restricts the state directory to its owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-private-state-" });
      const paths = yield* deriveServerPaths(baseDir, undefined);
      NodeFS.mkdirSync(paths.stateDir, { recursive: true, mode: 0o775 });
      NodeFS.chmodSync(paths.stateDir, 0o775);

      yield* ensureServerDirectories(paths);

      assert.strictEqual(modeOf(paths.stateDir), 0o700);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restricts the sqlite databases and their WAL siblings to their owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-private-sqlite-" });
      const dbPath = path.join(dir, "state.sqlite");

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT 1`;
        const present = sqliteDatabaseFiles(dbPath).filter((file) => NodeFS.existsSync(file));
        // state.sqlite and boards.sqlite, each with -wal and -shm while open.
        assert.includeMembers(present, [dbPath, path.join(dir, "boards.sqlite")]);
        for (const file of present) assert.strictEqual(modeOf(file), 0o600, file);
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
