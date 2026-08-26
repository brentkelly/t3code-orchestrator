/**
 * Branch cleanup's one piece of parsing: which branches a repository's
 * worktrees currently hold.
 *
 * This is the guard that keeps the local delete from stranding a live checkout
 * on a nameless HEAD, and `worktreeRetention` defaults to `reclaim-on-archive`
 * — so a card at Done normally STILL has its worktree and this is the common
 * path, not an edge case.
 */
import { assert, describe, it } from "@effect/vitest";

import { parseWorktreeBranches } from "./branchCleanup.ts";

describe("parseWorktreeBranches", () => {
  it("reads the branch each worktree holds, stripped of refs/heads/", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/card-1",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/board/card-1",
      "",
    ].join("\n");
    assert.deepStrictEqual(parseWorktreeBranches(porcelain), ["main", "board/card-1"]);
  });

  it("contributes nothing for a DETACHED worktree", () => {
    // A detached checkout emits no `branch` line at all. It holds no branch
    // name, so it cannot be orphaned by deleting one — and treating it as
    // holding something would block every cleanup in a repository that happens
    // to have one.
    const porcelain = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/detached",
      "HEAD 2222222222222222222222222222222222222222",
      "detached",
      "",
    ].join("\n");
    assert.deepStrictEqual(parseWorktreeBranches(porcelain), ["main"]);
  });

  it("reads an empty listing as holding nothing", () => {
    assert.deepStrictEqual(parseWorktreeBranches(""), []);
  });

  it("keeps a branch name that is not under refs/heads/", () => {
    // Defensive: a ref shape we did not expect is kept verbatim rather than
    // mangled, so an unrecognised listing errs toward "held" (no deletion)
    // instead of toward deleting the wrong name.
    assert.deepStrictEqual(parseWorktreeBranches("branch board/card-9"), ["board/card-9"]);
  });
});
