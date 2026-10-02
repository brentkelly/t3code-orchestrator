/**
 * T3o: ask git, not the forge, whether a card's branch conflicts with its base
 * (T3O-8).
 *
 * The board learns WHY a merge was refused from the forge's pull-request
 * detail. That read can fail for reasons that have nothing to do with the pull
 * request — a token without the permission for one field, a rate limit, a host
 * the workspace has no CLI for — and a conflict the board cannot see is a
 * conflict nobody resolves: the card just stops. A conflict is the one refusal
 * git can prove on its own, so when the forge cannot answer this does.
 *
 * It compares what the forge compares: the PUSHED branch against the PUSHED
 * base, both fetched first. A local branch with unpushed commits is not what
 * the pull request holds, and a stale base is exactly the case being looked
 * for. `git merge-tree --write-tree` merges in memory and touches no checkout,
 * so it is safe in the project root whatever is checked out there.
 *
 * Total, and three-valued on purpose. Starting a fix agent on a branch with
 * nothing wrong with it is the expensive mistake, so only git's own exit code
 * for "this merge has conflicts" says `conflict`; every failure to look is
 * `unknown`, which the caller treats exactly as it treated a failed probe
 * before this existed.
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
    .pipe(Effect.catch(() => Effect.succeed(null)));
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
