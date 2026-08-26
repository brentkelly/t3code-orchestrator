/**
 * Pull a just-merged card's commits into the LOCAL base branch of the
 * project-root checkout.
 *
 * The merge itself happens entirely on the forge (`gh pr merge`), so the local
 * clone the board branches new worktrees from is left behind the moment a card
 * merges: its `main` still points at the pre-merge tip. The next worktree would
 * then fork off stale history. This module fast-forwards that local base branch
 * back up to the remote so future branches start from the merged commits.
 *
 * Two rules, both about safety:
 *
 * - **Fast-forward only.** We never rewrite local history. A base branch that
 *   somehow carries un-pushed local commits (divergence) is left exactly as it
 *   is rather than force-moved — the refspec has no leading `+`, and the
 *   checked-out path uses `pull --ff-only`.
 * - **Best-effort.** Every failure — no remote, a dirty checkout, a diverged
 *   base — is a reported skip, never an error. The card is already merged; a
 *   base branch we could not advance is a staleness the next fetch fixes, not a
 *   reason to strand the merge outcome.
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
      `deleteMergedCardBranch`: the reactor already holds the driver. */
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly cwd: string;
  readonly baseBranch: string;
}) {
  const { git, cwd, baseBranch } = input;

  const remoteName = yield* git
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (remoteName === null) {
    return {
      updated: false,
      skippedReason: "no remote to pull from",
    } satisfies BoardBaseBranchSyncResult;
  }

  // Which branch the root checkout has out right now decides HOW the local base
  // ref can move. `git fetch <remote> base:base` refuses to update the ref of a
  // branch that is currently checked out, so when base IS checked out we
  // fast-forward it in place with a --ff-only pull instead. `--show-current`
  // prints nothing on a detached HEAD, which correctly takes the fetch path.
  const showCurrent = yield* git
    .execute({
      operation: "board.pullMergedBaseBranch.currentBranch",
      cwd,
      args: ["branch", "--show-current"],
      allowNonZeroExit: true,
    })
    .pipe(Effect.catch(() => Effect.succeed(null)));
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
    .pipe(Effect.catch(() => Effect.succeed(null)));

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
