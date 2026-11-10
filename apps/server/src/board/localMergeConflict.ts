/**
 * Ask git, not the forge, whether a card's PUSHED branch conflicts with its PUSHED base, for when
 * the forge's merge detail cannot be read. `git merge-tree --write-tree` touches no checkout.
 * Three-valued: only git's own conflict exit code says `conflict`; any failure to look is `unknown`.
 */
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export type BoardLocalMergeConflict = "conflict" | "clean" | "unknown";

export const probeLocalMergeConflict = Effect.fn("probeLocalMergeConflict")(function* (input: {
  /** Passed in rather than read from context so this stays a leaf, matching
      `pullMergedBaseBranch`: the reactor already holds the driver. */
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  /** The PROJECT ROOT. The card's worktree may already have been reclaimed. */
  readonly cwd: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}) {
  const { git, cwd, headBranch, baseBranch } = input;

  const remoteName = yield* git
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.orElseSucceed(() => null));
  if (remoteName === null) return "unknown" satisfies BoardLocalMergeConflict;

  const run = (operation: string, args: ReadonlyArray<string>, timeoutMs: number) =>
    git
      .execute({ operation, cwd, args, timeoutMs, allowNonZeroExit: true })
      .pipe(Effect.catchCause(() => Effect.succeed(null)));

  // Explicit refspecs, so the answer does not depend on how the clone's
  // default fetch refspec is configured. The leading `+` only ever moves a
  // remote-tracking ref, which a force-pushed branch legitimately needs.
  const remoteRef = (branch: string) => `refs/remotes/${remoteName}/${branch}`;
  const fetched = yield* run(
    "board.localMergeConflict.fetch",
    [
      "fetch",
      "--no-tags",
      remoteName,
      `+refs/heads/${baseBranch}:${remoteRef(baseBranch)}`,
      `+refs/heads/${headBranch}:${remoteRef(headBranch)}`,
    ],
    60_000,
  );
  if (fetched === null || fetched.exitCode !== 0) {
    return "unknown" satisfies BoardLocalMergeConflict;
  }

  // Exit 0 is a clean merge. Exit 1 is a merge with conflicts, but ALSO a ref
  // git could not resolve — and only a merge that actually ran prints the tree
  // it wrote, so the conflict verdict needs both. Anything else is git failing
  // to try (a git too old to know `--write-tree`).
  const merged = yield* run(
    "board.localMergeConflict.mergeTree",
    ["merge-tree", "--write-tree", "--name-only", remoteRef(baseBranch), remoteRef(headBranch)],
    30_000,
  );
  if (merged === null) return "unknown" satisfies BoardLocalMergeConflict;
  if (merged.exitCode === 0) return "clean" satisfies BoardLocalMergeConflict;
  if (merged.exitCode === 1 && /^[0-9a-f]{40,64}\b/.test(merged.stdout)) {
    return "conflict" satisfies BoardLocalMergeConflict;
  }
  return "unknown" satisfies BoardLocalMergeConflict;
});
