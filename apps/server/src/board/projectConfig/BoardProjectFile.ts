/**
 * T3o: a project's `t3o.json` as an import/export format (T3O-49).
 *
 * Reads the COMMITTED file from the project's default branch in this
 * server's checkout (`git show <remote>/<base>:t3o.json`), after a fetch of
 * the primary remote, keyed by its blob sha; with no fetch it falls back to
 * the local base, flagged "as of last fetch". Writes the working-tree file
 * uncommitted. Never fails: a project with no checkout here is
 * `unavailable`, with the reason.
 *
 * A checkout that lives only on a worker is not read yet (it needs worker
 * git ops), so such a project's import/export is unavailable.
 */
import { T3O_PROJECT_FILE_NAME, parseT3oProjectFile, type ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { ThreadGateway } from "../ThreadGateway.ts";

export type BoardProjectFileRead =
  | { readonly kind: "none"; readonly asOfLastFetch: boolean }
  | {
      readonly kind: "found";
      /** Null when the file isn't valid JSON; `warnings` says why. */
      readonly raw: unknown;
      readonly blobSha: string;
      readonly asOfLastFetch: boolean;
      readonly warnings: ReadonlyArray<string>;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export type BoardProjectFileWrite =
  | { readonly kind: "written"; readonly path: string; readonly blobSha: string | null }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface BoardProjectFileShape {
  readonly readCommitted: (
    projectId: ProjectId,
    options?: { readonly refresh?: boolean },
  ) => Effect.Effect<BoardProjectFileRead>;
  readonly write: (projectId: ProjectId, content: string) => Effect.Effect<BoardProjectFileWrite>;
}

const NO_CHECKOUT = "This project has no checkout on the board's server.";

/** A Reference so every board test layer that wires no reader sees "no
    checkout" and never touches git. */
export class BoardProjectFile extends Context.Reference<BoardProjectFileShape>(
  "t3o/board/BoardProjectFile",
  {
    defaultValue: () => ({
      readCommitted: () => Effect.succeed({ kind: "unavailable", reason: NO_CHECKOUT }),
      write: () => Effect.succeed({ kind: "unavailable", reason: NO_CHECKOUT }),
    }),
  },
) {}

const MEMO_MS = 5 * 60_000;

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const threads = yield* ThreadGateway;
  const memo = new Map<string, { readonly at: number; readonly read: BoardProjectFileRead }>();

  const run = (cwd: string, args: ReadonlyArray<string>, timeoutMs = 15_000) =>
    git
      .execute({
        operation: "board.projectFile",
        cwd,
        args: [...args],
        timeoutMs,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        Effect.catchCause(() => Effect.succeed(null)),
      );

  const checkout = (projectId: ProjectId) =>
    threads.project(projectId).pipe(
      Effect.map((project) =>
        project === null || project.workspaceRoot.length === 0 ? null : project.workspaceRoot,
      ),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const read = Effect.fn("BoardProjectFile.read")(function* (root: string) {
    const remote = yield* git
      .resolvePrimaryRemoteName(root)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const localBranch = (yield* run(root, ["symbolic-ref", "--short", "HEAD"])) ?? "HEAD";
    let ref = localBranch;
    let asOfLastFetch = true;
    if (remote !== null) {
      const fetched = (yield* run(root, ["fetch", "--quiet", remote], 30_000)) !== null;
      const remoteHead = yield* run(root, [
        "symbolic-ref",
        "--short",
        `refs/remotes/${remote}/HEAD`,
      ]);
      const candidate = remoteHead ?? `${remote}/${localBranch}`;
      if (fetched && (yield* run(root, ["rev-parse", "--verify", "--quiet", candidate])) !== null) {
        ref = candidate;
        asOfLastFetch = false;
      }
    }
    const blobSha = yield* run(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}:${T3O_PROJECT_FILE_NAME}`,
    ]);
    if (blobSha === null) return { kind: "none", asOfLastFetch } as const;
    const text = yield* git
      .execute({
        operation: "board.projectFile.show",
        cwd: root,
        args: ["cat-file", "blob", blobSha],
        timeoutMs: 15_000,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
    if (text === null) {
      return {
        kind: "unavailable",
        reason: `${T3O_PROJECT_FILE_NAME} could not be read.`,
      } as const;
    }
    const parsed = parseT3oProjectFile(text);
    return {
      kind: "found",
      raw: parsed.raw,
      blobSha,
      asOfLastFetch,
      warnings: parsed.warning === null ? [] : [`${parsed.warning}; nothing to import.`],
    } as const;
  });

  const readCommitted: BoardProjectFileShape["readCommitted"] = (projectId, options) =>
    Effect.gen(function* () {
      const root = yield* checkout(projectId);
      if (root === null) return { kind: "unavailable", reason: NO_CHECKOUT } as const;
      const cached = memo.get(String(projectId));
      const now = yield* Clock.currentTimeMillis;
      if (options?.refresh !== true && cached !== undefined && now - cached.at < MEMO_MS) {
        return cached.read;
      }
      const result: BoardProjectFileRead = yield* read(root);
      memo.set(String(projectId), { at: now, read: result });
      return result;
    });

  const write: BoardProjectFileShape["write"] = (projectId, content) =>
    Effect.gen(function* () {
      const root = yield* checkout(projectId);
      if (root === null) return { kind: "unavailable", reason: NO_CHECKOUT } as const;
      const filePath = path.join(root, T3O_PROJECT_FILE_NAME);
      const written = yield* fileSystem.writeFileString(filePath, content).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );
      if (!written) {
        return { kind: "unavailable", reason: `${filePath} could not be written.` } as const;
      }
      memo.delete(String(projectId));
      return {
        kind: "written",
        path: filePath,
        blobSha: yield* run(root, ["hash-object", "--", T3O_PROJECT_FILE_NAME]),
      } as const;
    });

  return { readCommitted, write } satisfies BoardProjectFileShape;
});

export const BoardProjectFileLive = Layer.effect(BoardProjectFile, make);
