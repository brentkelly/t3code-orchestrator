/**
 * T3o private state files — owner-only permissions and durable writes for the
 * server's state tree (#123, #139).
 *
 * The state directory holds `settings.json` (provider API keys), the pairing
 * credentials in `state.sqlite`, and the board database. On a default umask
 * all of it lands group/world-readable, so:
 *
 * - `restrictStateDirectory` chmods the state dir to 0700 at startup. It is
 *   always a `userdata`/`dev` child of the T3 home, never a user-chosen
 *   directory, so tightening it cannot surprise anyone.
 * - `withPrivateSqliteFiles` chmods `state.sqlite`, `boards.sqlite` and their
 *   `-wal`/`-shm` siblings to 0600 once the connection is open and the board
 *   database attached (SQLite creates the siblings itself, at 0644).
 * - `writePrivateTempFile` + `syncDirectory` back `writeFileStringAtomically`:
 *   the temp file takes the target's existing mode (0600 when there is no
 *   target) before it is renamed over it, and is fsynced first, so an atomic
 *   replace neither widens a 0600 file nor leaves a zero-length one after a
 *   power loss.
 *
 * Every chmod is skipped on win32, where POSIX modes mean nothing. A chmod that
 * fails (e.g. a file owned by another user) is logged and startup continues:
 * hardening must never be the reason the server does not boot.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveBoardDatabasePath } from "./board/boardDatabase.ts";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const supportsPosixModes = () => process.platform !== "win32";

const restrictPath = (fs: FileSystem.FileSystem, target: string, mode: number) =>
  fs.chmod(target, mode).pipe(
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.void
        : Effect.logWarning("Could not restrict permissions on a private state path.", {
            path: target,
            mode: mode.toString(8),
            cause: cause.message,
          }),
    ),
  );

/** chmod the state directory to 0700. Never fails. */
export const restrictStateDirectory = (stateDir: string) =>
  Effect.gen(function* () {
    if (!supportsPosixModes()) return;
    const fs = yield* FileSystem.FileSystem;
    yield* restrictPath(fs, stateDir, PRIVATE_DIRECTORY_MODE);
  });

/** The on-disk files a SQLite persistence layer opened at `dbPath` owns. */
export const sqliteDatabaseFiles = (dbPath: string): ReadonlyArray<string> => {
  const boardsPath = resolveBoardDatabasePath(dbPath);
  return [dbPath, boardsPath].flatMap((file) => [file, `${file}-wal`, `${file}-shm`]);
};

/**
 * Wraps a SQLite persistence layer so that, once it (and its setup, which
 * attaches `boards.sqlite`) is built, every database file is 0600.
 */
export const withPrivateSqliteFiles =
  (fs: FileSystem.FileSystem, dbPath: string) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, E, R> => {
    if (!supportsPosixModes() || dbPath === "" || dbPath === ":memory:") return layer;
    return Layer.provideMerge(
      Layer.effectDiscard(
        Effect.forEach(
          sqliteDatabaseFiles(dbPath),
          (file) => restrictPath(fs, file, PRIVATE_FILE_MODE),
          { discard: true },
        ),
      ),
      layer,
    );
  };

/** The mode a replacement for `targetPath` should carry: the target's own, else 0600. */
const resolveReplacementMode = (fs: FileSystem.FileSystem, targetPath: string) =>
  fs.stat(targetPath).pipe(
    Effect.map((info) => info.mode & 0o777),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound" ? Effect.succeed(PRIVATE_FILE_MODE) : Effect.fail(cause),
    ),
  );

/**
 * Writes `contents` to a fresh `tempPath` destined to be renamed over
 * `targetPath`: created with the target's mode (0600 if the target does not
 * exist), chmodded to that mode regardless of umask, and fsynced before return.
 */
export const writePrivateTempFile = (input: {
  readonly tempPath: string;
  readonly targetPath: string;
  readonly contents: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const posix = supportsPosixModes();
    const mode = posix ? yield* resolveReplacementMode(fs, input.targetPath) : undefined;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(input.tempPath, { flag: "wx", mode });
        yield* file.writeAll(new TextEncoder().encode(input.contents));
        yield* file.sync;
      }),
    );
    if (mode !== undefined) yield* fs.chmod(input.tempPath, mode);
  });

/** fsync a directory so a rename into it is durable. Best effort; no-op on win32. */
export const syncDirectory = (directory: string) =>
  Effect.gen(function* () {
    if (!supportsPosixModes()) return;
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.scoped(
      fs.open(directory, { flag: "r" }).pipe(Effect.flatMap((handle) => handle.sync)),
    ).pipe(Effect.ignore);
  });
