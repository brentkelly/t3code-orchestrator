/**
 * Branch cleanup when a card reaches Done with a merged pull request.
 *
 * Deleting a branch is irreversible, so the whole module is built around one
 * rule: **only ever delete a branch whose work is already somewhere else.**
 * The caller gates on `pullRequest.state === "merged"`, which means the
 * commits live in the base branch — so the branch itself is spent. Nothing
 * here runs for an unmerged or closed PR, or for a card with no PR at all.
 *
 * Two deletions, with different risk:
 *
 * - **Remote** — what GitHub's own "delete branch on merge" does, and safe for
 *   the same reason.
 * - **Local** — refused while a worktree still has the branch checked out.
 *   Deleting it out from under a live checkout would leave a worktree on a
 *   detached, nameless HEAD. The caller settles a card at Done by reclaiming
 *   the worktree FIRST, so by the time this runs the branch is normally
 *   unheld and the local delete succeeds; with `reclaimWorktreeOnDone` off the
 *   worktree survives and the local branch is left for archive to clean up.
 *
 * Every step is independently best-effort and reports what it did. A cleanup
 * that half-succeeds (remote gone, local held) is a normal, reportable
 * outcome — never an error that strands the card's move to Done.
 */
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { safeProcessOutput } from "../vcs/VcsProcess.ts";

/** What a cleanup attempt actually did, for the activity rail and the log. */
export interface BoardBranchCleanupResult {
  readonly remoteDeleted: boolean;
  readonly localDeleted: boolean;
  /** Why a deletion was skipped or failed; null when everything asked for
      happened. Human-facing — it lands on the card. */
  readonly skippedReason: string | null;
}

/**
 * Branch names, one per line, that a worktree in this repository currently has
 * checked out. Parsed from `git worktree list --porcelain`, whose `branch`
 * lines carry a full ref (`refs/heads/feature/x`).
 *
 * A DETACHED worktree emits no `branch` line at all, so it correctly
 * contributes nothing: a detached checkout holds no branch name and cannot be
 * orphaned by deleting one.
 */
export function parseWorktreeBranches(porcelain: string): ReadonlyArray<string> {
  const branches: Array<string> = [];
  for (const line of porcelain.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("branch ")) continue;
    const ref = trimmed.slice("branch ".length).trim();
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    if (name.length > 0) branches.push(name);
  }
  return branches;
}

/**
 * Delete a merged card's branch.
 *
 * `cwd` is the repository the deletion runs in — the PROJECT root, not the
 * card's worktree: a worktree checked out on the very branch being deleted is
 * the one place the local delete is guaranteed to be refused, and it may
 * already have been reclaimed.
 */
export const deleteMergedCardBranch = Effect.fn("deleteMergedCardBranch")(function* (input: {
  /** Taken as a parameter rather than pulled from context so this stays a
      leaf: the supervisor reactor already holds the driver, and requiring it
      here would push `GitVcsDriver` back into the reactor's requirements. */
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly cwd: string;
  readonly branch: string;
}) {
  const git = input.git;
  const skipped: Array<string> = [];

  // ── Remote ──────────────────────────────────────────────────────────
  const remoteName = yield* git
    .resolvePrimaryRemoteName(input.cwd)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  let remoteDeleted = false;
  if (remoteName === null) {
    skipped.push("no remote to delete the branch from");
  } else {
    // `allowNonZeroExit`: the branch already being gone is the single most
    // likely outcome here — GitHub deletes it itself when the repository has
    // "automatically delete head branches" on, which is a common setting. That
    // is success from the card's point of view, not a failure worth reporting,
    // and the two cases are indistinguishable afterwards anyway.
    const result = yield* git
      .execute({
        operation: "board.deleteMergedCardBranch.remote",
        cwd: input.cwd,
        args: ["push", remoteName, "--delete", input.branch],
        allowNonZeroExit: true,
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    remoteDeleted = result !== null && result.exitCode === 0;
    if (!remoteDeleted) {
      // Scrubbed, not raw: this string is persisted to an event log that is
      // never rewritten and rendered on the card, and `git push` prints the
      // remote URL — which carries an embedded credential whenever the remote
      // is an https URL with one.
      const detail = safeProcessOutput(result?.stderr ?? "");
      // "remote ref does not exist" means someone already deleted it — the
      // desired end state, reached without us.
      if (detail.toLowerCase().includes("remote ref does not exist")) {
        remoteDeleted = true;
      } else {
        skipped.push(`remote branch not deleted${detail.length > 0 ? `: ${detail}` : ""}`);
      }
    }
  }

  // ── Local ───────────────────────────────────────────────────────────
  const porcelain = yield* git
    .execute({
      operation: "board.deleteMergedCardBranch.worktrees",
      cwd: input.cwd,
      args: ["worktree", "list", "--porcelain"],
      allowNonZeroExit: true,
    })
    .pipe(Effect.catch(() => Effect.succeed(null)));

  // A worktree listing we could not read is treated as "held": guessing wrong
  // in the other direction strands a live checkout on a nameless HEAD, and the
  // cost of being wrong this way is only a branch that outlives its card.
  const held =
    porcelain === null || porcelain.exitCode !== 0
      ? true
      : parseWorktreeBranches(porcelain.stdout).includes(input.branch);

  let localDeleted = false;
  if (held) {
    skipped.push("local branch kept: a worktree still has it checked out");
  } else {
    // `-D`, not `-d`: a SQUASH merge (the default strategy) rewrites the work
    // into a single new commit, so git cannot see the branch's own commits as
    // merged and `-d` would refuse every time. The force is safe precisely
    // because the caller already proved the PR is merged.
    const result = yield* git
      .execute({
        operation: "board.deleteMergedCardBranch.local",
        cwd: input.cwd,
        args: ["branch", "-D", input.branch],
        allowNonZeroExit: true,
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    localDeleted = result !== null && result.exitCode === 0;
    if (!localDeleted) {
      const detail = safeProcessOutput(result?.stderr ?? "");
      // Already gone is the end state we wanted.
      if (detail.toLowerCase().includes("not found")) {
        localDeleted = true;
      } else {
        skipped.push(`local branch not deleted${detail.length > 0 ? `: ${detail}` : ""}`);
      }
    }
  }

  return {
    remoteDeleted,
    localDeleted,
    skippedReason: skipped.length === 0 ? null : skipped.join("; "),
  } satisfies BoardBranchCleanupResult;
});
