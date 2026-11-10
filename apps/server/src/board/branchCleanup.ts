/**
 * Branch cleanup for a card finished with its branch. Deletion is irreversible, so the CALLER
 * proves the branch is spent (merged at Done, a confirmed delete, archive or cancel). Each
 * deletion is best-effort and reported: the local one is refused while a worktree holds the
 * branch, and a half-done cleanup never blocks the card's move.
 */
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { safeProcessOutput } from "../vcs/VcsProcess.ts";

/** What a cleanup attempt actually did, for the activity rail and the log. */
export interface BoardBranchCleanupResult {
  readonly remoteDeleted: boolean;
  readonly localDeleted: boolean;
  /** The repository has no remote, so there was no remote copy to delete. */
  readonly remoteAbsent: boolean;
  /** Why a deletion was skipped or failed; null when everything asked for
      happened. Human-facing — it lands on the card. */
  readonly skippedReason: string | null;
}

/**
 * Branch names a worktree in this repository has checked out, from `git worktree list
 * --porcelain`. A detached worktree has no `branch` line, and holds no branch to orphan.
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
 * Delete a card's branch, local and remote. `cwd` is the PROJECT root, not the card's worktree:
 * a worktree on the branch being deleted always refuses the local delete, and may be gone.
 */
export const deleteCardBranch = Effect.fn("deleteCardBranch")(function* (input: {
  /** Taken as a parameter rather than pulled from context so this stays a
      leaf: the supervisor reactor already holds the driver, and requiring it
      here would push `GitVcsDriver` back into the reactor's requirements. */
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly cwd: string;
  readonly branch: string;
}) {
  const git = input.git;
  const skipped: Array<string> = [];

  const remoteName = yield* git
    .resolvePrimaryRemoteName(input.cwd)
    .pipe(Effect.orElseSucceed(() => null));
  let remoteDeleted = false;
  let remoteAbsent = false;
  if (remoteName === null) {
    // Absent only when git listed the remotes and there were none: a lookup
    // that failed outright says nothing about the remote branch.
    const remotes = yield* git
      .execute({
        operation: "board.deleteCardBranch.remotes",
        cwd: input.cwd,
        args: ["remote"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null));
    remoteAbsent = remotes !== null && remotes.exitCode === 0 && remotes.stdout.trim() === "";
    skipped.push(
      remoteAbsent
        ? "no remote to delete the branch from"
        : "remote branch not deleted: no remote resolved",
    );
  } else {
    // `allowNonZeroExit`: the branch is most likely already gone (forges can delete head branches
    // on merge), which is success for the card and indistinguishable afterwards.
    const result = yield* git
      .execute({
        operation: "board.deleteCardBranch.remote",
        cwd: input.cwd,
        args: ["push", remoteName, "--delete", input.branch],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null));
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

  const porcelain = yield* git
    .execute({
      operation: "board.deleteCardBranch.worktrees",
      cwd: input.cwd,
      args: ["worktree", "list", "--porcelain"],
      allowNonZeroExit: true,
    })
    .pipe(Effect.orElseSucceed(() => null));

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
    // `-D`, not `-d`: a squash merge leaves the branch's own commits unmerged in git's eyes, so `-d`
    // would always refuse. The caller owns the force (a proven merge, or a human's confirmation).
    const result = yield* git
      .execute({
        operation: "board.deleteCardBranch.local",
        cwd: input.cwd,
        args: ["branch", "-D", input.branch],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null));
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
    remoteAbsent,
    skippedReason: skipped.length === 0 ? null : skipped.join("; "),
  } satisfies BoardBranchCleanupResult;
});
