/**
 * What removing a worker does with one card's worktree (T3O-87): probed with Move's probe and
 * `remoteBranchTip`, pushed (never forced, its own branch only) where the remote lacks commits.
 */
import type { BoardWorkspaceDurability } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardWorkerGitError } from "@t3tools/contracts";
import type { BoardCardWorkspace } from "../workspace/BoardWorkspace.ts";
import { classifyRemovalWorktree } from "./BoardWorkers.ts";

const clean: BoardWorkspaceDurability = {
  hasWorkingTreeChanges: false,
  changedPaths: [],
  openPullRequestNumber: null,
  durable: true,
  unmergedCount: 0,
  unpushedCount: 0,
  hasUpstream: true,
  unpushedCommits: [],
  baseFetched: true,
};

const fake = (input: {
  readonly probe: BoardWorkspaceDurability | "fails";
  readonly onRemote: boolean;
  /** What the push does: lands (and the remote then has the branch), fails, or is unknown. */
  readonly push?: "lands" | "fails" | "unknown";
}) => {
  const pushes: Array<{ readonly worktreePath: string; readonly branch: string }> = [];
  let remote = input.onRemote;
  const workspace = {
    probeWorktreeDurability: () =>
      input.probe === "fails"
        ? Effect.fail(new BoardWorkerGitError({ operation: "probe", detail: "offline" }))
        : Effect.succeed(input.probe),
    remoteBranchTip: () =>
      Effect.succeed(
        remote ? { sha: "abc", subject: "Work", committedAt: "2026-01-01", author: "a" } : null,
      ),
    pushCardBranch: (args: { readonly worktreePath: string; readonly branch: string }) => {
      pushes.push(args);
      if (input.push === "unknown") {
        return Effect.fail(
          new BoardWorkerGitError({ operation: "push", detail: "no such method" }),
        );
      }
      if (input.push === "fails") return Effect.succeed({ pushed: false, detail: "rejected" });
      remote = true;
      return Effect.succeed({ pushed: true, detail: null });
    },
  } as unknown as BoardCardWorkspace;
  return { workspace, pushes };
};

const classify = (workspace: BoardCardWorkspace) =>
  classifyRemovalWorktree(workspace, {
    worktreePath: "/wt/card-1",
    branch: "board/card-1",
    baseRefName: "main",
  });

describe("classifying a worktree for its worker's removal (T3O-87)", () => {
  it.effect("clean with every commit on its remote branch: reclaimed, nothing pushed", () =>
    Effect.gen(function* () {
      const { workspace, pushes } = fake({ probe: clean, onRemote: true });
      assert.strictEqual(yield* classify(workspace), "reclaimed");
      assert.deepStrictEqual(pushes, []);
    }),
  );

  it.effect("clean with nothing beyond its base and no remote branch: cut fresh next time", () =>
    Effect.gen(function* () {
      const { workspace } = fake({ probe: { ...clean, hasUpstream: false }, onRemote: false });
      assert.strictEqual(yield* classify(workspace), "fresh");
    }),
  );

  it.effect("commits beyond its base read as none unpushed are pushed, not cut fresh", () =>
    Effect.gen(function* () {
      const { workspace, pushes } = fake({
        probe: { ...clean, hasUpstream: false, unmergedCount: 2 },
        onRemote: false,
        push: "lands",
      });
      assert.strictEqual(yield* classify(workspace), "reclaimed");
      assert.deepStrictEqual(pushes, [{ worktreePath: "/wt/card-1", branch: "board/card-1" }]);
    }),
  );

  it.effect("commits the remote lacks are pushed, the card's own branch only, then reclaimed", () =>
    Effect.gen(function* () {
      const { workspace, pushes } = fake({
        probe: { ...clean, unpushedCount: 2 },
        onRemote: false,
        push: "lands",
      });
      assert.strictEqual(yield* classify(workspace), "reclaimed");
      assert.deepStrictEqual(pushes, [{ worktreePath: "/wt/card-1", branch: "board/card-1" }]);
    }),
  );

  it.effect("a dirty tree, a refused push, an old worker or no answer waits for a human", () =>
    Effect.gen(function* () {
      const cases = [
        fake({ probe: { ...clean, hasWorkingTreeChanges: true }, onRemote: true }),
        fake({ probe: { ...clean, unpushedCount: 1 }, onRemote: true, push: "fails" }),
        fake({ probe: { ...clean, unpushedCount: 1 }, onRemote: true, push: "unknown" }),
        fake({ probe: "fails", onRemote: true }),
        // Tracking a remote branch that is gone: nothing safe to continue from.
        fake({ probe: clean, onRemote: false }),
      ];
      for (const { workspace } of cases) assert.strictEqual(yield* classify(workspace), "orphaned");
    }),
  );
});
