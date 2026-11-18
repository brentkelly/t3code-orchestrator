// @effect-diagnostics nodeBuiltinImport:off
/**
 * Real-git proof of what a worker does to a finished card's worktree (T3O-123): the snapshot
 * of uncommitted work, the strip of ignored files, snapshot-ref pruning and a deleted card's
 * leftover branch.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProjectId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { SETUP_DONE_MARKER, STRIPPED_MARKER } from "./capacity/cardSetup.ts";
import { makeLocalBoardWorkspace } from "./workspace/LocalBoardWorkspace.ts";
import {
  deleteLeftoverBranch,
  isKeptIgnoredEntry,
  pruneDiscardedRefs,
  snapshotBoardWorktree,
  snapshotStamp,
  STRIP_PENDING_MARKER,
  stripBoardWorktree,
} from "./worktreeAtDone.ts";

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-at-done-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const NOW = Date.UTC(2026, 10, 18, 10, 5, 3);
const PROJECT = ProjectId.make("project-1");

const sh = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "worktreeAtDone.test",
      cwd,
      args,
      timeoutMs: 20_000,
      ...(env === undefined ? {} : { env }),
    });
    return result.stdout.trim();
  });

const write = (path: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
};

/** A repository with a card worktree on `board/t3o-1`, its git dir, and a temp root. */
const repoWithWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = NodeFS.realpathSync(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3o-at-done-" }),
  );
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo);
  yield* sh(repo, ["init", "--initial-branch=main"]);
  yield* sh(repo, ["config", "user.email", "test@test.com"]);
  yield* sh(repo, ["config", "user.name", "Test"]);
  write(NodePath.join(repo, "README.md"), "# test\n");
  write(NodePath.join(repo, ".gitignore"), "target/\nnode_modules/\n.env*\n.vscode/\n");
  yield* sh(repo, ["add", "."]);
  yield* sh(repo, ["commit", "-m", "initial"]);
  const worktree = NodePath.join(root, "worktrees", "t3o-1");
  yield* sh(repo, ["worktree", "add", "-b", "board/t3o-1", worktree]);
  const gitDir = yield* sh(worktree, ["rev-parse", "--absolute-git-dir"]);
  return { root, repo, worktree, gitDir };
});

describe("snapshotBoardWorktree", () => {
  it.effect("saves modified and untracked files under a discarded ref, leaving the tree", () =>
    Effect.gen(function* () {
      const { repo, worktree } = yield* repoWithWorktree;
      write(NodePath.join(worktree, "README.md"), "# changed\n");
      write(NodePath.join(worktree, "src", "new.ts"), "export {};\n");
      write(NodePath.join(worktree, "target", "big.bin"), "x".repeat(1000));
      const result = yield* snapshotBoardWorktree({
        worktreePath: worktree,
        cardKey: "T3O-1",
        capBytes: 1024 * 1024,
        nowMs: NOW,
      });
      assert.strictEqual(result.outcome, "snapshotted");
      if (result.outcome !== "snapshotted") return;
      assert.strictEqual(result.ref, "refs/t3o/discarded/T3O-1-20261118T100503");
      // The ref lives in the shared repository, visible from the project checkout.
      assert.strictEqual(yield* sh(repo, ["rev-parse", result.ref]), result.sha);
      assert.strictEqual(yield* sh(repo, ["show", `${result.ref}:README.md`]), "# changed");
      assert.strictEqual(yield* sh(repo, ["show", `${result.ref}:src/new.ts`]), "export {};");
      const files = yield* sh(repo, ["ls-tree", "-r", "--name-only", result.ref]);
      assert.notInclude(files, "target/big.bin");
      assert.strictEqual(
        yield* sh(repo, ["log", "-1", "--format=%s", result.ref]),
        "t3o: uncommitted work of T3O-1 before its worktree was removed",
      );
      // Its parent is the branch tip, and the worktree's own index is untouched.
      assert.strictEqual(
        yield* sh(repo, ["rev-parse", `${result.ref}^`]),
        yield* sh(repo, ["rev-parse", "board/t3o-1"]),
      );
      assert.strictEqual(yield* sh(worktree, ["status", "--porcelain"]), "M README.md\n?? src/");
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
  );

  it.effect("saves nothing from a clean worktree, whatever it ignores", () =>
    Effect.gen(function* () {
      const { repo, worktree } = yield* repoWithWorktree;
      write(NodePath.join(worktree, "node_modules", "a.js"), "1");
      const result = yield* snapshotBoardWorktree({
        worktreePath: worktree,
        cardKey: "T3O-1",
        capBytes: 1024,
        nowMs: NOW,
      });
      assert.deepStrictEqual(result, { outcome: "nothing" });
      assert.strictEqual(yield* sh(repo, ["for-each-ref", "refs/t3o/"]), "");
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
  );

  it.effect("refuses changes over the cap, saving nothing", () =>
    Effect.gen(function* () {
      const { repo, worktree } = yield* repoWithWorktree;
      write(NodePath.join(worktree, "data", "dump.sql"), "y".repeat(5000));
      const result = yield* snapshotBoardWorktree({
        worktreePath: worktree,
        cardKey: "T3O-1",
        capBytes: 4096,
        nowMs: NOW,
      });
      assert.deepStrictEqual(result, { outcome: "over-cap", bytes: 5000 });
      assert.strictEqual(yield* sh(repo, ["for-each-ref", "refs/t3o/"]), "");
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
  );

  it.effect("fails, rather than saving a partial snapshot, when git cannot read the tree", () =>
    Effect.gen(function* () {
      const { root } = yield* repoWithWorktree;
      const notARepo = NodePath.join(root, "plain");
      NodeFS.mkdirSync(notARepo);
      const result = yield* snapshotBoardWorktree({
        worktreePath: notARepo,
        cardKey: "T3O-1",
        capBytes: 4096,
        nowMs: NOW,
      }).pipe(Effect.flip);
      assert.strictEqual(result._tag, "BoardWorkerGitError");
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
  );

  it.effect("names its ref by UTC second", () =>
    Effect.sync(() => {
      assert.strictEqual(snapshotStamp(Date.UTC(2026, 0, 2, 3, 4, 5, 678)), "20260102T030405");
    }),
  );
});

describe("stripBoardWorktree", () => {
  it.effect(
    "deletes ignored build output, keeps .env files, editor folders and tracked files",
    () =>
      Effect.gen(function* () {
        const { worktree, gitDir } = yield* repoWithWorktree;
        write(NodePath.join(worktree, "target", "debug", "app"), "z".repeat(2000));
        write(NodePath.join(worktree, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
        write(NodePath.join(worktree, ".env.local"), "SECRET=1\n");
        write(NodePath.join(worktree, ".vscode", "settings.json"), "{}\n");
        write(NodePath.join(gitDir, SETUP_DONE_MARKER), "done\n");
        write(NodePath.join(gitDir, STRIP_PENDING_MARKER), "cargo is still running\n");

        const result = yield* stripBoardWorktree({ worktreePath: worktree, gitDir });

        assert.isAtLeast(result.freedBytes, 2000);
        assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, "target")));
        assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, "node_modules")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, ".env.local")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, ".vscode", "settings.json")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, "README.md")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, ".gitignore")));
        // Setup runs again if the worktree is reused; the strip is recorded once.
        assert.isFalse(NodeFS.existsSync(NodePath.join(gitDir, SETUP_DONE_MARKER)));
        assert.isFalse(NodeFS.existsSync(NodePath.join(gitDir, STRIP_PENDING_MARKER)));
        assert.isTrue(NodeFS.existsSync(NodePath.join(gitDir, STRIPPED_MARKER)));
      }).pipe(Effect.scoped, Effect.provide(GitLayer)),
  );

  it.effect("keeps what a strip must leave, at any depth", () =>
    Effect.sync(() => {
      assert.isTrue(isKeptIgnoredEntry(".env"));
      assert.isTrue(isKeptIgnoredEntry("apps/web/.env.production"));
      assert.isTrue(isKeptIgnoredEntry(".claude/"));
      assert.isTrue(isKeptIgnoredEntry("tools/.idea/workspace.xml"));
      assert.isFalse(isKeptIgnoredEntry("target/"));
      assert.isFalse(isKeptIgnoredEntry("dist/environment.js"));
    }),
  );
});

describe("the local workspace's strip", () => {
  const workspaceOver = (repo: string, survivors: () => string | null) =>
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      return makeLocalBoardWorkspace({
        git,
        pullRequests: {} as never,
        retirer: {
          retire: () => Effect.die("unexpected retire"),
          stopForStrip: () => Effect.sync(survivors),
        },
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        projectRoot: () => Effect.succeed(repo),
        worktreeRoots: Effect.succeed([]),
      });
    });

  it.effect("marks a worktree a foreign process holds, and a sweep strips only marked ones", () =>
    Effect.gen(function* () {
      const { repo, worktree, gitDir } = yield* repoWithWorktree;
      write(NodePath.join(worktree, "target", "out"), "1");
      let running: string | null = "cargo is still running in the worktree";
      const workspace = yield* workspaceOver(repo, () => running);
      const strip = (onlyIfPending: boolean) =>
        workspace.stripWorktree({ projectId: PROJECT, worktreePath: worktree, onlyIfPending });

      // A sweep never strips a kept worktree with no pending strip (one kept before T3O-123).
      assert.deepStrictEqual(yield* strip(true), { outcome: "skipped" });
      assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, "target")));

      assert.deepStrictEqual(yield* strip(false), {
        outcome: "pending",
        reason: "cargo is still running in the worktree",
      });
      assert.isTrue(NodeFS.existsSync(NodePath.join(gitDir, STRIP_PENDING_MARKER)));
      assert.isTrue(NodeFS.existsSync(NodePath.join(worktree, "target")));

      running = null;
      const swept = yield* strip(true);
      assert.strictEqual(swept.outcome, "stripped");
      assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, "target")));
      // Once only: a later finish trigger leaves a stripped worktree alone.
      assert.deepStrictEqual(yield* strip(false), { outcome: "skipped" });
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
  );
});

describe("pruneDiscardedRefs", () => {
  it.effect("drops snapshot refs older than the window and keeps newer ones", () =>
    Effect.gen(function* () {
      const { repo } = yield* repoWithWorktree;
      const tree = yield* sh(repo, ["rev-parse", "HEAD^{tree}"]);
      const commitAt = (date: string) =>
        sh(repo, ["commit-tree", tree, "-m", "snapshot"], {
          GIT_COMMITTER_DATE: date,
          GIT_AUTHOR_DATE: date,
        });
      const old = yield* commitAt("2026-10-18T10:00:00Z");
      const fresh = yield* commitAt("2026-11-17T10:00:00Z");
      yield* sh(repo, ["update-ref", "refs/t3o/discarded/T3O-1-old", old]);
      yield* sh(repo, ["update-ref", "refs/t3o/discarded/T3O-2-new", fresh]);
      yield* sh(repo, ["update-ref", "refs/t3o/other/T3O-3", old]);

      const result = yield* pruneDiscardedRefs({ cwd: repo, nowMs: NOW, maxAgeDays: 30 });

      assert.deepStrictEqual(result, { deleted: 1 });
      const left = yield* sh(repo, ["for-each-ref", "--format=%(refname)", "refs/t3o/"]);
      assert.deepStrictEqual(left.split("\n"), [
        "refs/t3o/discarded/T3O-2-new",
        "refs/t3o/other/T3O-3",
      ]);
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
  );
});

describe("deleteLeftoverBranch", () => {
  it.effect("deletes a local branch no worktree holds, and skips one a worktree holds", () =>
    Effect.gen(function* () {
      const { repo } = yield* repoWithWorktree;
      yield* sh(repo, ["branch", "board/t3o-2"]);
      assert.deepStrictEqual(yield* deleteLeftoverBranch({ cwd: repo, branch: "board/t3o-2" }), {
        deleted: true,
        skippedReason: null,
      });
      assert.strictEqual(yield* sh(repo, ["branch", "--list", "board/t3o-2"]), "");
      assert.deepStrictEqual(yield* deleteLeftoverBranch({ cwd: repo, branch: "board/t3o-1" }), {
        deleted: false,
        skippedReason: "a worktree has it checked out",
      });
      assert.deepStrictEqual(yield* deleteLeftoverBranch({ cwd: repo, branch: "board/gone" }), {
        deleted: false,
        skippedReason: "no such branch",
      });
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
  );
});
