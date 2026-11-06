import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveBoardDatabasePath } from "../board/boardDatabase.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { runImportThreads } from "./importThreads.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const ALPHA_ATTACHMENT = "thread-alpha-0577c6e5-d00b-4ca0-ad35-aa53b9d328b3.png";
const BETA_ATTACHMENT = "thread-beta-13c90186-2602-4abf-b150-1bd005e09b6b-bin.bin";
const RUNNING_ATTACHMENT = "thread-running-05b4e9b3-6746-4200-ae05-3a4dbffcc7f6.png";

/**
 * An upstream T3 Code home: two projects with one stopped thread each, plus a running, a settled
 * and an archived thread, and attachments.
 */
const createUpstreamHome = Effect.fn("createUpstreamHome")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(home, "userdata");
  const attachmentsDir = path.join(stateDir, "attachments");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(attachmentsDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-alpha', 'Alpha', '/work/alpha', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-beta', 'Beta', '/work/beta', '[]', '2026-08-01', '2026-08-02', NULL)`;
      const threads = [
        ["thread-alpha", "project-alpha", "completed"],
        ["thread-beta", "project-beta", "completed"],
        ["thread-running", "project-alpha", "running"],
        ["thread-settled", "project-alpha", "completed"],
        ["thread-archived", "project-alpha", "completed"],
      ] as const;
      const payloads: Record<string, string> = {
        "thread-settled": '{"settledAt":"2026-08-01","settledOverride":"settled"}',
        "thread-archived": '{"archivedAt":"2026-08-01"}',
      };
      for (const [threadId, projectId, runStatus] of threads) {
        const payload = payloads[threadId] ?? "{}";
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', '2026-08-01', ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
      }
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
    }),
  );
  for (const name of [ALPHA_ATTACHMENT, BETA_ATTACHMENT, RUNNING_ATTACHMENT]) {
    yield* fs.writeFileString(path.join(attachmentsDir, name), `bytes of ${name}`);
  }
  return { databasePath, attachmentsDir };
});

const makeHomes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const from = yield* fs.makeTempDirectoryScoped({ prefix: "t3o-import-from-" });
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3o-import-to-" });
  const upstream = yield* createUpstreamHome(from);
  return { from, baseDir, upstream };
});

const keptThreads = (databasePath: string) =>
  withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
      return rows.map((row) => row.thread_id);
    }),
  );

const defaults = { workspaceRoots: [], threadsPerProject: 50, replace: false } as const;

it.layer(NodeServices.layer)("runImportThreads", (it) => {
  it.effect("imports stopped threads and their attachments, and never writes to the source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { from, baseDir, upstream } = yield* makeHomes;
      const sourceBefore = yield* fs.readFile(upstream.databasePath);
      const sourceAttachmentsBefore = yield* fs.readDirectory(upstream.attachmentsDir);

      const result = yield* runImportThreads({ ...defaults, from, baseDir });

      assert.equal(result.databasePath, path.join(baseDir, "userdata", "statev2.sqlite"));
      // Settled threads are finished history and come along; running and archived ones do not.
      assert.deepStrictEqual(yield* keptThreads(result.databasePath), [
        "thread-alpha",
        "thread-beta",
        "thread-settled",
      ]);
      assert.equal(result.threads, 3);
      assert.equal(result.attachmentsCopied, 2);
      const copied = yield* fs.readDirectory(path.join(baseDir, "userdata", "attachments"));
      assert.deepStrictEqual([...copied].sort(), [BETA_ATTACHMENT, ALPHA_ATTACHMENT].sort());
      assert.equal(
        yield* fs.readFileString(path.join(baseDir, "userdata", "attachments", ALPHA_ATTACHMENT)),
        `bytes of ${ALPHA_ATTACHMENT}`,
      );

      // Live work and credentials stay behind.
      const authSessions = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM auth_sessions`;
          return Number(rows[0]?.count);
        }),
      );
      assert.equal(authSessions, 0);

      // Opened as the server boots: the board database and its own ledger exist.
      const boardLedger = yield* withDatabase(
        path.join(baseDir, "userdata", "boards.sqlite"),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM t3o_sql_migrations`;
          return Number(rows[0]?.count);
        }),
      );
      assert.isAbove(boardLedger, 0);
      assert.equal(result.boardCards, 0);

      // The source is byte-for-byte untouched.
      assert.deepStrictEqual(yield* fs.readFile(upstream.databasePath), sourceBefore);
      assert.deepStrictEqual(
        [...(yield* fs.readDirectory(upstream.attachmentsDir))].sort(),
        [...sourceAttachmentsBefore].sort(),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("imports only the projects named by --project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { from, baseDir } = yield* makeHomes;

      const result = yield* runImportThreads({
        ...defaults,
        from,
        baseDir,
        workspaceRoots: ["/work/beta"],
      });

      assert.deepStrictEqual(yield* keptThreads(result.databasePath), ["thread-beta"]);
      assert.deepStrictEqual(
        result.projects.map((project) => project.title),
        ["Beta"],
      );
      assert.deepStrictEqual(
        yield* fs.readDirectory(path.join(baseDir, "userdata", "attachments")),
        [BETA_ATTACHMENT],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a source migrated by a newer T3 Code than this build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { from, baseDir, upstream } = yield* makeHomes;
      yield* withDatabase(
        upstream.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (999999, 'FromTheFuture')`;
        }),
      );

      const error = yield* runImportThreads({ ...defaults, from, baseDir }).pipe(Effect.flip);

      assert.equal(error._tag, "ImportThreadsSourceNewerError");
      assert.include(
        error.message,
        "Your T3 Code is newer than this T3o build — update T3o first.",
      );
      assert.isFalse(yield* fs.exists(path.join(baseDir, "userdata", "statev2.sqlite")));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a destination that already has threads unless told to replace them", () =>
    Effect.gen(function* () {
      const { from, baseDir } = yield* makeHomes;
      const first = yield* runImportThreads({
        ...defaults,
        from,
        baseDir,
        workspaceRoots: ["/work/beta"],
      });
      assert.deepStrictEqual(yield* keptThreads(first.databasePath), ["thread-beta"]);

      const error = yield* runImportThreads({ ...defaults, from, baseDir }).pipe(Effect.flip);
      assert.equal(error._tag, "ImportThreadsDestinationNotEmptyError");
      assert.deepStrictEqual(yield* keptThreads(first.databasePath), ["thread-beta"]);

      const replaced = yield* runImportThreads({ ...defaults, from, baseDir, replace: true });
      assert.deepStrictEqual(yield* keptThreads(replaced.databasePath), [
        "thread-alpha",
        "thread-beta",
        "thread-settled",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a destination that has projects but no threads", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { from, baseDir } = yield* makeHomes;
      const databasePath = path.join(baseDir, "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations();
          yield* sql`INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
            VALUES ('project-own', 'Own', '/work/own', '[]', '2026-08-01', '2026-08-01', NULL)`;
        }),
      );

      const error = yield* runImportThreads({ ...defaults, from, baseDir }).pipe(Effect.flip);
      assert.equal(error._tag, "ImportThreadsDestinationNotEmptyError");
      assert.include(error.message, "1 project");
      const projects = yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ project_id: string }>`SELECT project_id FROM projection_projects`;
        }),
      );
      assert.deepStrictEqual(
        projects.map((row) => row.project_id),
        ["project-own"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a destination whose board already has cards", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { from, baseDir } = yield* makeHomes;
      const databasePath = path.join(baseDir, "userdata", "statev2.sqlite");
      const boardDatabasePath = resolveBoardDatabasePath(databasePath);
      yield* fs.makeDirectory(path.dirname(boardDatabasePath), { recursive: true });
      yield* withDatabase(
        boardDatabasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE board_cards (id TEXT PRIMARY KEY)`;
          yield* sql`INSERT INTO board_cards (id) VALUES ('card-1')`;
        }),
      );

      const error = yield* runImportThreads({ ...defaults, from, baseDir }).pipe(Effect.flip);
      assert.equal(error._tag, "ImportThreadsDestinationNotEmptyError");
      assert.include(error.message, "1 board card");
      assert.isFalse(yield* fs.exists(databasePath));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to import a home into itself", () =>
    Effect.gen(function* () {
      const { from } = yield* makeHomes;
      const error = yield* runImportThreads({ ...defaults, from, baseDir: from }).pipe(Effect.flip);
      assert.equal(error._tag, "ImportThreadsSameHomeError");
    }).pipe(Effect.scoped),
  );
});
