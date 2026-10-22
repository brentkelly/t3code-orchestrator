/**
 * T3o (T3O-64, D21): the named board git and forge operations, run on THIS
 * server.
 *
 * The central server's own cards run here, and so does every
 * `boardWorker.git.*` call a central server makes of this server as its
 * worker (`workerGitRpc.ts`): one implementation, so a card behaves the same
 * wherever it is placed.
 *
 * Each operation resolves its project id to this server's checkout. The
 * bodies are the board's git code as it was — moved here from the supervisor
 * reactor, `worktree.ts` and the leaf helpers — with two changes for more than
 * one worker: `measureBaseTip` fetches and reads the remote base, and
 * `ensureLocalBaseBranch` fetches a base this checkout has never seen.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardWorkerGitError,
  type BoardWorkspaceDurability,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import type {
  BoardPullRequestGateway,
  BoardPullRequestGatewayError,
} from "../BoardPullRequestGateway.ts";
import { pullMergedBaseBranch } from "../baseBranchSync.ts";
import { deleteCardBranch } from "../branchCleanup.ts";
import { probeLocalMergeConflict } from "../localMergeConflict.ts";
import {
  goneBoardWorktreePath,
  parseRegisteredWorktrees,
  pinBoardWorktreeGhDefault,
  probeBoardWorktreeDurability,
  provisionBoardCardWorktree,
  reclaimBoardCardWorktree,
} from "../worktree.ts";
import { WorktreeRetirer } from "../worktreeRetire.ts";
import type { BoardWorkspace } from "./BoardWorkspace.ts";

export interface LocalBoardWorkspaceDeps {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly pullRequests: BoardPullRequestGateway["Service"];
  readonly retirer: WorktreeRetirer["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  /** The project's checkout on this server, or null when it has none. */
  readonly projectRoot: (projectId: ProjectId) => Effect.Effect<string | null>;
  /** This server's worktrees directory, as spelled and as resolved through
      symlinks; empty when there is none to sweep (a test without a config). */
  readonly worktreeRoots: Effect.Effect<ReadonlyArray<string>>;
}

/**
 * Whose board a checkout under this server's worktrees directory belongs to.
 * `self` is this server's own board; `central` is the central server that
 * dialed this one as its worker (`workerGitRpc.ts`). A server can be both, on
 * the same repository, so each orphan sweep must see only its own board's
 * checkouts — the other board's cards are unknown to it, and every one of its
 * clean, pushed checkouts would look like an orphan.
 */
export type BoardWorktreeOwner = "self" | "central";

/** The marker a central board's checkout carries, in its private git dir
    (`.git/worktrees/<name>/`): out of the working tree, so it never dirties
    status, and removed with the worktree. A checkout without one is this
    server's own board's, as every checkout before the marker was. It names no
    central server: a worker serves one board (D19), and the central's session
    on it changes on every re-pair, so tying the marker to it would orphan
    every checkout a re-paired board had made. */
const CENTRAL_OWNER_MARKER = "t3o-board-owner";

/** How long a staleness check waits on the remote before reading what it has. */
const BASE_TIP_FETCH_TIMEOUT_MS = 15_000;

const noCheckout = (operation: string) =>
  new BoardWorkerGitError({
    operation,
    detail: "The card's project has no workspace folder on this server.",
  });

const gitFailed = (operation: string) => (error: { readonly message: string }) =>
  new BoardWorkerGitError({ operation, detail: error.message });

const forgeFailed = (operation: string) => (error: BoardPullRequestGatewayError) =>
  new BoardWorkerGitError({
    operation,
    detail: error.detail,
    ...(error.refusal === undefined ? {} : { refusal: error.refusal }),
  });

export function makeLocalBoardWorkspace(
  deps: LocalBoardWorkspaceDeps,
  owner: BoardWorktreeOwner = "self",
): BoardWorkspace {
  const { git, pullRequests, retirer, fileSystem, path: pathService } = deps;

  const withGit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, git),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(WorktreeRetirer, retirer),
    );

  /** The project's checkout, or the operation fails naming why. */
  const rootOf = (operation: string, projectId: ProjectId) =>
    deps
      .projectRoot(projectId)
      .pipe(
        Effect.flatMap((root) =>
          root === null || root.length === 0
            ? Effect.fail(noCheckout(operation))
            : Effect.succeed(root),
        ),
      );

  /** A ref read that answers "" for anything but a clean exit. */
  const gitRef = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args: [...args], timeoutMs: 10_000, allowNonZeroExit: true })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
        Effect.catchCause(() => Effect.succeed("")),
      );

  const primaryRemote = (cwd: string) =>
    git.resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null)));

  /** Fetch one remote branch into its remote-tracking ref; whether it worked. */
  const fetchRemoteBranch = (
    operation: string,
    cwd: string,
    remote: string,
    branch: string,
    timeoutMs = 60_000,
  ) =>
    git
      .execute({
        operation,
        cwd,
        args: [
          "fetch",
          "--no-tags",
          remote,
          `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
        ],
        timeoutMs,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.exitCode === 0),
        Effect.catchCause(() => Effect.succeed(false)),
      );

  // The checkout's DEFAULT branch — not whatever it happens to have checked
  // out. origin/HEAD names it when a remote exists; a purely local repo falls
  // back to the current branch, with a detached HEAD (`rev-parse` answers the
  // literal string 'HEAD') treated as a resolution failure rather than a
  // branch. `defaultBranch === ""` is the failure signal, `detachedHead` and
  // `unbornBranch` (a repository with no commits) disambiguate the message.
  const resolveDefaultBranch: BoardWorkspace["resolveDefaultBranch"] = ({ projectId }) =>
    Effect.gen(function* () {
      const cwd = yield* rootOf("resolveDefaultBranch", projectId);
      const ref = (args: ReadonlyArray<string>) =>
        gitRef("boardCardWorktree.defaultBranch", cwd, args);
      const originHead = yield* ref([
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      const currentBranch = yield* ref(["rev-parse", "--abbrev-ref", "HEAD"]);
      const defaultBranch =
        originHead.startsWith("origin/") && originHead.length > "origin/".length
          ? originHead.slice("origin/".length)
          : currentBranch === "HEAD"
            ? ""
            : currentBranch;
      // A repository with no commits yet (T3O-15): HEAD names a branch that does
      // not exist, so `rev-parse` answers nothing while `symbolic-ref` still does.
      // Only read on failure — it shapes the message, not the resolution.
      const unbornBranch =
        defaultBranch === "" && currentBranch === ""
          ? yield* ref(["symbolic-ref", "--quiet", "--short", "HEAD"])
          : "";
      return {
        defaultBranch,
        detachedHead: currentBranch === "HEAD",
        unbornBranch,
        checkoutPath: cwd,
      };
    });

  /** The remote's default branch, for an orphan worktree with no card to name
      its base; `main` when the remote cannot say. */
  const remoteDefaultBranch: BoardWorkspace["remoteDefaultBranch"] = ({ projectId }) =>
    rootOf("remoteDefaultBranch", projectId).pipe(
      Effect.flatMap((cwd) =>
        git.resolvePrimaryRemoteName(cwd).pipe(
          Effect.flatMap((remote) => git.resolveDefaultBranchName(cwd, remote)),
          Effect.map((name) => name ?? "main"),
          Effect.catch(() => Effect.succeed("main")),
        ),
      ),
      Effect.map((branch) => ({ branch })),
    );

  /**
   * Make sure `base` names a LOCAL branch (T3O-5, D7), creating it from
   * `<remote>/<base>` when it exists only on the remote. Answers whether the
   * caller may go on to cut from it.
   *
   * Every reader of a recorded base re-qualifies it as a local ref, and each
   * fails silently on a remote-qualified one, so the base is materialised once
   * here. A base this checkout has never fetched — a split parent's
   * integration branch cut and pushed on another worker (D12) — is fetched
   * first. Idempotent: a base that already exists locally is the desired
   * state, and a raced creation is re-checked rather than treated as fatal.
   */
  const ensureLocalBaseBranch: BoardWorkspace["ensureLocalBaseBranch"] = ({ projectId, base }) =>
    Effect.gen(function* () {
      const cwd = yield* rootOf("ensureLocalBaseBranch", projectId);
      const ref = (args: ReadonlyArray<string>) => gitRef("boardCardWorktree.baseRef", cwd, args);
      // Thunks, not effect values: each check is a fresh read of the ref.
      const localExists = () =>
        ref(["rev-parse", "--verify", "--quiet", `refs/heads/${base}`]).pipe(
          Effect.map((sha) => sha !== ""),
        );
      if (yield* localExists()) return { exists: true };
      const remoteName = yield* primaryRemote(cwd);
      if (remoteName === null) return { exists: false };
      const remoteExists = () =>
        ref(["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteName}/${base}`]).pipe(
          Effect.map((sha) => sha !== ""),
        );
      if (!(yield* remoteExists())) {
        yield* fetchRemoteBranch("boardCardWorktree.baseRef.fetch", cwd, remoteName, base);
        if (!(yield* remoteExists())) return { exists: false };
      }
      yield* ref(["branch", base, `${remoteName}/${base}`]);
      return { exists: yield* localExists() };
    });

  /** The worktree's private git dir, or null when git cannot say. */
  const privateGitDir = (worktreePath: string) =>
    gitRef("boardCardWorktree.gitDir", worktreePath, ["rev-parse", "--absolute-git-dir"]).pipe(
      Effect.map((dir) => (dir === "" ? null : dir)),
    );

  /**
   * Which board the checkout belongs to, or null when that cannot be read.
   * Unknown is never guessed as either: both orphan sweeps skip it and a
   * provision will not adopt it, so a failed read can't hand one board's
   * checkout to the other's reclaim.
   */
  const ownerOf = (worktreePath: string) =>
    privateGitDir(worktreePath).pipe(
      Effect.flatMap((dir) =>
        dir === null
          ? Effect.succeed(null)
          : fileSystem.exists(pathService.join(dir, CENTRAL_OWNER_MARKER)).pipe(
              Effect.map((marked): BoardWorktreeOwner => (marked ? "central" : "self")),
              Effect.orElseSucceed(() => null),
            ),
      ),
    );

  const markCentralOwned = (worktreePath: string) =>
    Effect.gen(function* () {
      const dir = yield* privateGitDir(worktreePath);
      if (dir === null) {
        return yield* new BoardWorkerGitError({
          operation: "provisionWorktree",
          detail: `${worktreePath} has no git directory to mark as the board's.`,
        });
      }
      yield* fileSystem
        .writeFileString(pathService.join(dir, CENTRAL_OWNER_MARKER), "central\n")
        .pipe(
          Effect.mapError(
            (error) =>
              new BoardWorkerGitError({ operation: "provisionWorktree", detail: error.message }),
          ),
        );
    });

  /**
   * Refuse to reuse a checkout of `branch` that belongs to the other board on
   * this server (or whose owner cannot be read): both boards cut `board/<key>`
   * branches, and adopting the other's checkout would hand it to this board's
   * reclaim.
   *
   * A registration whose folder is gone has no owner to read and holds no
   * work, so it is dropped instead: provisioning then attaches a fresh
   * checkout to the branch, rather than refusing every retry.
   */
  const refuseForeignCheckout = (cwd: string, branch: string) =>
    Effect.gen(function* () {
      const listed = yield* gitRef("boardCardWorktree.owner.list", cwd, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      const existing = parseRegisteredWorktrees(listed).find((entry) => entry.branch === branch);
      if (existing === undefined) return;
      if (existing.prunable) {
        return yield* git
          .removeWorktree({ cwd, path: existing.path, force: true })
          .pipe(Effect.mapError(gitFailed("provisionWorktree")));
      }
      const existingOwner = yield* ownerOf(existing.path);
      if (existingOwner === owner) return;
      return yield* new BoardWorkerGitError({
        operation: "provisionWorktree",
        detail:
          existingOwner === null
            ? `'${branch}' is already checked out at ${existing.path}, and git cannot say which board owns it.`
            : `'${branch}' is already checked out at ${existing.path} by another board on this server.`,
      });
    });

  const provisionWorktree: BoardWorkspace["provisionWorktree"] = ({
    projectId,
    branch,
    baseRefName,
  }) =>
    rootOf("provisionWorktree", projectId).pipe(
      Effect.tap((projectCwd) => refuseForeignCheckout(projectCwd, branch)),
      Effect.flatMap((projectCwd) =>
        withGit(provisionBoardCardWorktree({ projectCwd, branch, baseRefName })),
      ),
      Effect.tap((worktree) =>
        owner === "central" ? markCentralOwned(worktree.path) : Effect.void,
      ),
      Effect.mapError((error) =>
        error._tag === "BoardWorkerGitError" ? error : gitFailed("provisionWorktree")(error),
      ),
    );

  /**
   * Provision a card's worktree from its branch on the REMOTE (T3O-65's move):
   * the branch is fetched and, when this checkout has no local copy of it,
   * created from the remote one, so the worktree carries exactly what was
   * pushed. Nothing is copied worker to worker (D21).
   */
  const provisionWorktreeFromRemoteBranch: BoardWorkspace["provisionWorktreeFromRemoteBranch"] = ({
    projectId,
    branch,
    baseRefName,
  }) =>
    Effect.gen(function* () {
      const operation = "provisionWorktreeFromRemoteBranch";
      const cwd = yield* rootOf(operation, projectId);
      const remoteName = yield* primaryRemote(cwd);
      if (remoteName === null) {
        return yield* new BoardWorkerGitError({
          operation,
          detail: `${cwd} has no remote to fetch '${branch}' from.`,
        });
      }
      const fetched = yield* fetchRemoteBranch(
        "boardCardWorktree.fromRemote.fetch",
        cwd,
        remoteName,
        branch,
      );
      if (!fetched) {
        return yield* new BoardWorkerGitError({
          operation,
          detail: `The branch '${branch}' could not be fetched from ${remoteName}.`,
        });
      }
      const local = yield* gitRef("boardCardWorktree.fromRemote.ref", cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      if (local === "") {
        yield* git
          .execute({
            operation: "boardCardWorktree.fromRemote.branch",
            cwd,
            args: ["branch", "--track", branch, `${remoteName}/${branch}`],
            timeoutMs: 10_000,
          })
          .pipe(Effect.mapError(gitFailed(operation)));
      }
      return yield* provisionWorktree({ projectId, branch, baseRefName });
    });

  const pinGhDefault: BoardWorkspace["pinGhDefault"] = ({ worktreePath }) =>
    withGit(pinBoardWorktreeGhDefault(worktreePath));

  /** The latest commit time (strict ISO 8601) of a commit unique to the
      card's OWN branch, or null on any error or no such commit (t3o-10, D4).
      Scoped with `--not <base>` so a base sync fast-forwarding a sibling's
      merge into the branch is not read as this agent's heartbeat. */
  const branchHeartbeat: BoardWorkspace["branchHeartbeat"] = ({ worktreePath, baseRefName }) =>
    git
      .execute({
        operation: "boardSupervisor.progressCommit",
        cwd: worktreePath,
        args: ["log", "-1", "--format=%cI", "HEAD", "--not", `refs/heads/${baseRefName}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result): string | null => {
          const iso = result.stdout.trim();
          return iso.length > 0 ? iso : null;
        }),
        Effect.catchCause(() => Effect.succeed(null as string | null)),
        Effect.map((committedAt) => ({ committedAt })),
      );

  /**
   * The base branch's tip as the REMOTE has it (t3o-24, D1; D21). Measured in
   * the project root, never the card's worktree, whose HEAD is the card's
   * branch. The base is fetched first, so a merge landed from another worker
   * counts as movement here without anything pulling it locally. A checkout
   * with no remote, or a base the remote does not have, reads its local
   * branch as it always did. Null is the honest failure signal: staleness is
   * measured, never assumed.
   *
   * Never cached: it answers the merge gate, where a sibling's merge a moment
   * ago is exactly what it must see. The reactor only asks for a sub-board
   * child or a retargeted card, at a stage plan or a merge crossing, so the
   * fetch is bounded by `BASE_TIP_FETCH_TIMEOUT_MS` rather than deduplicated;
   * a fetch that times out reads the last-fetched remote ref.
   */
  const measureBaseTip: BoardWorkspace["measureBaseTip"] = ({ projectId, baseRefName }) =>
    Effect.gen(function* () {
      const cwd = yield* deps.projectRoot(projectId);
      if (cwd === null) return { tip: null };
      const remoteName = yield* primaryRemote(cwd);
      if (remoteName !== null) {
        yield* fetchRemoteBranch(
          "boardBaseTip.fetch",
          cwd,
          remoteName,
          baseRefName,
          BASE_TIP_FETCH_TIMEOUT_MS,
        );
        const remoteTip = yield* gitRef("boardBaseTip.resolve", cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/${remoteName}/${baseRefName}`,
        ]);
        if (remoteTip.length > 0) return { tip: remoteTip };
      }
      const tip = yield* gitRef("boardBaseTip.resolve", cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${baseRefName}`,
      ]);
      return { tip: tip.length > 0 ? tip : null };
    });

  /**
   * Cut a split parent's integration branch from `base` and push it (D12), so
   * a child placed on another worker can cut its own branch from the remote.
   * Idempotent on retry: an existing branch is the desired state, and a raced
   * sibling's creation is re-checked rather than treated as fatal.
   */
  const createIntegrationBranch: BoardWorkspace["createIntegrationBranch"] = ({
    projectId,
    branch,
    base,
  }) =>
    Effect.gen(function* () {
      const cwd = yield* rootOf("createIntegrationBranch", projectId);
      const exists = () =>
        gitRef("boardIntegrationBranch.ref", cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]).pipe(Effect.map((sha) => sha !== ""));
      if (!(yield* exists())) {
        const created = yield* git
          .execute({
            operation: "boardIntegrationBranch.create",
            cwd,
            args: ["branch", branch, base],
            timeoutMs: 10_000,
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("board workspace: integration branch creation failed", {
                branch,
                cause: String(cause),
              }).pipe(Effect.as(null)),
            ),
          );
        if ((created === null || created.exitCode !== 0) && !(yield* exists())) {
          return { outcome: "create-failed" as const };
        }
      }
      const pushed = yield* git.resolvePrimaryRemoteName(cwd).pipe(
        Effect.flatMap((remoteName) =>
          git.execute({
            operation: "boardIntegrationBranch.push",
            cwd,
            args: ["push", remoteName, branch],
            timeoutMs: 60_000,
            allowNonZeroExit: true,
          }),
        ),
        Effect.map((result) => result.exitCode === 0),
        Effect.catch(() => Effect.succeed(false)),
      );
      return { outcome: "ready" as const, pushed };
    });

  const probeMergeConflict: BoardWorkspace["probeLocalMergeConflict"] = ({
    projectId,
    headBranch,
    baseBranch,
  }) =>
    rootOf("probeLocalMergeConflict", projectId).pipe(
      Effect.flatMap((cwd) => probeLocalMergeConflict({ git, cwd, headBranch, baseBranch })),
      Effect.map((result) => ({ result })),
    );

  const pullMergedBase: BoardWorkspace["pullMergedBaseBranch"] = ({ projectId, baseBranch }) =>
    rootOf("pullMergedBaseBranch", projectId).pipe(
      Effect.flatMap((cwd) => pullMergedBaseBranch({ git, cwd, baseBranch })),
    );

  /** Upstream and unpushed commits — the detail a move refusal shows. */
  const pushState = (worktreePath: string) =>
    Effect.gen(function* () {
      const upstream = yield* gitRef("boardCardWorktree.durable.upstream", worktreePath, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]);
      const hasUpstream = upstream.length > 0;
      const count = yield* gitRef(
        "boardCardWorktree.durable.unpushed",
        worktreePath,
        hasUpstream
          ? ["rev-list", "--count", "@{upstream}..HEAD"]
          : ["rev-list", "--count", "HEAD", "--not", "--remotes"],
      );
      return { hasUpstream, unpushedCount: Number(count) || 0 };
    });

  const probeWorktreeDurability: BoardWorkspace["probeWorktreeDurability"] = (input) =>
    Effect.gen(function* () {
      const projectCwd = yield* rootOf("probeWorktreeDurability", input.projectId);
      // The probe's own per-pass cache, keyed as it keys it.
      const remoteName = yield* primaryRemote(projectCwd);
      const base =
        remoteName !== null && input.baseRefName.startsWith(`${remoteName}/`)
          ? input.baseRefName.slice(remoteName.length + 1)
          : input.baseRefName;
      const fetchKey = `${projectCwd}\0${base}`;
      const fetchedBases = new Set<string>(input.baseAlreadyFetched ? [fetchKey] : []);
      const facts = yield* withGit(
        probeBoardWorktreeDurability({
          projectCwd,
          worktreePath: input.worktreePath,
          baseRefName: input.baseRefName,
          branch: input.branch,
          mergedPullRequestNumbers: input.mergedPullRequestNumbers,
          openPullRequestNumber: input.openPullRequestNumber,
          fetchedBases,
        }),
      ).pipe(Effect.mapError(gitFailed("probeWorktreeDurability")));
      const push = yield* pushState(input.worktreePath);
      return {
        hasWorkingTreeChanges: facts.hasWorkingTreeChanges,
        changedPaths: facts.changedPaths,
        openPullRequestNumber: facts.openPullRequestNumber,
        durable: facts.durable,
        unmergedCount: facts.unmergedCount,
        ...push,
        baseFetched: !input.baseAlreadyFetched && fetchedBases.has(fetchKey),
      } satisfies BoardWorkspaceDurability;
    });

  const goneWorktreePath: BoardWorkspace["goneWorktreePath"] = ({
    projectId,
    worktreePath,
    branch,
  }) =>
    rootOf("goneWorktreePath", projectId).pipe(
      Effect.flatMap((projectCwd) =>
        withGit(
          goneBoardWorktreePath({
            projectCwd,
            worktreePath,
            baseRefName: branch,
            branch,
            mergedPullRequestNumbers: [],
          }),
        ),
      ),
      Effect.map((gone) => ({ path: gone })),
    );

  /** Drop the registration of a checkout whose folder is gone. The driver
      treats one git no longer lists as done. */
  const pruneWorktree: BoardWorkspace["pruneWorktree"] = ({ projectId, worktreePath }) =>
    rootOf("pruneWorktree", projectId).pipe(
      Effect.flatMap((cwd) =>
        git
          .removeWorktree({ cwd, path: worktreePath, force: true })
          .pipe(Effect.mapError(gitFailed("pruneWorktree"))),
      ),
    );

  const retireWorktree: BoardWorkspace["retireWorktree"] = ({
    projectId,
    worktreePath,
    kind,
    verifiedClean,
  }) =>
    rootOf("retireWorktree", projectId).pipe(
      Effect.flatMap((projectCwd) =>
        retirer
          .retire({ projectCwd, projectId, worktreePath, kind, verifiedClean })
          .pipe(Effect.mapError(gitFailed("retireWorktree"))),
      ),
    );

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = pathService.relative(root, candidate);
    return relative !== "" && !relative.startsWith("..") && !pathService.isAbsolute(relative);
  };

  /**
   * The `board/*` worktrees of the project registered under THIS server's
   * worktrees directory (T3O-52, D4) — the orphan sweep's candidates. Another
   * T3 environment on the same repository has its own board, and its
   * checkouts are none of ours; nor, on a worker, are the checkouts of the
   * other board sharing this directory (`BoardWorktreeOwner`). The first block
   * is the repository's own checkout, and a prunable one is already gone.
   */
  const listBoardWorktrees: BoardWorkspace["listBoardWorktrees"] = ({ projectId }) =>
    Effect.gen(function* () {
      const roots = yield* deps.worktreeRoots;
      if (roots.length === 0) return { worktrees: [] };
      const cwd = yield* rootOf("listBoardWorktrees", projectId);
      const listed = yield* git
        .execute({
          operation: "board.sweep.worktrees",
          cwd,
          args: ["worktree", "list", "--porcelain"],
          allowNonZeroExit: true,
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (listed === null || listed.exitCode !== 0) return { worktrees: [] };
      const worktrees: Array<{ path: string; branch: string }> = [];
      for (const registered of parseRegisteredWorktrees(listed.stdout).slice(1)) {
        if (registered.branch === null || !registered.branch.startsWith("board/")) continue;
        if (registered.prunable) continue;
        const resolved = pathService.resolve(registered.path);
        if (!roots.some((root) => isWithinRoot(resolved, root))) continue;
        if ((yield* ownerOf(registered.path)) !== owner) continue;
        worktrees.push({ path: registered.path, branch: registered.branch });
      }
      return { worktrees };
    });

  const deleteBranch: BoardWorkspace["deleteCardBranch"] = ({ projectId, branch }) =>
    rootOf("deleteCardBranch", projectId).pipe(
      Effect.flatMap((cwd) => deleteCardBranch({ git, cwd, branch })),
    );

  /** `user.name` of the checkout, or "" when it has none. */
  const gitUserName: BoardWorkspace["gitUserName"] = ({ projectId }) =>
    Effect.gen(function* () {
      const cwd = yield* deps.projectRoot(projectId);
      if (cwd === null || cwd.length === 0) return { name: "" };
      const name = yield* git
        .execute({
          operation: "board.activityActor.userName",
          cwd,
          args: ["config", "user.name"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.catchCause(() => Effect.succeed("")),
        );
      return { name };
    });

  /** The branch's tip on the remote, freshly fetched; null when the remote
      does not have it (or cannot be reached). */
  const remoteBranchTip: BoardWorkspace["remoteBranchTip"] = ({ projectId, branch }) =>
    Effect.gen(function* () {
      const cwd = yield* rootOf("remoteBranchTip", projectId);
      const remoteName = yield* primaryRemote(cwd);
      if (remoteName === null) return null;
      if (!(yield* fetchRemoteBranch("boardRemoteBranchTip.fetch", cwd, remoteName, branch))) {
        return null;
      }
      const line = yield* gitRef("boardRemoteBranchTip.log", cwd, [
        "log",
        "-1",
        "--format=%H%x00%s%x00%cI%x00%an",
        `refs/remotes/${remoteName}/${branch}`,
      ]);
      const [sha, subject, committedAt, author] = line.split("\0");
      if (sha === undefined || sha.length === 0) return null;
      return {
        sha,
        subject: subject ?? "",
        committedAt: committedAt ?? "",
        author: author ?? "",
      };
    });

  const pullRequestByBranch: BoardWorkspace["pullRequestByBranch"] = ({
    projectId,
    branch,
    worktreePath,
    force,
  }) =>
    (worktreePath === null
      ? rootOf("pullRequestByBranch", projectId)
      : Effect.succeed(worktreePath)
    ).pipe(
      Effect.flatMap((cwd) =>
        pullRequests
          .find({ cwd, branch, ...(force ? { force: true } : {}) })
          .pipe(Effect.mapError(forgeFailed("find"))),
      ),
    );

  const reclaimWorktree: BoardWorkspace["reclaimWorktree"] = (input, stillWanted) =>
    rootOf("reclaimWorktree", input.projectId).pipe(
      Effect.flatMap((projectCwd) =>
        withGit(
          reclaimBoardCardWorktree(
            {
              projectCwd,
              worktreePath: input.worktreePath,
              baseRefName: input.baseRefName,
              branch: input.branch,
              mergedPullRequestNumbers: input.mergedPullRequestNumbers,
              openPullRequestNumber: input.openPullRequestNumber,
              fetchedBases: input.fetchedBases,
            },
            stillWanted,
          ),
        ).pipe(Effect.mapError(gitFailed("reclaimWorktree"))),
      ),
    );

  return {
    workerId: BOARD_LOCAL_WORKER_ID,
    resolveDefaultBranch,
    remoteDefaultBranch,
    ensureLocalBaseBranch,
    provisionWorktree,
    provisionWorktreeFromRemoteBranch,
    pinGhDefault,
    branchHeartbeat,
    measureBaseTip,
    createIntegrationBranch,
    probeLocalMergeConflict: probeMergeConflict,
    pullMergedBaseBranch: pullMergedBase,
    probeWorktreeDurability,
    goneWorktreePath,
    pruneWorktree,
    retireWorktree,
    listBoardWorktrees,
    deleteCardBranch: deleteBranch,
    gitUserName,
    remoteBranchTip,
    pullRequestByBranch,
    getPullRequest: ({ projectId, number, force }) =>
      pullRequests
        .get({ projectId, number, ...(force ? { force: true } : {}) })
        .pipe(Effect.mapError(forgeFailed("get"))),
    mergePullRequest: ({ projectId, number, method }) =>
      pullRequests.merge({ projectId, number, method }).pipe(Effect.mapError(forgeFailed("merge"))),
    pullRequestMergeState: ({ projectId, number }) =>
      pullRequests
        .mergeState({ projectId, number })
        .pipe(Effect.mapError(forgeFailed("mergeState"))),
    markPullRequestReady: ({ projectId, number }) =>
      pullRequests.markReady({ projectId, number }).pipe(Effect.mapError(forgeFailed("markReady"))),
    pullRequestRepository: ({ projectId }) =>
      pullRequests.repository(projectId).pipe(Effect.mapError(forgeFailed("repository"))),
    reclaimWorktree,
  };
}
