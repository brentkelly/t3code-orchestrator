/**
 * T3o: `t3 import-threads` (T3O-71) seeds a T3o home (the desktop app's `~/.t3o`) with the
 * stopped threads of an upstream T3 Code home (`~/.t3`).
 *
 * The two never share a data directory: upstream rewrites `settings.json` from its own schema
 * (dropping the `board` block), auto-updates ahead of T3o so its schema can be newer, and owns
 * `<home>/bin/t3`. So the fork copies once instead, through the same copy-and-prune that
 * `vp run migrate-dev-db` uses (`apps/server/scripts/migrate-dev-db.ts`) — never a second copy of
 * those rules. That keeps stopped threads with their forks and subagents — settled ones too, unlike
 * the dev slice, because a settled thread is finished work and most of a user's history — and drops
 * live work, archived and deleted threads,
 * scheduled tasks, queued effects, auth sessions, pairing links and provider runtime rows, so the
 * T3o server never adopts upstream's running agents. The source is only ever read.
 *
 * Board data and `settings.json` are not imported: the board is T3o's own, and an upstream
 * settings file is the thing that drops it.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag, Prompt } from "effect/cli";
import * as NodeURL from "node:url";

import { MigrateDevDbSourceMissingError, runMigrateDevDb } from "../../scripts/migrate-dev-db.ts";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { baseDirFlag } from "../cli/config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { migrationManifest } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { resolveBoardDatabasePath } from "../board/boardDatabase.ts";

export class ImportThreadsSourceNewerError extends Schema.TaggedError<ImportThreadsSourceNewerError>()(
  "ImportThreadsSourceNewerError",
  {
    sourcePath: Schema.String,
    unknownMigrationIds: Schema.Array(Schema.Number),
  },
) {
  override get message(): string {
    return `Your T3 Code is newer than this T3o build — update T3o first. (${this.sourcePath} has migrations ${this.unknownMigrationIds.join(", ")} that this build does not know.)`;
  }
}

export class ImportThreadsDestinationNotEmptyError extends Schema.TaggedError<ImportThreadsDestinationNotEmptyError>()(
  "ImportThreadsDestinationNotEmptyError",
  {
    databasePath: Schema.String,
    threads: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.databasePath} already holds ${this.threads} thread${this.threads === 1 ? "" : "s"}. Import only into an empty T3o home, or pass --replace to discard them.`;
  }
}

export class ImportThreadsSameHomeError extends Schema.TaggedError<ImportThreadsSameHomeError>()(
  "ImportThreadsSameHomeError",
  {
    home: Schema.String,
  },
) {
  override get message(): string {
    return `The source and destination are both ${this.home}. Run T3o's own launcher (~/.t3o/bin/t3 import-threads), or pass --base-dir.`;
  }
}

export class ImportThreadsCancelledError extends Schema.TaggedError<ImportThreadsCancelledError>()(
  "ImportThreadsCancelledError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface RunImportThreadsInput {
  /** The upstream T3 Code home to read. */
  readonly from: string;
  /** The T3o home to seed. */
  readonly baseDir: string;
  /** Keep only projects at these workspace roots. Empty keeps every project. */
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly threadsPerProject: number;
  /** Discard threads already in the destination. */
  readonly replace: boolean;
}

/** Every project the source has; `migrate-dev-db`'s project cap is for dev slices, not imports. */
const ALL_PROJECTS = 1_000_000;

/** Attachment files are `<thread segment>-<uuid>[-<ext>].<ext>` (see `attachmentStore.ts`). */
const ATTACHMENT_FILE_PATTERN =
  /^(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-z0-9]{1,10})?$/i;

/** Reads one database without ever opening it for writing, through a read-only ATTACH. */
const readOnly = <A, E>(
  databasePath: string,
  read: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ATTACH DATABASE ${`${NodeURL.pathToFileURL(databasePath).href}?mode=ro`} AS src`;
    return yield* read(sql).pipe(Effect.ensuring(sql`DETACH DATABASE src`.pipe(Effect.ignore)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const tableExists = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ found: number }>`
    SELECT COUNT(*) AS found FROM src.sqlite_master WHERE type = 'table' AND name = ${table}`.pipe(
    Effect.map((rows) => Number(rows[0]?.found ?? 0) > 0),
  );

/** Upstream migration ids in the source that this build's manifest does not reach. */
const unknownSourceMigrations = (sourcePath: string) =>
  readOnly(sourcePath, (sql) =>
    Effect.gen(function* () {
      if (!(yield* tableExists(sql, "effect_sql_migrations"))) return [];
      const applied = yield* sql<{ migration_id: number }>`
        SELECT migration_id FROM src.effect_sql_migrations`;
      const newest = Math.max(0, ...migrationManifest.map(([id]) => id));
      return applied.map((row) => Number(row.migration_id)).filter((id) => id > newest);
    }),
  );

const countThreads = (databasePath: string) =>
  readOnly(databasePath, (sql) =>
    Effect.gen(function* () {
      if (!(yield* tableExists(sql, "orchestration_v2_projection_threads"))) return 0;
      const rows = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM src.orchestration_v2_projection_threads`;
      return Number(rows[0]?.count ?? 0);
    }),
  );

const countBoardCards = (boardDatabasePath: string) =>
  readOnly(boardDatabasePath, (sql) =>
    Effect.gen(function* () {
      if (!(yield* tableExists(sql, "board_cards"))) return 0;
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM src.board_cards`;
      return Number(rows[0]?.count ?? 0);
    }),
  );

/** Copies the attachment files of the kept threads. Copies, never links, and only reads the source. */
const copyAttachments = Effect.fn("importThreads.copyAttachments")(function* (input: {
  readonly sourceDir: string;
  readonly destinationDir: string;
  readonly threadIds: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(input.sourceDir))) return 0;
  const segments = new Set(
    input.threadIds.flatMap((threadId) => toSafeThreadAttachmentSegment(threadId) ?? []),
  );
  if (segments.size === 0) return 0;
  let copied = 0;
  for (const name of yield* fs.readDirectory(input.sourceDir)) {
    const stem = name.slice(0, name.length - path.extname(name).length);
    const segment = ATTACHMENT_FILE_PATTERN.exec(stem)?.[1]?.toLowerCase();
    if (segment === undefined || !segments.has(segment)) continue;
    const source = path.join(input.sourceDir, name);
    if ((yield* fs.stat(source)).type !== "File") continue;
    yield* fs.makeDirectory(input.destinationDir, { recursive: true });
    yield* fs.copyFile(source, path.join(input.destinationDir, name));
    copied += 1;
  }
  return copied;
});

export const runImportThreads = Effect.fn("runImportThreads")(function* (
  input: RunImportThreadsInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const from = path.resolve(input.from);
  const baseDir = path.resolve(input.baseDir);
  const sourcePath = path.join(from, "userdata", "statev2.sqlite");
  const databasePath = path.join(baseDir, "userdata", "statev2.sqlite");

  const [canonicalFrom, canonicalBaseDir] = yield* Effect.all([
    fs.realPath(from).pipe(Effect.orElseSucceed(() => from)),
    fs.realPath(baseDir).pipe(Effect.orElseSucceed(() => baseDir)),
  ]);
  if (canonicalFrom === canonicalBaseDir) {
    return yield* new ImportThreadsSameHomeError({ home: from });
  }
  if (!(yield* fs.exists(sourcePath))) {
    return yield* new MigrateDevDbSourceMissingError({ sourcePath });
  }
  const unknownMigrationIds = yield* unknownSourceMigrations(sourcePath);
  if (unknownMigrationIds.length > 0) {
    return yield* new ImportThreadsSourceNewerError({ sourcePath, unknownMigrationIds });
  }
  if (yield* fs.exists(databasePath)) {
    const threads = yield* countThreads(databasePath);
    if (threads > 0 && !input.replace) {
      return yield* new ImportThreadsDestinationNotEmptyError({ databasePath, threads });
    }
  }

  // Refuses while a server runs on the destination, and replaces its database wholesale.
  const imported = yield* runMigrateDevDb(
    {
      baseDir,
      source: sourcePath,
      projects: ALL_PROJECTS,
      threadsPerProject: input.threadsPerProject,
      includeSettled: true,
      ...(input.workspaceRoots.length === 0 ? {} : { workspaceRoots: input.workspaceRoots }),
    },
    { sharedHome: from },
  );

  // Open it the way the server boots, so the board database and every migration, upstream's
  // and the board's own lineage, are in place before T3o's server first sees it.
  yield* Effect.scoped(Layer.build(Sqlite.layerFromPath(databasePath)));

  const threadIds = yield* readOnly(databasePath, (sql) =>
    sql<{ thread_id: string }>`SELECT thread_id FROM src.orchestration_v2_projection_threads`.pipe(
      Effect.map((rows) => rows.map((row) => row.thread_id)),
    ),
  );
  const attachmentsCopied = yield* copyAttachments({
    sourceDir: path.join(from, "userdata", "attachments"),
    destinationDir: path.join(baseDir, "userdata", "attachments"),
    threadIds,
  });
  const boardDatabasePath = resolveBoardDatabasePath(databasePath);
  const boardCards = (yield* fs.exists(boardDatabasePath))
    ? yield* countBoardCards(boardDatabasePath)
    : 0;

  return {
    databasePath,
    projects: imported.projects,
    threads: threadIds.length,
    attachmentsCopied,
    boardCards,
  };
});

export const importThreadsCommand = Command.make(
  "import-threads",
  {
    from: Flag.String("from").pipe(
      Flag.optional,
      Flag.withDescription("The T3 Code home to import from. Defaults to ~/.t3."),
    ),
    baseDir: baseDirFlag,
    project: Flag.String("project").pipe(
      Flag.atLeast(0),
      Flag.withDescription("Import only the project at this workspace root. Repeatable."),
    ),
    threadsPerProject: Flag.Int("threads-per-project").pipe(
      Flag.withDefault(50),
      Flag.withDescription(
        "How many recent stopped threads, with their forks and subagents, to import per project.",
      ),
    ),
    replace: Flag.Boolean("replace").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Discard the threads already in this T3o home. Asks first."),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (flags.threadsPerProject < 0) {
        return yield* new ImportThreadsCancelledError({
          reason: "--threads-per-project must be 0 or more.",
        });
      }
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const from = Option.getOrElse(flags.from, () => path.join(homeDirectory, ".t3"));
      // The destination resolves as the server's own home does: --base-dir, T3CODE_HOME, ~/.t3.
      // T3o's launcher (`~/.t3o/bin/t3`) exports T3CODE_HOME=~/.t3o.
      const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
      );
      if (flags.replace) {
        if (!(process.stdin.isTTY && process.stdout.isTTY)) {
          return yield* new ImportThreadsCancelledError({
            reason: "--replace asks before discarding threads, and this is not a terminal.",
          });
        }
        const confirmed = yield* Prompt.run(
          Prompt.Confirm({
            message: `Discard the threads in ${baseDir} and import from ${from}?`,
            initial: false,
          }),
        ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
        if (!confirmed) {
          return yield* new ImportThreadsCancelledError({ reason: "Nothing was imported." });
        }
      }
      const workspaceRoots = flags.project.map((root) => path.resolve(root));
      const result = yield* runImportThreads({
        from,
        baseDir,
        workspaceRoots,
        threadsPerProject: flags.threadsPerProject,
        replace: flags.replace,
      });
      yield* Console.log("");
      yield* Console.log(`Imported ${result.threads} threads into ${result.databasePath}`);
      for (const project of result.projects) {
        yield* Console.log(`  ${project.title}: ${project.threads} threads`);
      }
      yield* Console.log(`  ${result.attachmentsCopied} attachments copied`);
      if (result.boardCards > 0) {
        yield* Console.log(
          `  The board's ${result.boardCards} cards were left as they were; their links to discarded threads no longer open.`,
        );
      }
    }),
).pipe(
  Command.withDescription(
    "Seed this T3o home with the stopped threads of an upstream T3 Code home (~/.t3).",
  ),
);
