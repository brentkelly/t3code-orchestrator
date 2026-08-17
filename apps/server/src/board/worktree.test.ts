/**
 * T3o worktree/branch lifecycle mechanics (t3o-09, D6).
 *
 * The effectful half: the pure helpers that decide a branch name, a base ref,
 * and whether a worktree is safe to reclaim; the serialisation guard that
 * makes "one writer per card worktree" executable; and real-git integration
 * proving that entering Building creates a branch + worktree and that reclaim
 * removes a clean-and-pushed tree but refuses a dirty one (and says why).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  assertSingleBoardWorktreeWriter,
  boardCardWorktreeBranchName,
  boardCardWorktreeReclaimDecision,
  parseWorktreePathForBranch,
  provisionBoardCardWorktree,
  reclaimBoardCardWorktree,
  resolveBoardCardBaseRef,
} from "./worktree.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-board-worktree-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "board-worktree-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "board.worktree.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const initRepoWithCommit = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

// ── Pure helpers ───────────────────────────────────────────────────────

it.effect("derives a namespaced, sanitised branch name from the card key", () =>
  Effect.sync(() => {
    assert.strictEqual(boardCardWorktreeBranchName({ key: "T3-195" }), "board/t3-195");
  }),
);

it.effect("resolves a top-level card's base to the project default branch", () =>
  Effect.sync(() => {
    const base = resolveBoardCardBaseRef({
      card: { parentCardId: null },
      cards: [],
      defaultBranch: "main",
    });
    assert.strictEqual(base, "main");
  }),
);

it.effect("resolves a plan card's base to its parent's integration branch", () =>
  Effect.sync(() => {
    const parent = {
      id: "parent" as never,
      worktree: {
        branch: "feat/parent",
        baseRefName: "main",
        path: "/tmp/parent",
        status: "ready" as const,
        attempts: 1,
        lastError: null,
        reclaimBlockedReason: null,
      },
    };
    const base = resolveBoardCardBaseRef({
      card: { parentCardId: "parent" as never },
      cards: [parent],
      defaultBranch: "main",
    });
    assert.strictEqual(base, "feat/parent");
  }),
);

it.effect("returns null when a plan card's parent has no branch yet", () =>
  Effect.sync(() => {
    const parent = { id: "parent" as never, worktree: null };
    const base = resolveBoardCardBaseRef({
      card: { parentCardId: "parent" as never },
      cards: [parent],
      defaultBranch: "main",
    });
    assert.strictEqual(base, null);
  }),
);

it.effect("reclaim decision: clean and pushed is safe", () =>
  Effect.sync(() => {
    const decision = boardCardWorktreeReclaimDecision({
      hasWorkingTreeChanges: false,
      hasUpstream: true,
      aheadCount: 0,
    });
    assert.deepStrictEqual(decision, { safe: true });
  }),
);

it.effect("reclaim decision: a dirty tree is refused with a reason", () =>
  Effect.sync(() => {
    const decision = boardCardWorktreeReclaimDecision({
      hasWorkingTreeChanges: true,
      hasUpstream: true,
      aheadCount: 0,
    });
    assert.strictEqual(decision.safe, false);
    if (!decision.safe) assert.match(decision.reason, /uncommitted/i);
  }),
);

it.effect("reclaim decision: an unpushed branch is refused with a reason", () =>
  Effect.sync(() => {
    const decision = boardCardWorktreeReclaimDecision({
      hasWorkingTreeChanges: false,
      hasUpstream: false,
      aheadCount: 0,
    });
    assert.strictEqual(decision.safe, false);
    if (!decision.safe) assert.match(decision.reason, /pushed/i);
  }),
);

it.effect("reclaim decision: unpushed commits are refused with a count", () =>
  Effect.sync(() => {
    const decision = boardCardWorktreeReclaimDecision({
      hasWorkingTreeChanges: false,
      hasUpstream: true,
      aheadCount: 2,
    });
    assert.strictEqual(decision.safe, false);
    if (!decision.safe) assert.match(decision.reason, /2 commits not pushed/);
  }),
);

// ── Worktree-list parsing (retry recovery) ─────────────────────────────

const PORCELAIN = [
  "worktree /repo",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /repo/.worktrees/board-card-1",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/board/card-1",
  "",
].join("\n");

it.effect("finds an existing worktree path for a branch", () =>
  Effect.sync(() => {
    assert.strictEqual(
      parseWorktreePathForBranch(PORCELAIN, "board/card-1"),
      "/repo/.worktrees/board-card-1",
    );
  }),
);

it.effect("returns null when no worktree holds the branch", () =>
  Effect.sync(() => {
    assert.strictEqual(parseWorktreePathForBranch(PORCELAIN, "board/absent"), null);
  }),
);

// ── Serialisation guard ────────────────────────────────────────────────

it.effect("permits zero or one writer on a card worktree", () =>
  Effect.gen(function* () {
    yield* assertSingleBoardWorktreeWriter({ cardId: "card-1", activeWriterThreadIds: [] });
    yield* assertSingleBoardWorktreeWriter({ cardId: "card-1", activeWriterThreadIds: ["t1"] });
    // The same thread listed twice is still one writer.
    yield* assertSingleBoardWorktreeWriter({
      cardId: "card-1",
      activeWriterThreadIds: ["t1", "t1"],
    });
  }),
);

it.effect("rejects two distinct writers holding one card worktree at once", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      assertSingleBoardWorktreeWriter({
        cardId: "card-1",
        activeWriterThreadIds: ["t1", "t2"],
      }),
    );
    assert.strictEqual(error._tag, "BoardWorktreeConcurrencyError");
    assert.deepStrictEqual([...error.writerThreadIds], ["t1", "t2"]);
  }),
);

// ── Real-git integration ───────────────────────────────────────────────

it.effect("entering Building creates the card's branch and worktree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);

      const result = yield* provisionBoardCardWorktree({
        projectCwd: cwd,
        branch: "board/card-1",
        baseRefName: initialBranch,
      });

      assert.strictEqual(result.branch, "board/card-1");
      const fileSystem = yield* FileSystem.FileSystem;
      assert.isTrue(yield* fileSystem.exists(result.path), "worktree directory exists on disk");
      const branches = yield* git(cwd, ["branch", "--list", "board/card-1"]);
      assert.match(branches, /board\/card-1/);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("re-provisioning after a partial attempt reuses the existing worktree, not a wedge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);

      const first = yield* provisionBoardCardWorktree({
        projectCwd: cwd,
        branch: "board/card-1",
        baseRefName: initialBranch,
      });
      // A retry (the decider allows re-provisioning a `failed` worktree) must
      // recover rather than fail on "branch already exists".
      const retry = yield* provisionBoardCardWorktree({
        projectCwd: cwd,
        branch: "board/card-1",
        baseRefName: initialBranch,
      });

      assert.strictEqual(retry.path, first.path);
      assert.strictEqual(retry.branch, "board/card-1");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reclaims a clean, pushed worktree and removes it from disk", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("board-worktree-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);

      const provisioned = yield* provisionBoardCardWorktree({
        projectCwd: cwd,
        branch: "board/card-1",
        baseRefName: initialBranch,
      });
      // Push the card branch so it is fully backed up before reclaim.
      yield* git(provisioned.path, ["push", "-u", "origin", "board/card-1"]);

      const outcome = yield* reclaimBoardCardWorktree({
        projectCwd: cwd,
        worktreePath: provisioned.path,
      });

      assert.strictEqual(outcome.outcome, "removed");
      const fileSystem = yield* FileSystem.FileSystem;
      assert.isFalse(
        yield* fileSystem.exists(provisioned.path),
        "reclaimed worktree is gone from disk",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to reclaim a dirty worktree and keeps it on disk", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const provisioned = yield* provisionBoardCardWorktree({
        projectCwd: cwd,
        branch: "board/card-1",
        baseRefName: initialBranch,
      });
      // Modify a tracked file in the worktree — an uncommitted change.
      yield* writeTextFile(provisioned.path, "README.md", "# changed, not committed\n");

      const outcome = yield* reclaimBoardCardWorktree({
        projectCwd: cwd,
        worktreePath: provisioned.path,
      });

      assert.strictEqual(outcome.outcome, "blocked");
      assert.match(outcome.reason ?? "", /uncommitted/i);
      const fileSystem = yield* FileSystem.FileSystem;
      assert.isTrue(
        yield* fileSystem.exists(provisioned.path),
        "dirty worktree is kept, never deleted to save disk",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);
