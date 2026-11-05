/**
 * T3o: a project's committed `t3o.json` (T3O-43), read from its checkout on
 * this — the central — server. The only source, for every stage: pre-build
 * stages have no worktree (D6), so a branch's own edits apply after merge.
 *
 * Never fails. A missing file is "no file". An unreadable or unparseable one
 * keeps the last version that parsed, plus a warning, so one bad save never
 * resets a project's pipeline; with none it is "no file" plus the warning,
 * and Settings says why. Modelled on upstream's
 * `T3ProjectFileLoader`, with a cache keyed by the file's modification time so
 * the supervisor's 30s sweep reads and runs git only when the file changed.
 */
import {
  T3O_PROJECT_FILE_NAME,
  parseT3oProjectFile,
  type BoardProjectStageConfigSource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";

export interface BoardProjectFileRead {
  /** The parsed JSON, or null when there is no usable file. */
  readonly raw: unknown;
  /** Why the file could not be used at all, when it could not. */
  readonly warnings: ReadonlyArray<string>;
  /** The file path and the checkout's HEAD when it was read; null with no file. */
  readonly source: BoardProjectStageConfigSource | null;
}

const NO_FILE: BoardProjectFileRead = { raw: null, warnings: [], source: null };

export interface BoardProjectConfigShape {
  readonly read: (workspaceRoot: string) => Effect.Effect<BoardProjectFileRead>;
}

/** A Reference rather than a Service so every board test layer that wires no
    reader sees "no project has a t3o.json" — today's board, exactly. */
export class BoardProjectConfig extends Context.Reference<BoardProjectConfigShape>(
  "t3o/board/BoardProjectConfig",
  { defaultValue: () => ({ read: () => Effect.succeed(NO_FILE) }) },
) {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const cache = new Map<string, { readonly stamp: string; readonly read: BoardProjectFileRead }>();
  const lastGood = new Map<string, BoardProjectFileRead>();

  const headSha = (workspaceRoot: string) =>
    git
      .execute({
        operation: "boardProjectConfig.head",
        cwd: workspaceRoot,
        args: ["rev-parse", "HEAD"],
        timeoutMs: 10_000,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          const sha = result.exitCode === 0 ? result.stdout.trim() : "";
          return sha === "" ? null : sha;
        }),
        Effect.catchCause(() => Effect.succeed(null)),
      );

  const read: BoardProjectConfigShape["read"] = Effect.fn("BoardProjectConfig.read")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, T3O_PROJECT_FILE_NAME);
      const stat = yield* fileSystem.stat(filePath).pipe(Effect.option);
      if (Option.isNone(stat)) {
        cache.delete(workspaceRoot);
        lastGood.delete(workspaceRoot);
        return NO_FILE;
      }
      const mtime = Option.getOrNull(stat.value.mtime);
      const stamp = `${mtime?.getTime() ?? "?"}:${stat.value.size}`;
      const cached = cache.get(workspaceRoot);
      if (cached !== undefined && cached.stamp === stamp) return cached.read;

      const source = { path: filePath, commitSha: yield* headSha(workspaceRoot) };
      const text = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
      const parsed = Option.isNone(text) ? null : parseT3oProjectFile(text.value);
      const failure =
        parsed === null ? `${T3O_PROJECT_FILE_NAME} could not be read; ignored.` : parsed.warning;
      const previous = lastGood.get(workspaceRoot);
      const result: BoardProjectFileRead =
        failure === null
          ? { raw: parsed!.raw, warnings: [], source }
          : previous === undefined
            ? { raw: null, warnings: [failure], source }
            : {
                ...previous,
                warnings: [`${failure} Using the last version that could be read.`],
              };
      if (failure === null) lastGood.set(workspaceRoot, result);
      cache.set(workspaceRoot, { stamp, read: result });
      return result;
    },
  );

  return { read } satisfies BoardProjectConfigShape;
});

export const BoardProjectConfigLive = Layer.effect(BoardProjectConfig, make);
