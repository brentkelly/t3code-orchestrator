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
  forceRemoveBoardCardWorktree,
  parseRegisteredWorktrees,
  parseStatusPorcelainPaths,
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
      card: { parentCardId: null, baseBranch: null },
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
      pullRequest: null,
      pullRequestHistory: [],
    };
    const base = resolveBoardCardBaseRef({
      card: { parentCardId: "parent" as never, baseBranch: null },
      cards: [parent],
      defaultBranch: "main",
    });
    assert.strictEqual(base, "feat/parent");
  }),
);

it.effect("falls back to the merged base only when the parent has no live branch", () =>
  Effect.sync(() => {
    // A merged parent loses its branch on arrival at Done — worktree
    // reclaimed, branch deleted, slice left `reclaimed` — so cutting from it
    // would fail on a ref that no longer exists. The merged pull request's
    // own baseRef is not a guess: the parent's commits ARE in it, by the same
    // argument that made deleting the branch safe.
    const parent = {
      id: "parent" as never,
      worktree: {
        branch: "feat/parent",
        baseRefName: "main",
        path: null,
        status: "reclaimed" as const,
        attempts: 1,
        lastError: null,
        reclaimBlockedReason: null,
      },
      pullRequest: {
        number: 284 as never,
        url: "https://github.com/acme/repo/pull/284",
        state: "merged" as const,
        headBranch: "feat/parent",
        baseRef: "main",
        checkedAt: "2026-01-01T00:00:00.000Z" as never,
      },
      pullRequestHistory: [],
    };
    const base = resolveBoardCardBaseRef({
      card: { parentCardId: "parent" as never, baseBranch: null },
      cards: [parent],
      defaultBranch: "main",
    });
    assert.strictEqual(base, "main");

    // The fallback is the branch the parent MERGED INTO, not the project
    // default: on a sub-board the parent merges into an integration branch,
    // and cutting the child from the default branch would silently drop every
    // sibling already integrated there.
    const ontoIntegration = {
      ...parent,
      pullRequest: { ...parent.pullRequest, baseRef: "board/epic" },
    };
    assert.strictEqual(
      resolveBoardCardBaseRef({
        card: { parentCardId: "parent" as never, baseBranch: null },
        cards: [ontoIntegration],
        defaultBranch: "main",
      }),
      "board/epic",
    );

    // And a parent whose merged pull request the ROUND BOUNDARY has already
    // retired — dragged back out of Done, so `pullRequest` is null until its
    // new round opens one. Reading only the current link would miss exactly
    // this parent and fall through to `worktree.branch`, the branch that was
    // deleted at Done.
    const reopened = {
      ...parent,
      pullRequest: null,
      pullRequestHistory: [parent.pullRequest],
    };
    assert.strictEqual(
      resolveBoardCardBaseRef({
        card: { parentCardId: "parent" as never, baseBranch: null },
        cards: [reopened],
        defaultBranch: "main",
      }),
      "main",
    );

    // An UNMERGED parent keeps its branch (nothing deleted it — the slice is
    // still `ready`) and keeps being the base.
    const unmerged = {
      ...parent,
      worktree: { ...parent.worktree, path: "/tmp/worktrees/parent", status: "ready" as const },
      pullRequest: { ...parent.pullRequest, state: "open" as const },
    };
    assert.strictEqual(
      resolveBoardCardBaseRef({
        card: { parentCardId: "parent" as never, baseBranch: null },
        cards: [unmerged],
        defaultBranch: "main",
      }),
      "feat/parent",
    );

    // A SECOND-ROUND split (t3o-23): the parent was merged and dragged back,
    // then re-approved — its fresh `branch-only` integration branch must beat
    // the retired round's merged pull request, or every child would silently
    // cut from (and PR into) the old round's base, bypassing the integration
    // branch and the final integration review.
    const secondRound = {
      ...reopened,
      worktree: { ...parent.worktree, branch: "board/parent-2", status: "branch-only" as const },
    };
    assert.strictEqual(
      resolveBoardCardBaseRef({
        card: { parentCardId: "parent" as never, baseBranch: null },
        cards: [secondRound],
        defaultBranch: "main",
      }),
      "board/parent-2",
    );
  }),
);

it.effect("returns null when a plan card's parent has no branch yet", () =>
  Effect.sync(() => {
    const parent = {
      id: "parent" as never,
      worktree: null,
      pullRequest: null,
      pullRequestHistory: [],
    };
    const base = resolveBoardCardBaseRef({
      card: { parentCardId: "parent" as never, baseBranch: null },
      cards: [parent],
      defaultBranch: "main",
    });
    assert.strictEqual(base, null);
  }),
);

// T3O-52 D1: one rule — clean AND durable — with reasons that carry evidence.
const decisionCases: ReadonlyArray<{
  readonly name: string;
  readonly input: Parameters<typeof boardCardWorktreeReclaimDecision>[0];
  readonly expected: { readonly safe: true } | { readonly safe: false; readonly reason: string };
}> = [
  {
    name: "clean and durable is safe",
    input: { hasWorkingTreeChanges: false, changedPaths: [], durable: true, unmergedCount: 0 },
    expected: { safe: true },
  },
  {
    name: "a dirty tree lists its paths",
    input: {
      hasWorkingTreeChanges: true,
      changedPaths: [".vscode/settings.json", ".vscode/extensions.json"],
      durable: true,
      unmergedCount: 0,
    },
    expected: {
      safe: false,
      reason: "2 uncommitted changes (.vscode/settings.json, .vscode/extensions.json)",
    },
  },
  {
    name: "a dirty tree lists at most three paths",
    input: {
      hasWorkingTreeChanges: true,
      changedPaths: ["a", "b", "c", "d"],
      durable: false,
      unmergedCount: 0,
    },
    expected: { safe: false, reason: "4 uncommitted changes (a, b, c, …)" },
  },
  {
    name: "one uncommitted change is singular",
    input: { hasWorkingTreeChanges: true, changedPaths: ["x"], durable: false, unmergedCount: 0 },
    expected: { safe: false, reason: "1 uncommitted change (x)" },
  },
  {
    name: "an open pull request is the reason given for undurable work",
    input: {
      hasWorkingTreeChanges: false,
      changedPaths: [],
      durable: false,
      unmergedCount: 3,
      openPullRequestNumber: 144,
    },
    expected: { safe: false, reason: "Pull request #144 is still open" },
  },
  {
    name: "unmerged commits are counted",
    input: { hasWorkingTreeChanges: false, changedPaths: [], durable: false, unmergedCount: 3 },
    expected: {
      safe: false,
      reason: "3 commits not in the base branch or a merged pull request",
    },
  },
  {
    name: "one unmerged commit is singular",
    input: { hasWorkingTreeChanges: false, changedPaths: [], durable: false, unmergedCount: 1 },
    expected: {
      safe: false,
      reason: "1 commit not in the base branch or a merged pull request",
    },
  },
];

for (const testCase of decisionCases) {
  it.effect(`reclaim decision: ${testCase.name}`, () =>
    Effect.sync(() => {
      assert.deepStrictEqual(boardCardWorktreeReclaimDecision(testCase.input), testCase.expected);
    }),
  );
}

it.effect("parses changed paths, taking a rename's new name", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(
      [...parseStatusPorcelainPaths(" M a.ts\n?? new.txt\nR  old.ts -> renamed.ts\n")],
      ["a.ts", "new.txt", "renamed.ts"],
    );
  }),
);

it.effect("parses every registered worktree, detached and prunable ones included", () =>
  Effect.sync(() => {
    const porcelain = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /wt/a",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/board/a",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /wt/detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      [...parseRegisteredWorktrees(porcelain)],
      [
        { path: "/repo", branch: "main", prunable: false },
        { path: "/wt/a", branch: "board/a", prunable: true },
        { path: "/wt/detached", branch: null, prunable: false },
      ],
    );
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

// ── Reclaim under the durability rule (T3O-52, D1) ────────────────────

/** A project with a bare `origin` holding its base branch, and a card
    worktree cut from it. */
const setupProjectWithRemote = Effect.gen(function* () {
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
  return { cwd, remote, initialBranch, worktreePath: provisioned.path };
});

const commitIn = (cwd: string, file: string) =>
  Effect.gen(function* () {
    yield* writeTextFile(cwd, file, `${file}\n`);
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", `add ${file}`]);
  });

const reclaimCard = (
  setup: { readonly cwd: string; readonly initialBranch: string; readonly worktreePath: string },
  extra: { readonly mergedPullRequestNumbers?: ReadonlyArray<number> } = {},
) =>
  reclaimBoardCardWorktree({
    projectCwd: setup.cwd,
    worktreePath: setup.worktreePath,
    baseRefName: setup.initialBranch,
    branch: "board/card-1",
    mergedPullRequestNumbers: extra.mergedPullRequestNumbers ?? [],
  }).pipe(
    // Only a `stillWanted` that answers no abandons a reclaim, and none is passed.
    Effect.flatMap((result) =>
      result === null ? Effect.die("reclaim abandoned") : Effect.succeed(result),
    ),
  );

const worktreeExists = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.exists(path);
  });

it.effect("reclaims a worktree whose branch was pushed WITHOUT -u", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* setupProjectWithRemote;
      yield* commitIn(setup.worktreePath, "feature.txt");
      // No upstream is set, so the old rule refused this as "not pushed".
      yield* git(setup.worktreePath, ["push", "origin", "board/card-1"]);
      yield* git(setup.cwd, ["update-ref", "-d", "refs/remotes/origin/board/card-1"]);

      const outcome = yield* reclaimCard(setup);
      assert.deepStrictEqual(outcome, { outcome: "removed", reason: null });
      assert.isFalse(yield* worktreeExists(setup.worktreePath));
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("abandons a durable reclaim when the caller no longer wants it, removing nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* setupProjectWithRemote;
      // Clean and at the base tip: durable, so only `stillWanted` stops it.
      const outcome = yield* reclaimBoardCardWorktree(
        {
          projectCwd: setup.cwd,
          worktreePath: setup.worktreePath,
          baseRefName: setup.initialBranch,
          branch: "board/card-1",
          mergedPullRequestNumbers: [],
        },
        Effect.succeed(false),
      );
      assert.isNull(outcome);
      assert.isTrue(yield* worktreeExists(setup.worktreePath));
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reclaims a squash-merged worktree whose head branch is gone, via the PR ref", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* setupProjectWithRemote;
      yield* commitIn(setup.worktreePath, "feature.txt");
      // The forge keeps the PR head under refs/pull/<n>/head after it deletes
      // the branch; the squash commit on base shares no history with HEAD.
      yield* git(setup.worktreePath, ["push", "origin", "HEAD:refs/pull/7/head"]);
      yield* git(setup.worktreePath, ["push", "-u", "origin", "board/card-1"]);
      yield* git(setup.cwd, ["push", "origin", "--delete", "board/card-1"]);
      yield* git(setup.cwd, ["fetch", "--prune", "origin"]);

      // Without the merged PR number there is nothing proving the commit.
      const refused = yield* reclaimCard(setup);
      assert.strictEqual(refused.outcome, "blocked");
      assert.strictEqual(
        refused.reason,
        "1 commit not in the base branch or a merged pull request",
      );

      const outcome = yield* reclaimCard(setup, { mergedPullRequestNumbers: [7] });
      assert.strictEqual(outcome.outcome, "removed");
      // The probe's private ref does not outlive it.
      assert.strictEqual(yield* git(setup.cwd, ["for-each-ref", "refs/t3o"]), "");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reclaims a never-pushed worktree whose HEAD is already in the remote base", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* setupProjectWithRemote;
      yield* commitIn(setup.worktreePath, "feature.txt");
      // Merged straight into base and pushed, no pull request, branch never pushed.
      yield* git(setup.cwd, ["merge", "--ff-only", "board/card-1"]);
      yield* git(setup.cwd, ["push", "origin", setup.initialBranch]);

      const outcome = yield* reclaimCard(setup);
      assert.strictEqual(outcome.outcome, "removed");
      // Reclaim never touches the branch.
      assert.match(yield* git(setup.cwd, ["branch", "--list", "board/card-1"]), /board\/card-1/);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps a worktree whose commits exist nowhere else, and counts them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* setupProjectWithRemote;
      yield* commitIn(setup.worktreePath, "one.txt");
      yield* commitIn(setup.worktreePath, "two.txt");

      const outcome = yield* reclaimCard(setup, { mergedPullRequestNumbers: [9] });
      assert.deepStrictEqual(outcome, {
        outcome: "blocked",
        reason: "2 commits not in the base branch or a merged pull request",
      });
      assert.isTrue(yield* worktreeExists(setup.worktreePath));
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses to reclaim a dirty worktree, naming the files, and keeps it on disk", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* setupProjectWithRemote;
      yield* writeTextFile(setup.worktreePath, "README.md", "# changed, not committed\n");

      const outcome = yield* reclaimCard(setup);
      assert.deepStrictEqual(outcome, {
        outcome: "blocked",
        reason: "1 uncommitted change (README.md)",
      });
      assert.isTrue(yield* worktreeExists(setup.worktreePath));
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("ignored build output does not block a reclaim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* setupProjectWithRemote;
      yield* writeTextFile(setup.worktreePath, ".gitignore", "target/\n");
      yield* git(setup.worktreePath, ["add", "."]);
      yield* git(setup.worktreePath, ["commit", "-m", "ignore target"]);
      yield* git(setup.worktreePath, ["push", "origin", "board/card-1"]);
      yield* writeTextFile(setup.worktreePath, "target/debug/big.bin", "x");

      const outcome = yield* reclaimCard(setup);
      assert.strictEqual(outcome.outcome, "removed");
      assert.isFalse(yield* worktreeExists(setup.worktreePath));
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("force-removes a dirty worktree but keeps the branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* setupProjectWithRemote;
      yield* commitIn(setup.worktreePath, "unpushed.txt");
      yield* writeTextFile(setup.worktreePath, "README.md", "# dirty\n");

      yield* forceRemoveBoardCardWorktree({
        projectCwd: setup.cwd,
        worktreePath: setup.worktreePath,
      });
      assert.isFalse(yield* worktreeExists(setup.worktreePath));
      assert.match(yield* git(setup.cwd, ["branch", "--list", "board/card-1"]), /board\/card-1/);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
