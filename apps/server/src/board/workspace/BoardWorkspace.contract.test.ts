/**
 * T3o (T3O-64, D21): every named board git and forge operation answers the
 * same through `LocalBoardWorkspace` and through `RemoteBoardWorkspace` — the
 * remote one reaching an in-process worker over the real `boardWorker.git.*`
 * handlers, with every payload, answer and error round-tripped through the
 * wire schemas.
 *
 * Each implementation runs one scenario against its own fresh set of real git
 * repositories — a bare remote, the project checkout, and a second clone that
 * pushes as another worker would. Commit dates and identities are fixed, so
 * the two sets hold identical commits, and the two transcripts must match once
 * their temp roots are taken out.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  type BoardWorkspacePullRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { RpcClientError } from "effect/rpc";

import { ServerConfig } from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import type { BoardPullRequestGateway } from "../BoardPullRequestGateway.ts";
import { WorkerRpcError } from "../workers/WorkerTransport.ts";
import { WorktreeRetirer } from "../worktreeRetire.ts";
import { worktreeRetirerTestLayer } from "../worktreeRetire.testkit.ts";
import {
  bindBoardWorkspace,
  type BoardWorkspace,
  type BoardWorkspaceFailure,
} from "./BoardWorkspace.ts";
import { boardSession, makeInProcessWorker, remoteOver } from "./inProcessWorker.testkit.ts";
import { makeRemoteBoardWorkspace } from "./RemoteBoardWorkspace.ts";
import { makeBoardWorkspaces } from "./workspaceLayer.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-board-workspace-test-",
});
const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = worktreeRetirerTestLayer().pipe(
  Layer.provideMerge(GitLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project-repo");

/** What a failed operation said. */
const detailOf = (failure: BoardWorkspaceFailure) =>
  failure._tag === "BoardWorkerGitError" ? failure.detail : failure.message;

/** Fixed, so two fresh repositories built the same way hold the same commits. */
const FIXED = {
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "board.workspace.test.git",
      cwd,
      args,
      env: FIXED,
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  });

const identify = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["config", "user.email", "board@test.invalid"]);
    yield* git(cwd, ["config", "user.name", "Board Tester"]);
  });

const commitFile = (cwd: string, file: string, contents: string, message: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(NodePath.join(cwd, file), contents);
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", message]);
    return yield* git(cwd, ["rev-parse", "HEAD"]);
  });

interface Env {
  readonly root: string;
  readonly remote: string;
  /** The project's checkout on the worker under test. */
  readonly checkout: string;
  /** Another clone of the same remote: a second worker, or a merge on the forge. */
  readonly pusher: string;
}

/** A bare remote with one commit on `main`, the project checkout, and a second clone. */
const makeEnv = (label: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: `board-ws-${label}-` });
    const remote = NodePath.join(root, "remote.git");
    yield* git(root, ["init", "--bare", "-b", "main", remote]);
    const seed = NodePath.join(root, "seed");
    yield* git(root, ["clone", remote, seed]);
    yield* identify(seed);
    yield* git(seed, ["checkout", "-b", "main"]);
    yield* commitFile(seed, "README.md", "# repo\n", "initial");
    yield* git(seed, ["push", "origin", "main"]);
    const checkout = NodePath.join(root, `repo-${label}`);
    yield* git(root, ["clone", remote, checkout]);
    yield* identify(checkout);
    const pusher = NodePath.join(root, "pusher");
    yield* git(root, ["clone", remote, pusher]);
    yield* identify(pusher);
    return { root, remote, checkout, pusher } satisfies Env;
  });

const foundPullRequest: BoardWorkspacePullRequest = {
  number: 7,
  title: "board/t-1",
  url: "https://example.invalid/pr/7",
  baseRef: "main",
  headRef: "board/t-1",
  state: "open",
  isDraft: true,
};

/** A forge that answers from a script and records what it was asked. */
const scriptedForge = (asked: Array<string>) =>
  ({
    find: (input) =>
      Effect.sync(() => {
        asked.push(`find:${input.branch}:${input.force === true}`);
        return foundPullRequest;
      }),
    get: (input) =>
      Effect.sync(() => {
        asked.push(`get:${input.number}:${input.force === true}`);
        return foundPullRequest;
      }),
    merge: (input) => Effect.sync(() => void asked.push(`merge:${input.number}:${input.method}`)),
    mergeState: (input) =>
      Effect.sync(() => {
        asked.push(`mergeState:${input.number}`);
        return {
          mergeable: "blocked",
          blockedReason: "behind",
          checks: { total: 2, passed: 1, pending: 1, failed: 0, failing: [], running: ["ci"] },
          headSha: "abc",
          checksUnread: false,
        } as const;
      }),
    markReady: (input) =>
      Effect.sync(() => {
        asked.push(`markReady:${input.number}`);
        return "readied" as const;
      }),
    repository: () =>
      Effect.sync(() => {
        asked.push("repository");
        return { repository: "owner/repo", path: "owner/repo" };
      }),
  }) satisfies BoardPullRequestGateway["Service"];

/** This server's workspaces over the real driver, with `checkout` as the project.
    Its own board has workers unless `boardHasWorkers` says otherwise, so its
    local workspace measures a base the way a worker's does. */
const workspacesOver = (
  checkout: string,
  pullRequests: BoardPullRequestGateway["Service"] = scriptedForge([]),
  boardHasWorkers = true,
  ownBoardBranches: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const pathService = yield* Path.Path;
    return makeBoardWorkspaces(
      {
        git: yield* GitVcsDriver.GitVcsDriver,
        pullRequests,
        retirer: yield* WorktreeRetirer,
        fileSystem: yield* FileSystem.FileSystem,
        path: pathService,
        projectRoot: (id) => Effect.succeed(id === projectId ? checkout : null),
        worktreeRoots: Effect.succeed([pathService.resolve(config.worktreesDir)]),
        boardHasWorkers: Effect.succeed(boardHasWorkers),
      },
      { ownBoardBranches: Effect.succeed(new Set(ownBoardBranches)) },
    );
  });

/** Every named operation, in an order that exercises each one's real work. */
const scenario = (ws: BoardWorkspace, env: Env, forgeAsked: Array<string>) =>
  Effect.gen(function* () {
    const p = { projectId };
    const out: Record<string, unknown> = {};
    out.defaultBranch = yield* ws.resolveDefaultBranch(p);
    out.remoteDefaultBranch = yield* ws.remoteDefaultBranch(p);

    // A base pushed after this checkout was cloned: it has to be fetched.
    yield* git(env.pusher, ["checkout", "-b", "develop"]);
    yield* commitFile(env.pusher, "develop.txt", "develop\n", "develop");
    yield* git(env.pusher, ["push", "origin", "develop"]);
    yield* git(env.pusher, ["checkout", "main"]);
    out.ensureDevelop = yield* ws.ensureLocalBaseBranch({ ...p, base: "develop" });
    out.ensureMissing = yield* ws.ensureLocalBaseBranch({ ...p, base: "no-such-branch" });

    const worktree = yield* ws.provisionWorktree({
      ...p,
      branch: "board/t-1",
      baseRefName: "main",
    });
    out.provision = worktree;
    out.provisionAgain = yield* ws.provisionWorktree({
      ...p,
      branch: "board/t-1",
      baseRefName: "main",
    });
    out.pinGhDefault = yield* ws.pinGhDefault({ ...p, worktreePath: worktree.path });
    out.heartbeatBefore = yield* ws.branchHeartbeat({
      ...p,
      worktreePath: worktree.path,
      baseRefName: "main",
    });
    yield* commitFile(worktree.path, "work.txt", "work\n", "card work");
    out.heartbeatAfter = yield* ws.branchHeartbeat({
      ...p,
      worktreePath: worktree.path,
      baseRefName: "main",
    });
    out.durability = yield* ws.probeWorktreeDurability({
      ...p,
      worktreePath: worktree.path,
      baseRefName: "main",
      branch: "board/t-1",
      mergedPullRequestNumbers: [],
      openPullRequestNumber: null,
      baseAlreadyFetched: false,
    });

    out.tipBefore = yield* ws.measureBaseTip({ ...p, baseRefName: "main" });
    yield* commitFile(env.pusher, "merged.txt", "merged\n", "a merge elsewhere");
    yield* git(env.pusher, ["push", "origin", "main"]);
    out.tipAfter = yield* ws.measureBaseTip({ ...p, baseRefName: "main" });

    out.integration = yield* ws.createIntegrationBranch({
      ...p,
      branch: "board/t-p",
      base: "main",
    });
    out.integrationAgain = yield* ws.createIntegrationBranch({
      ...p,
      branch: "board/t-p",
      base: "main",
    });
    out.remoteTip = yield* ws.remoteBranchTip({ ...p, branch: "board/t-p" });
    out.remoteTipMissing = yield* ws.remoteBranchTip({ ...p, branch: "board/none" });
    // A remote that can't be asked fails, rather than reading as "not there".
    const originUrl = yield* git(env.checkout, ["remote", "get-url", "origin"]);
    yield* git(env.checkout, ["remote", "set-url", "origin", `${originUrl}-gone`]);
    out.remoteTipUnreachable = yield* ws
      .remoteBranchTip({ ...p, branch: "board/t-p" })
      .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "answered" }));
    yield* git(env.checkout, ["remote", "set-url", "origin", originUrl]);
    out.mergeConflict = yield* ws.probeLocalMergeConflict({
      ...p,
      headBranch: "board/t-p",
      baseBranch: "main",
    });
    out.pullMergedBase = yield* ws.pullMergedBaseBranch({ ...p, baseBranch: "main" });
    out.listBoardWorktrees = yield* ws.listBoardWorktrees(p);
    out.goneWhileThere = yield* ws.goneWorktreePath({
      ...p,
      worktreePath: worktree.path,
      branch: "board/t-1",
    });
    out.gitUserName = yield* ws.gitUserName(p);
    out.retire = yield* ws.retireWorktree({
      ...p,
      worktreePath: worktree.path,
      kind: "forced",
      verifiedClean: false,
    });
    out.goneAfterRetire = yield* ws.goneWorktreePath({
      ...p,
      worktreePath: worktree.path,
      branch: "board/t-1",
    });
    out.prune = yield* ws.pruneWorktree({ ...p, worktreePath: worktree.path });
    out.fromRemote = yield* ws.provisionWorktreeFromRemoteBranch({
      ...p,
      branch: "board/t-p",
      baseRefName: "main",
    });
    out.deleteCardBranch = yield* ws.deleteCardBranch({ ...p, branch: "board/t-1" });

    out.pullRequestByBranch = yield* ws.pullRequestByBranch({
      ...p,
      branch: "board/t-1",
      worktreePath: null,
      force: true,
    });
    out.getPullRequest = yield* ws.getPullRequest({ ...p, number: 7, force: false });
    out.mergePullRequest = yield* ws.mergePullRequest({ ...p, number: 7, method: "squash" });
    out.pullRequestMergeState = yield* ws.pullRequestMergeState({ ...p, number: 7 });
    out.markPullRequestReady = yield* ws.markPullRequestReady({ ...p, number: 7 });
    out.pullRequestRepository = yield* ws.pullRequestRepository(p);
    out.forgeAsked = [...forgeAsked];

    out.unknownProject = yield* Effect.flip(
      ws.resolveDefaultBranch({ projectId: ProjectId.make("project-unknown") }),
    );
    return out;
  });

/** A transcript with its temp root and per-run repository name taken out. */
const normalise = (env: Env, label: string, transcript: unknown) =>
  JSON.parse(
    JSON.stringify(transcript).split(env.root).join("<root>").split(`repo-${label}`).join("repo"),
  );

describe("BoardWorkspace contract (T3O-64)", () => {
  it.effect("every named operation answers the same locally and through a worker", () =>
    Effect.gen(function* () {
      const localEnv = yield* makeEnv("local");
      const localAsked: Array<string> = [];
      const local = (yield* workspacesOver(localEnv.checkout, scriptedForge(localAsked))).local;
      const localTranscript = normalise(
        localEnv,
        "local",
        yield* scenario(local, localEnv, localAsked),
      );

      const remoteEnv = yield* makeEnv("remote");
      const remoteAsked: Array<string> = [];
      const worker = makeInProcessWorker(
        yield* workspacesOver(remoteEnv.checkout, scriptedForge(remoteAsked)),
      );
      const remoteTranscript = normalise(
        remoteEnv,
        "remote",
        yield* scenario(remoteOver(worker), remoteEnv, remoteAsked),
      );

      assert.deepStrictEqual(remoteTranscript, localTranscript);
      // And the scenario did real work, rather than two empty answers agreeing.
      assert.strictEqual(localTranscript.defaultBranch.defaultBranch, "main");
      assert.deepStrictEqual(localTranscript.ensureDevelop, { exists: true });
      assert.deepStrictEqual(localTranscript.ensureMissing, { exists: false });
      assert.notStrictEqual(localTranscript.tipBefore.tip, localTranscript.tipAfter.tip);
      assert.deepStrictEqual(localTranscript.integration, { outcome: "ready", pushed: true });
      assert.isNull(localTranscript.remoteTipMissing);
      assert.strictEqual(localTranscript.remoteTipUnreachable, "BoardWorkerGitError");
      assert.strictEqual(localTranscript.remoteTip.author, "Board Tester");
      assert.strictEqual(localTranscript.mergeConflict.result, "clean");
      assert.deepStrictEqual(localTranscript.pullMergedBase, {
        updated: true,
        skippedReason: null,
      });
      assert.strictEqual(localTranscript.listBoardWorktrees.worktrees.length, 1);
      assert.isNull(localTranscript.goneWhileThere.path);
      assert.isNotNull(localTranscript.goneAfterRetire.path);
      assert.strictEqual(localTranscript.gitUserName.name, "Board Tester");
      assert.deepStrictEqual(localTranscript.retire, { outcome: "removed", hookWarning: null });
      assert.strictEqual(localTranscript.heartbeatBefore.committedAt, null);
      assert.isString(localTranscript.heartbeatAfter.committedAt);
      assert.strictEqual(localTranscript.unknownProject._tag, "BoardWorkerGitError");
      assert.strictEqual(localTranscript.deleteCardBranch.localDeleted, true);
      assert.deepStrictEqual(localTranscript.forgeAsked, [
        "find:board/t-1:true",
        "get:7:false",
        "merge:7:squash",
        "mergeState:7",
        "markReady:7",
        "repository",
      ]);
      // The remote run reached the worker for every one of them.
      assert.isAtLeast(new Set(worker.calls).size, 25);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a merge pushed from another clone is base movement without a local pull", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("stale");
      const ws = remoteOver(makeInProcessWorker(yield* workspacesOver(env.checkout)));
      const before = yield* ws.measureBaseTip({ projectId, baseRefName: "main" });
      const localMainBefore = yield* git(env.checkout, ["rev-parse", "refs/heads/main"]);
      assert.strictEqual(before.tip, localMainBefore);

      yield* commitFile(env.pusher, "elsewhere.txt", "x\n", "merged on another worker");
      yield* git(env.pusher, ["push", "origin", "main"]);
      const pushed = yield* git(env.pusher, ["rev-parse", "HEAD"]);

      const after = yield* ws.measureBaseTip({ projectId, baseRefName: "main" });
      assert.strictEqual(after.tip, pushed);
      // Nothing pulled the merge into the checkout's own branch.
      assert.strictEqual(
        yield* git(env.checkout, ["rev-parse", "refs/heads/main"]),
        localMainBefore,
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a board with no workers measures its local base without fetching", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("localonly");
      const workspaces = yield* workspacesOver(env.checkout, scriptedForge([]), false);
      const localMain = yield* git(env.checkout, ["rev-parse", "refs/heads/main"]);
      const trackedBefore = yield* git(env.checkout, ["rev-parse", "refs/remotes/origin/main"]);

      // The remote moves on and nothing pulls it here: a base that is merely
      // behind is not movement, so a tip recorded before workers existed
      // still compares equal.
      yield* commitFile(env.pusher, "elsewhere.txt", "x\n", "pushed elsewhere");
      yield* git(env.pusher, ["push", "origin", "main"]);

      const measured = yield* workspaces.local.measureBaseTip({ projectId, baseRefName: "main" });
      assert.strictEqual(measured.tip, localMain);
      // No fetch ran: the remote-tracking ref has not moved.
      assert.strictEqual(
        yield* git(env.checkout, ["rev-parse", "refs/remotes/origin/main"]),
        trackedBefore,
      );
      // The same server, working for a central board, does read the remote.
      const forCentral = yield* workspaces.forCentral.measureBaseTip({
        projectId,
        baseRefName: "main",
      });
      assert.strictEqual(forCentral.tip, yield* git(env.pusher, ["rev-parse", "HEAD"]));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a checkout with no remote measures its local base, as it always did", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("noremote");
      yield* git(env.checkout, ["remote", "remove", "origin"]);
      const local = (yield* workspacesOver(env.checkout)).local;
      const tip = yield* local.measureBaseTip({ projectId, baseRefName: "main" });
      assert.strictEqual(tip.tip, yield* git(env.checkout, ["rev-parse", "refs/heads/main"]));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("an integration branch cut on worker A is provisioned for a child on worker B", () =>
    Effect.gen(function* () {
      // Two workers, one remote: A is the env's checkout, B the second clone,
      // cloned BEFORE the integration branch existed.
      const env = yield* makeEnv("split");
      const workerA = remoteOver(makeInProcessWorker(yield* workspacesOver(env.checkout)));
      const workerB = remoteOver(makeInProcessWorker(yield* workspacesOver(env.pusher)));

      const cut = yield* workerA.createIntegrationBranch({
        projectId,
        branch: "board/t-parent",
        base: "main",
      });
      assert.deepStrictEqual(cut, { outcome: "ready", pushed: true });
      const integrationTip = yield* git(env.checkout, ["rev-parse", "refs/heads/board/t-parent"]);

      // B has never seen it; making it a local base fetches it from the remote.
      const base = yield* workerB.ensureLocalBaseBranch({ projectId, base: "board/t-parent" });
      assert.deepStrictEqual(base, { exists: true });
      const child = yield* workerB.provisionWorktree({
        projectId,
        branch: "board/t-child",
        baseRefName: "board/t-parent",
      });
      assert.strictEqual(yield* git(child.path, ["rev-parse", "HEAD"]), integrationTip);
      assert.strictEqual(child.baseRefName, "board/t-parent");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a card moved A→B→A lands on what B pushed, not A's stale local branch", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("roundtrip");
      const workerA = (yield* workspacesOver(env.checkout)).local;
      const workerB = (yield* workspacesOver(env.pusher)).local;
      const branch = "board/t-rt";
      const retire = (ws: BoardWorkspace, worktreePath: string) =>
        ws.retireWorktree({ projectId, worktreePath, kind: "forced", verifiedClean: false });

      const onA = yield* workerA.provisionWorktree({ projectId, branch, baseRefName: "main" });
      yield* commitFile(onA.path, "a.txt", "a\n", "on A");
      yield* git(onA.path, ["push", "-u", "origin", branch]);
      yield* retire(workerA, onA.path);

      const onB = yield* workerB.provisionWorktreeFromRemoteBranch({
        projectId,
        branch,
        baseRefName: "main",
      });
      const pushedFromB = yield* commitFile(onB.path, "b.txt", "b\n", "on B");
      yield* git(onB.path, ["push", "origin", branch]);
      yield* retire(workerB, onB.path);

      const backOnA = yield* workerA.provisionWorktreeFromRemoteBranch({
        projectId,
        branch,
        baseRefName: "main",
      });
      assert.strictEqual(yield* git(backOnA.path, ["rev-parse", "HEAD"]), pushedFromB);

      // Commits only A's copy holds are never thrown away to match the remote.
      yield* commitFile(backOnA.path, "only-a.txt", "a\n", "not pushed");
      yield* retire(workerA, backOnA.path);
      const diverged = yield* Effect.flip(
        workerA.provisionWorktreeFromRemoteBranch({ projectId, branch, baseRefName: "main" }),
      );
      assert.include(detailOf(diverged), "has commits origin does not");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a card moved A→B→A lands on B's rebased, force-pushed branch", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("rebased");
      const workerA = (yield* workspacesOver(env.checkout)).local;
      const workerB = (yield* workspacesOver(env.pusher)).local;
      const branch = "board/t-rb";
      const retire = (ws: BoardWorkspace, worktreePath: string) =>
        ws.retireWorktree({ projectId, worktreePath, kind: "forced", verifiedClean: false });

      const onA = yield* workerA.provisionWorktree({ projectId, branch, baseRefName: "main" });
      yield* commitFile(onA.path, "a.txt", "a\n", "on A");
      yield* git(onA.path, ["push", "-u", "origin", branch]);
      yield* retire(workerA, onA.path);

      // B rewrites what A pushed and force-pushes it, so A's leftover branch
      // is no longer an ancestor of the remote tip.
      const onB = yield* workerB.provisionWorktreeFromRemoteBranch({
        projectId,
        branch,
        baseRefName: "main",
      });
      yield* commitFile(onB.path, "b.txt", "b\n", "on B");
      yield* git(onB.path, ["reset", "--soft", "HEAD~2"]);
      const rewritten = yield* commitFile(onB.path, "c.txt", "c\n", "squashed on B");
      yield* git(onB.path, ["push", "--force", "origin", branch]);
      yield* retire(workerB, onB.path);

      // The move's own check (and any plain fetch on A) moves A's tracking
      // ref to the rewritten tip before A provisions from it.
      assert.strictEqual((yield* workerA.remoteBranchTip({ projectId, branch }))?.sha, rewritten);

      const backOnA = yield* workerA.provisionWorktreeFromRemoteBranch({
        projectId,
        branch,
        baseRefName: "main",
      });
      assert.strictEqual(yield* git(backOnA.path, ["rev-parse", "HEAD"]), rewritten);

      // Commits only A holds are still refused after the rewrite.
      yield* commitFile(backOnA.path, "only-a.txt", "a\n", "not pushed");
      yield* retire(workerA, backOnA.path);
      const diverged = yield* Effect.flip(
        workerA.provisionWorktreeFromRemoteBranch({ projectId, branch, baseRefName: "main" }),
      );
      assert.include(detailOf(diverged), "has commits origin does not");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "the durability probe reports uncommitted files, unpushed commits and the upstream",
    () =>
      Effect.gen(function* () {
        const env = yield* makeEnv("durable");
        const ws = remoteOver(makeInProcessWorker(yield* workspacesOver(env.checkout)));
        const worktree = yield* ws.provisionWorktree({
          projectId,
          branch: "board/t-d",
          baseRefName: "main",
        });
        const probe = (baseAlreadyFetched = false) =>
          ws.probeWorktreeDurability({
            projectId,
            worktreePath: worktree.path,
            baseRefName: "main",
            branch: "board/t-d",
            mergedPullRequestNumbers: [],
            openPullRequestNumber: null,
            baseAlreadyFetched,
          });

        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(NodePath.join(worktree.path, "draft.txt"), "draft\n");
        const dirty = yield* probe();
        assert.isTrue(dirty.hasWorkingTreeChanges);
        assert.deepStrictEqual(dirty.changedPaths, ["draft.txt"]);
        assert.isFalse(dirty.durable);
        assert.isFalse(dirty.hasUpstream);

        yield* git(worktree.path, ["add", "."]);
        yield* git(worktree.path, ["commit", "-m", "draft"]);
        const unpushed = yield* probe();
        assert.isFalse(unpushed.hasWorkingTreeChanges);
        assert.isFalse(unpushed.durable);
        assert.isFalse(unpushed.hasUpstream);
        assert.strictEqual(unpushed.unpushedCount, 1);
        assert.strictEqual(unpushed.unmergedCount, 1);
        assert.isTrue(unpushed.baseFetched);

        yield* git(worktree.path, ["push", "-u", "origin", "board/t-d"]);
        const pushed = yield* probe(true);
        assert.isTrue(pushed.durable);
        assert.isTrue(pushed.hasUpstream);
        assert.strictEqual(pushed.unpushedCount, 0);
        // Already fetched this pass, so it is not fetched again.
        assert.isFalse(pushed.baseFetched);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "a reclaim through a worker removes a durable worktree and keeps an undurable one",
    () =>
      Effect.gen(function* () {
        const env = yield* makeEnv("reclaim");
        const ws = remoteOver(makeInProcessWorker(yield* workspacesOver(env.checkout)));
        const kept = yield* ws.provisionWorktree({
          projectId,
          branch: "board/t-kept",
          baseRefName: "main",
        });
        yield* commitFile(kept.path, "kept.txt", "kept\n", "not pushed");
        const keptOutcome = yield* ws.reclaimWorktree({
          projectId,
          worktreePath: kept.path,
          baseRefName: "main",
          branch: "board/t-kept",
          mergedPullRequestNumbers: [],
        });
        assert.strictEqual(keptOutcome?.outcome, "blocked");

        const clean = yield* ws.provisionWorktree({
          projectId,
          branch: "board/t-clean",
          baseRefName: "main",
        });
        // Asked before removal; a board that no longer wants it gone keeps it.
        const abandoned = yield* ws.reclaimWorktree(
          {
            projectId,
            worktreePath: clean.path,
            baseRefName: "main",
            branch: "board/t-clean",
            mergedPullRequestNumbers: [],
          },
          Effect.succeed(false),
        );
        assert.isNull(abandoned);
        const removed = yield* ws.reclaimWorktree({
          projectId,
          worktreePath: clean.path,
          baseRefName: "main",
          branch: "board/t-clean",
          mergedPullRequestNumbers: [],
        });
        assert.strictEqual(removed?.outcome, "removed");
        const fileSystem = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fileSystem.exists(clean.path));
        assert.isTrue(yield* fileSystem.exists(kept.path));
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("the worker side of the named operations (T3O-64)", () => {
  it.effect("refuses a path that is not one of the project's worktrees", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("guard");
      const ws = remoteOver(makeInProcessWorker(yield* workspacesOver(env.checkout)));
      for (const worktreePath of [env.checkout, env.root, "/etc"]) {
        const refused = yield* Effect.flip(ws.pinGhDefault({ projectId, worktreePath }));
        assert.strictEqual(refused._tag, "BoardWorkerGitError");
        assert.include(detailOf(refused), "not one of this project's worktrees");
      }
      // A folder under the worktrees directory that this project never
      // registered (another project's checkout, the per-repo container) is
      // not this project's either.
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const foreign = NodePath.join(config.worktreesDir, "other-repo", "board-x");
      yield* fileSystem.makeDirectory(foreign, { recursive: true });
      for (const worktreePath of [foreign, NodePath.dirname(foreign)]) {
        const refused = yield* Effect.flip(
          ws.retireWorktree({ projectId, worktreePath, kind: "forced", verifiedClean: false }),
        );
        assert.strictEqual(refused._tag, "BoardWorkerGitError");
        assert.include(detailOf(refused), "not one of this project's worktrees");
      }
      assert.isTrue(yield* fileSystem.exists(foreign));
      // A checkout already gone from disk and git may still be named on retry.
      const gone = yield* ws.goneWorktreePath({
        projectId,
        worktreePath: NodePath.join(config.worktreesDir, "repo", "board-gone"),
        branch: "board/gone",
      });
      assert.isNotNull(gone);
      // A registered worktree outside the worktrees directory is still the
      // project's own.
      const elsewhere = NodePath.join(env.root, "elsewhere");
      yield* git(env.checkout, ["worktree", "add", "-b", "board/by-hand", elsewhere]);
      const heartbeat = yield* ws.branchHeartbeat({
        projectId,
        worktreePath: elsewhere,
        baseRefName: "main",
      });
      assert.isNull(heartbeat.committedAt);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses to change or remove a worktree the central board did not make", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("owned");
      const workspaces = yield* workspacesOver(env.checkout);
      const central = remoteOver(makeInProcessWorker(workspaces));
      const fileSystem = yield* FileSystem.FileSystem;
      // The worker's own board's checkout, and a user's thread worktree: both
      // registered with the project's repository, neither the central board's.
      const own = yield* workspaces.local.provisionWorktree({
        projectId,
        branch: "board/own-w",
        baseRefName: "main",
      });
      const thread = NodePath.join(env.root, "thread-worktree");
      yield* git(env.checkout, ["worktree", "add", "-b", "feature/thread", thread]);
      for (const worktreePath of [own.path, thread]) {
        for (const write of [
          central.retireWorktree({ projectId, worktreePath, kind: "forced", verifiedClean: false }),
          central.pruneWorktree({ projectId, worktreePath }),
          central.pinGhDefault({ projectId, worktreePath }),
        ]) {
          const refused = yield* Effect.flip(write);
          assert.strictEqual(refused._tag, "BoardWorkerGitError");
          assert.include(detailOf(refused), "that the board made");
        }
        assert.isTrue(yield* fileSystem.exists(worktreePath));
        // Reading it is still fine.
        const heartbeat = yield* central.branchHeartbeat({
          projectId,
          worktreePath,
          baseRefName: "main",
        });
        assert.isNull(heartbeat.committedAt);
      }

      // The central board's own checkout is removed, and once its folder is
      // gone, a retry may still drop the registration.
      const placed = yield* central.provisionWorktree({
        projectId,
        branch: "board/central-w",
        baseRefName: "main",
      });
      yield* central.pinGhDefault({ projectId, worktreePath: placed.path });
      yield* fileSystem.remove(placed.path, { recursive: true });
      yield* central.pruneWorktree({ projectId, worktreePath: placed.path });
      const listed = yield* git(env.checkout, ["worktree", "list", "--porcelain"]);
      assert.notInclude(listed, placed.path);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "refuses to delete a branch of the worker's own board or a checkout it didn't make",
    () =>
      Effect.gen(function* () {
        const env = yield* makeEnv("branches");
        const workspaces = yield* workspacesOver(env.checkout, undefined, true, ["board/own-card"]);
        const central = remoteOver(makeInProcessWorker(workspaces));
        // The worker's own board's checkout, a user's thread worktree on a
        // board-shaped branch, and a branch on the worker board's own card that
        // no checkout holds right now but the remote does.
        yield* workspaces.local.provisionWorktree({
          projectId,
          branch: "board/own-w",
          baseRefName: "main",
        });
        const thread = NodePath.join(env.root, "thread-worktree");
        yield* git(env.checkout, ["worktree", "add", "-b", "board/by-hand", thread]);
        yield* git(env.checkout, ["branch", "board/own-card", "main"]);
        yield* git(env.checkout, ["push", "origin", "board/own-card"]);
        for (const branch of ["board/own-w", "board/by-hand", "board/own-card"]) {
          const refused = yield* Effect.flip(central.deleteCardBranch({ projectId, branch }));
          assert.strictEqual(refused._tag, "BoardWorkerGitError");
          assert.include(detailOf(refused), "own board");
          assert.strictEqual(
            yield* git(env.checkout, ["branch", "--list", branch]).pipe(
              Effect.map((out) => out !== ""),
            ),
            true,
          );
        }
        // A bare repository needs `--git-dir` since upstream sets `safe.bareRepository=explicit`.
        assert.notStrictEqual(
          yield* git(env.remote, ["--git-dir=.", "branch", "--list", "board/own-card"]),
          "",
        );

        // The central board's own branch, its checkout retired, is deleted.
        const placed = yield* central.provisionWorktree({
          projectId,
          branch: "board/central-b",
          baseRefName: "main",
        });
        yield* central.retireWorktree({
          projectId,
          worktreePath: placed.path,
          kind: "forced",
          verifiedClean: false,
        });
        const deleted = yield* central.deleteCardBranch({ projectId, branch: "board/central-b" });
        assert.isTrue(deleted.localDeleted);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses to build a central card on a branch of the worker's own board", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("own-branch");
      const workspaces = yield* workspacesOver(env.checkout, undefined, true, ["board/K-1"]);
      const central = remoteOver(makeInProcessWorker(workspaces));
      // Both boards name branches `board/<key>`. The worker board's card has
      // commits on its branch and no checkout holds it right now.
      yield* git(env.checkout, ["branch", "board/K-1", "main"]);
      yield* git(env.checkout, ["push", "origin", "board/K-1"]);
      const tip = yield* git(env.checkout, ["rev-parse", "board/K-1"]);
      for (const provision of [
        central.provisionWorktree({ projectId, branch: "board/K-1", baseRefName: "main" }),
        central.provisionWorktreeFromRemoteBranch({
          projectId,
          branch: "board/K-1",
          baseRefName: "main",
        }),
        // A central split parent of the same key would adopt the worker
        // board's integration branch as its own.
        central.createIntegrationBranch({ projectId, branch: "board/K-1", base: "main" }),
      ] as ReadonlyArray<Effect.Effect<object, BoardWorkspaceFailure>>) {
        const refused = yield* Effect.flip(provision);
        assert.strictEqual(refused._tag, "BoardWorkerGitError");
        assert.include(detailOf(refused), "own board");
      }
      assert.strictEqual(yield* git(env.checkout, ["rev-parse", "board/K-1"]), tip);
      const listed = yield* central.listBoardWorktrees({ projectId });
      assert.deepStrictEqual(listed.worktrees, []);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a worker's own board and the central board each sweep only their own checkouts", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("owners");
      const workspaces = yield* workspacesOver(env.checkout);
      const central = remoteOver(makeInProcessWorker(workspaces));
      // The worker runs a board of its own on the same repository, so both
      // boards' checkouts share its worktrees directory.
      const own = yield* workspaces.local.provisionWorktree({
        projectId,
        branch: "board/own-1",
        baseRefName: "main",
      });
      const placed = yield* central.provisionWorktree({
        projectId,
        branch: "board/central-1",
        baseRefName: "main",
      });
      const ownList = yield* workspaces.local.listBoardWorktrees({ projectId });
      const centralList = yield* central.listBoardWorktrees({ projectId });
      assert.deepStrictEqual(
        ownList.worktrees.map((worktree) => worktree.branch),
        ["board/own-1"],
      );
      assert.deepStrictEqual(
        centralList.worktrees.map((worktree) => worktree.branch),
        ["board/central-1"],
      );
      // The marker sits in git's private dir: the checkout stays clean.
      const status = yield* git(placed.path, ["status", "--porcelain"]);
      assert.strictEqual(status.trim(), "");
      assert.notStrictEqual(own.path, placed.path);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a checkout whose owner cannot be read is in neither board's sweep", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("owner-unknown");
      const workspaces = yield* workspacesOver(env.checkout);
      const central = remoteOver(makeInProcessWorker(workspaces));
      const placed = yield* central.provisionWorktree({
        projectId,
        branch: "board/central-2",
        baseRefName: "main",
      });
      // git can no longer resolve the checkout's private dir, so its marker
      // is unreadable; it is still registered, so git lists it.
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(NodePath.join(placed.path, ".git"), "not a gitfile\n");
      const ownList = yield* workspaces.local.listBoardWorktrees({ projectId });
      const centralList = yield* central.listBoardWorktrees({ projectId });
      assert.deepStrictEqual(ownList.worktrees, []);
      assert.deepStrictEqual(centralList.worktrees, []);
      // Nor will either board adopt it, and the refusal says why.
      const refused = yield* Effect.flip(
        workspaces.local.provisionWorktree({
          projectId,
          branch: "board/central-2",
          baseRefName: "main",
        }),
      );
      assert.include(detailOf(refused), "cannot say which board owns it");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("neither board adopts the other's checkout of the same branch", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("adopt");
      const workspaces = yield* workspacesOver(env.checkout);
      const central = remoteOver(makeInProcessWorker(workspaces));
      yield* workspaces.local.provisionWorktree({
        projectId,
        branch: "board/same-1",
        baseRefName: "main",
      });
      const byCentral = yield* Effect.flip(
        central.provisionWorktree({ projectId, branch: "board/same-1", baseRefName: "main" }),
      );
      assert.strictEqual(byCentral._tag, "BoardWorkerGitError");
      assert.include(detailOf(byCentral), "another board on this server");

      yield* central.provisionWorktree({ projectId, branch: "board/same-2", baseRefName: "main" });
      const bySelf = yield* Effect.flip(
        workspaces.local.provisionWorktree({
          projectId,
          branch: "board/same-2",
          baseRefName: "main",
        }),
      );
      assert.include(detailOf(bySelf), "another board on this server");
      // A board's own retry still reuses its checkout.
      const again = yield* central.provisionWorktree({
        projectId,
        branch: "board/same-2",
        baseRefName: "main",
      });
      const centralList = yield* central.listBoardWorktrees({ projectId });
      assert.deepStrictEqual(
        centralList.worktrees.map((worktree) => worktree.path),
        [again.path],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a checkout whose folder is gone is re-provisioned, not refused", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("gone-reprovision");
      const workspaces = yield* workspacesOver(env.checkout);
      const first = yield* workspaces.local.provisionWorktree({
        projectId,
        branch: "board/gone-1",
        baseRefName: "main",
      });
      // The folder vanishes; git still lists it, as prunable.
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.remove(first.path, { recursive: true });
      const again = yield* workspaces.local.provisionWorktree({
        projectId,
        branch: "board/gone-1",
        baseRefName: "main",
      });
      assert.isTrue(yield* fileSystem.exists(again.path));
      assert.strictEqual(again.branch, "board/gone-1");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses an operation the session has no scope for", () =>
    Effect.gen(function* () {
      const env = yield* makeEnv("scope");
      const worker = makeInProcessWorker(
        yield* workspacesOver(env.checkout),
        boardSession([AuthOrchestrationReadScope]),
      );
      const ws = remoteOver(worker);
      // A read is fine...
      const resolved = yield* ws.resolveDefaultBranch({ projectId });
      assert.strictEqual(resolved.defaultBranch, "main");
      // ...a write is not.
      const refused = yield* Effect.flip(
        ws.provisionWorktree({ projectId, branch: "board/t-1", baseRefName: "main" }),
      );
      assert.strictEqual(refused._tag, "BoardWorkerGitError");
      assert.include(detailOf(refused), "refused the board's session");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "an unreachable worker is WorkerUnavailable, and a forge call reads as unavailable",
    () =>
      Effect.gen(function* () {
        const env = yield* makeEnv("offline");
        const worker = makeInProcessWorker(yield* workspacesOver(env.checkout));
        worker.reachable = false;
        const ws = remoteOver(worker);
        const unavailable = yield* Effect.flip(ws.resolveDefaultBranch({ projectId }));
        assert.strictEqual(unavailable._tag, "WorkerUnavailable");

        const card = bindBoardWorkspace({ workspace: ws, projectId, checkoutPath: env.checkout });
        const merge = yield* Effect.flip(card.mergePullRequest({ number: 7, method: "squash" }));
        assert.strictEqual(merge._tag, "BoardWorkerGitError");
        assert.strictEqual(merge.refusal, "unavailable");
        assert.deepStrictEqual(worker.calls, []);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("a worker without the operations says it needs updating, not that it is offline", () =>
    Effect.gen(function* () {
      const ws = makeRemoteBoardWorkspace(EnvironmentId.make("env-old"), {
        get: () =>
          Effect.succeed({
            git: () => Effect.fail(new WorkerRpcError({ message: "unknown", unsupported: true })),
          } as never),
      });
      const refused = yield* Effect.flip(ws.resolveDefaultBranch({ projectId }));
      assert.strictEqual(refused._tag, "BoardWorkerGitError");
      assert.include(detailOf(refused), "too old");
    }),
  );

  it.effect("a call that will not decode is a git error, a dropped socket is an outage", () =>
    Effect.gen(function* () {
      const failingWith = (cause: unknown) =>
        makeRemoteBoardWorkspace(EnvironmentId.make("env-skewed"), {
          get: () =>
            Effect.succeed({
              git: () => Effect.fail(new WorkerRpcError({ message: "call failed", cause })),
            } as never),
        });
      const undecodable = yield* Effect.flip(
        failingWith(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: "Expected a string, got undefined",
              cause: null,
            }),
          }),
        ).resolveDefaultBranch({ projectId }),
      );
      assert.strictEqual(undecodable._tag, "BoardWorkerGitError");
      assert.include(detailOf(undecodable), "could not be used");

      const dropped = yield* Effect.flip(
        failingWith({
          _tag: "RpcClientError",
          reason: { _tag: "SocketCloseError" },
        }).resolveDefaultBranch({ projectId }),
      );
      assert.strictEqual(dropped._tag, "WorkerUnavailable");
    }),
  );
});
