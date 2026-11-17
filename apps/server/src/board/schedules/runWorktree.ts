/**
 * T3o: removing a pruned schedule run's worktree and branch (T3O-117, T3O-118). The board
 * server prunes its own runs with it, and a worker prunes the runs it launched for a board.
 */
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { parseWorktreePathForBranch } from "../worktree.ts";
import { WorktreeRetirer } from "../worktreeRetire.ts";

export interface RunWorktreeInput {
  readonly project: { readonly id: ProjectId; readonly workspaceRoot: string };
  /** The run's worktree when known; otherwise found by its branch. */
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

/** Remove the run's worktree, then its branch; true only once both are confirmed gone. */
export const makeRemoveRunWorktree = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const retirer = yield* WorktreeRetirer;
  return Effect.fn("BoardSchedules.removeRunWorktree")(
    function* ({ project, worktreePath: knownPath, branch }: RunWorktreeInput) {
      const runGit = (operation: string, args: ReadonlyArray<string>) =>
        git.execute({ operation, cwd: project.workspaceRoot, args, allowNonZeroExit: true });
      let worktreePath = knownPath;
      if (worktreePath === null && branch !== null) {
        const listed = yield* runGit("board.schedule.runWorktrees", [
          "worktree",
          "list",
          "--porcelain",
        ]);
        if (listed.exitCode !== 0) return false;
        worktreePath = parseWorktreePathForBranch(listed.stdout, branch);
      }
      if (worktreePath !== null && worktreePath !== project.workspaceRoot) {
        const retired = yield* retirer.retire({
          projectCwd: project.workspaceRoot,
          projectId: project.id,
          worktreePath,
          kind: "forced",
          verifiedClean: false,
          skipIfBusy: true,
        });
        if (retired === null || retired.outcome !== "removed") return false;
      }
      // Only the branch recorded at launch: the thread's own may since name another.
      if (branch !== null) {
        yield* runGit("board.schedule.pruneRunBranch", ["branch", "-D", branch]);
        const left = yield* runGit("board.schedule.runBranchGone", [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);
        if (left.exitCode !== 1) return false;
      }
      return true;
    },
    Effect.orElseSucceed(() => false),
  );
});
