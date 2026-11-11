/**
 * Fast-forwards the project-root checkout's local base branch after a forge
 * merge, so new worktrees branch from the merged commits. Fast-forward only:
 * a diverged base is left alone. Best-effort: every failure is a reported
 * skip, since the card is already merged.
 */
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { safeProcessOutput } from "../vcs/VcsProcess.ts";

/** What a sync attempt did, for the log and (eventually) the activity rail. */
export interface BoardBaseBranchSyncResult {
  readonly updated: boolean;
  /** Why the base branch was left untouched; null when it was fast-forwarded.
      Human-facing and scrubbed of any embedded remote credential. */
  readonly skippedReason: string | null;
}

/**
 * Fast-forward the local `baseBranch` in the checkout at `cwd` to its remote
 * tip.
 *
 * `cwd` is the PROJECT ROOT, not the card's worktree: the root is the clone new
 * worktrees fork from, and it is where the base branch (`main`) actually lives.
 */
export const pullMergedBaseBranch = Effect.fn("pullMergedBaseBranch")(function* (input: {
  /** Passed in rather than read from context so this stays a leaf, matching
      `deleteCardBranch`: the reactor already holds the driver. */
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly cwd: string;
  readonly baseBranch: string;
}) {
  const { git, cwd, baseBranch } = input;

  const remoteName = yield* git
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.orElseSucceed(() => null));
  if (remoteName === null) {
    return {
      updated: false,
      skippedReason: "no remote to pull from",
    } satisfies BoardBaseBranchSyncResult;
  }

  // `git fetch <remote> base:base` refuses to update a checked-out branch, so a
  // checked-out base is pulled `--ff-only` in place instead. A detached HEAD
  // prints nothing and takes the fetch path.
  const showCurrent = yield* git
    .execute({
      operation: "board.pullMergedBaseBranch.currentBranch",
      cwd,
      args: ["branch", "--show-current"],
      allowNonZeroExit: true,
    })
    .pipe(Effect.orElseSucceed(() => null));
  const currentBranch =
    showCurrent !== null && showCurrent.exitCode === 0 ? showCurrent.stdout.trim() : null;

  const fastForward =
    currentBranch === baseBranch
      ? // Base is checked out here: pull it forward in the working tree.
        {
          operation: "board.pullMergedBaseBranch.pull",
          args: ["pull", "--ff-only", remoteName, baseBranch],
        }
      : // Base is not checked out: move its local ref straight from the remote
        // without a checkout. No leading `+` keeps it fast-forward-only.
        {
          operation: "board.pullMergedBaseBranch.fetch",
          args: ["fetch", remoteName, `${baseBranch}:${baseBranch}`],
        };

  const result = yield* git
    .execute({
      operation: fastForward.operation,
      cwd,
      args: fastForward.args,
      allowNonZeroExit: true,
    })
    .pipe(Effect.orElseSucceed(() => null));

  if (result !== null && result.exitCode === 0) {
    return { updated: true, skippedReason: null } satisfies BoardBaseBranchSyncResult;
  }
  // Scrubbed: `git pull`/`fetch` print the remote URL, which carries an embedded
  // credential when the remote is an https URL with one, and this string is
  // logged.
  const detail = safeProcessOutput(result?.stderr ?? "");
  return {
    updated: false,
    skippedReason: `local ${baseBranch} not fast-forwarded${detail.length > 0 ? `: ${detail}` : ""}`,
  } satisfies BoardBaseBranchSyncResult;
});
