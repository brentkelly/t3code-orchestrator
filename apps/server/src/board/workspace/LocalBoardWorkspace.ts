/**
 * The named board git and forge operations, run on this server: for its own
 * cards and for every `boardWorker.git.*` call a central server makes of it, so a
 * card behaves the same wherever it is placed.
 */
import {
  BOARD_UNPUSHED_COMMITS_MAX,
  BOARD_LOCAL_WORKER_ID,
  BoardWorkerGitError,
  type BoardWorkspaceDurability,
  type ProjectId,
  type WorktreeSubmodules,
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
  /** The project's `worktreeSubmodules` setting on this server (T3O-74), or
      null to defer to the checkout's t3.json. Absent reads as null. */
  readonly worktreeSubmodules?: (projectId: ProjectId) => Effect.Effect<WorktreeSubmodules | null>;
  /** Whether this server's own board has workers other than itself. Only then
      can a base move without this checkout seeing it, so only then does
      `measureBaseTip` go to the remote. Absent reads as no. */
  readonly boardHasWorkers?: Effect.Effect<boolean>;
}

/**
 * Whose board a checkout here belongs to: `self` or the `central` server that
 * dialed this one. A server can be both on one repository, so each orphan sweep
 * must see only its own board's checkouts.
 */
export type BoardWorktreeOwner = "self" | "central";

/** Kept in the private git dir, so it never dirties status and goes with the
    worktree. No marker means this server's own board. It names no central
    server: a worker serves one board, and naming the session would orphan
    every checkout on a re-pair. */
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

/** The worktree's private git dir, or null when git cannot say. */
const worktreePrivateGitDir = (git: LocalBoardWorkspaceDeps["git"], worktreePath: string) =>
  git
    .execute({
      operation: "boardCardWorktree.gitDir",
      cwd: worktreePath,
      args: ["rev-parse", "--absolute-git-dir"],
      timeoutMs: 10_000,
      allowNonZeroExit: true,
    })
    .pipe(
      Effect.map((result) => {
        const dir = result.exitCode === 0 ? result.stdout.trim() : "";
        return dir === "" ? null : dir;
      }),
      Effect.catchCause(() => Effect.succeed(null)),
    );

/**
 * Which board the checkout belongs to, or null when unreadable. Unknown is never
 * guessed: sweeps skip it, provisioning won't adopt it, and the worker refuses a
 * central server's write to it.
 */
export const boardWorktreeOwner = (
  deps: Pick<LocalBoardWorkspaceDeps, "git" | "fileSystem" | "path">,
  worktreePath: string,
) =>
  worktreePrivateGitDir(deps.git, worktreePath).pipe(
    Effect.flatMap((dir) =>
      dir === null
        ? Effect.succeed(null)
        : deps.fileSystem.exists(deps.path.join(dir, CENTRAL_OWNER_MARKER)).pipe(
            Effect.map((marked): BoardWorktreeOwner => (marked ? "central" : "self")),
            Effect.orElseSucceed(() => null),
          ),
    ),
  );

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
    deps.projectRoot(projectId).pipe(
      Effect.filterOrFail(
        (root): root is string => root !== null && root.length > 0,
        () => noCheckout(operation),
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
    git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));

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

  // The checkout's default branch: origin/HEAD, else the current branch. A
  // detached HEAD (`rev-parse` answers 'HEAD') is a failure, `defaultBranch === ""`;
  // `detachedHead` and `unbornBranch` only shape the message.
  const resolveDefaultBranch: BoardWorkspace["resolveDefaultBranch"] = Effect.fn(
    "LocalBoardWorkspace.resolveDefaultBranch",
  )(function* ({ projectId }) {
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
    // A repository with no commits yet: HEAD names a branch that does
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
          Effect.orElseSucceed(() => "main"),
        ),
      ),
      Effect.map((branch) => ({ branch })),
    );

  /**
   * Make sure `base` names a local branch, fetching and creating it from
   * `<remote>/<base>` when needed: every reader re-qualifies a recorded base as a
   * local ref and fails silently on a remote one. Idempotent; a raced creation is
   * re-checked, not fatal.
   */
  const ensureLocalBaseBranch: BoardWorkspace["ensureLocalBaseBranch"] = Effect.fn(
    "LocalBoardWorkspace.ensureLocalBaseBranch",
  )(function* ({ projectId, base }) {
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

  const privateGitDir = (worktreePath: string) => worktreePrivateGitDir(git, worktreePath);
  const ownerOf = (worktreePath: string) => boardWorktreeOwner(deps, worktreePath);

  const markCentralOwned = Effect.fn("LocalBoardWorkspace.markCentralOwned")(function* (
    worktreePath: string,
  ) {
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
   * Refuse to reuse a checkout of `branch` owned by the other board here (or of
   * unknown owner): adopting it would hand it to this board's reclaim. A
   * registration whose folder is gone holds no work and is dropped instead.
   */
  const refuseForeignCheckout = Effect.fn("LocalBoardWorkspace.refuseForeignCheckout")(function* (
    cwd: string,
    branch: string,
  ) {
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
        Effect.flatMap(deps.worktreeSubmodules?.(projectId) ?? Effect.succeed(null), (submodules) =>
          withGit(provisionBoardCardWorktree({ projectCwd, branch, baseRefName, submodules })),
        ),
      ),
      Effect.tap((worktree) =>
        owner === "central" ? markCentralOwned(worktree.path) : Effect.void,
      ),
      Effect.mapError((error) =>
        error._tag === "BoardWorkerGitError" ? error : gitFailed("provisionWorktree")(error),
      ),
    );

  /**
   * Provision a card's worktree from its branch on the REMOTE:
   * the branch is fetched and its local copy created from, or fast-forwarded
   * to, the remote one, so the worktree carries exactly what was pushed.
   * Nothing is copied worker to worker.
   */
  const provisionWorktreeFromRemoteBranch: BoardWorkspace["provisionWorktreeFromRemoteBranch"] =
    Effect.fn("LocalBoardWorkspace.provisionWorktreeFromRemoteBranch")(function* ({
      projectId,
      branch,
      baseRefName,
    }) {
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
      const remoteTip = yield* gitRef("boardCardWorktree.fromRemote.remoteRef", cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/${remoteName}/${branch}`,
      ]);
      if (local !== "" && local !== remoteTip) {
        // A local copy left by an earlier placement here is stale and replaced. It
        // counts as pushed when every commit it holds is in some tip the remote-tracking
        // ref's reflog has had, which survives a rewrite and a later fetch. Commits only
        // this copy holds are never lost.
        const seenTips = (yield* gitRef("boardCardWorktree.fromRemote.reflog", cwd, [
          "reflog",
          "show",
          "--format=%H",
          `refs/remotes/${remoteName}/${branch}`,
        ]))
          .split("\n")
          .filter((sha) => sha !== "");
        const unpushed = yield* git
          .execute({
            operation: "boardCardWorktree.fromRemote.unpushed",
            cwd,
            args: [
              "rev-list",
              "--max-count=1",
              local,
              "--not",
              ...new Set([remoteTip, ...seenTips].filter((sha) => sha !== "")),
            ],
            timeoutMs: 10_000,
          })
          .pipe(Effect.mapError(gitFailed(operation)));
        const pushed = unpushed.stdout.trim() === "";
        if (!pushed) {
          return yield* new BoardWorkerGitError({
            operation,
            detail: `This checkout's '${branch}' has commits ${remoteName} does not. Push or delete them here, then retry.`,
          });
        }
      }
      if (local !== remoteTip) {
        yield* git
          .execute({
            operation: "boardCardWorktree.fromRemote.branch",
            cwd,
            args: ["branch", "--force", "--track", branch, `${remoteName}/${branch}`],
            timeoutMs: 10_000,
          })
          .pipe(Effect.mapError(gitFailed(operation)));
      }
      return yield* provisionWorktree({ projectId, branch, baseRefName });
    });

  const pinGhDefault: BoardWorkspace["pinGhDefault"] = ({ worktreePath }) =>
    withGit(pinBoardWorktreeGhDefault(worktreePath));

  /** The latest commit time (strict ISO 8601) of a commit unique to the
      card's OWN branch, or null on any error or no such commit.
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
   * Whether `measureBaseTip` reads the remote: always for a central board
   * this server works for, since it has at least this worker; for this
   * server's own board, only once it has workers.
   */
  const baseTipFromRemote =
    owner === "central" ? Effect.succeed(true) : (deps.boardHasWorkers ?? Effect.succeed(false));

  /**
   * The base branch's tip, in the project root (never the card's worktree); null
   * when unknown. With workers it is the remote's, fetched first, so another
   * worker's merge counts; without, the local branch, since its recorded tips are
   * local. Never cached: the merge gate must see a sibling's merge a moment ago.
   */
  const measureBaseTip: BoardWorkspace["measureBaseTip"] = Effect.fn(
    "LocalBoardWorkspace.measureBaseTip",
  )(function* ({ projectId, baseRefName }) {
    const cwd = yield* deps.projectRoot(projectId);
    if (cwd === null) return { tip: null };
    const remoteName = (yield* baseTipFromRemote) ? yield* primaryRemote(cwd) : null;
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
   * Cut a split parent's integration branch from `base` and push it, so
   * a child placed on another worker can cut its own branch from the remote.
   * Idempotent on retry: an existing branch is the desired state, and a raced
   * sibling's creation is re-checked rather than treated as fatal.
   */
  const createIntegrationBranch: BoardWorkspace["createIntegrationBranch"] = Effect.fn(
    "LocalBoardWorkspace.createIntegrationBranch",
  )(function* ({ projectId, branch, base }) {
    const cwd = yield* rootOf("createIntegrationBranch", projectId);
    const exists = () =>
      gitRef("boardIntegrationBranch.ref", cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]).pipe(Effect.map((sha) => sha !== ""));
    if (!(yield* exists())) {
      // Cut from the REMOTE tip of the level above: on a nested
      // group that is the outer integration branch, which another worker's
      // merges may have moved without this checkout seeing it.
      const remoteName = yield* primaryRemote(cwd);
      const remoteBase =
        remoteName === null
          ? null
          : yield* fetchRemoteBranch(
              "boardIntegrationBranch.fetchBase",
              cwd,
              remoteName,
              base,
            ).pipe(
              // A failed fetch leaves a possibly stale remote-tracking ref; cut from the local base.
              Effect.flatMap((fetched) =>
                fetched
                  ? gitRef("boardIntegrationBranch.remoteBase", cwd, [
                      "rev-parse",
                      "--verify",
                      "--quiet",
                      `refs/remotes/${remoteName}/${base}`,
                    ])
                  : Effect.succeed(""),
              ),
              Effect.map((sha) => (sha === "" ? null : `${remoteName}/${base}`)),
            );
      const created = yield* git
        .execute({
          operation: "boardIntegrationBranch.create",
          cwd,
          // --no-track: a remote start point would otherwise make the base this branch's upstream.
          args: ["branch", "--no-track", branch, remoteBase ?? base],
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
      Effect.orElseSucceed(() => false),
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
  const pushState = Effect.fn("LocalBoardWorkspace.pushState")(function* (worktreePath: string) {
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
    const unpushedCount = Number(count) || 0;
    const listed =
      unpushedCount === 0
        ? ""
        : yield* gitRef(
            "boardCardWorktree.durable.unpushedLog",
            worktreePath,
            hasUpstream
              ? ["log", `-n${BOARD_UNPUSHED_COMMITS_MAX}`, "--format=%h%x09%s", "@{upstream}..HEAD"]
              : [
                  "log",
                  `-n${BOARD_UNPUSHED_COMMITS_MAX}`,
                  "--format=%h%x09%s",
                  "HEAD",
                  "--not",
                  "--remotes",
                ],
          );
    const unpushedCommits = listed
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const tab = line.indexOf("\t");
        return tab < 0
          ? { sha: line, subject: "" }
          : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
    return { hasUpstream, unpushedCount, unpushedCommits };
  });

  const probeWorktreeDurability: BoardWorkspace["probeWorktreeDurability"] = Effect.fn(
    "LocalBoardWorkspace.probeWorktreeDurability",
  )(function* (input) {
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
   * The orphan sweep's candidates: the project's `board/*` worktrees under this
   * server's worktrees directory, never another environment's or the other
   * board's here. The first block is the checkout itself.
   */
  const listBoardWorktrees: BoardWorkspace["listBoardWorktrees"] = Effect.fn(
    "LocalBoardWorkspace.listBoardWorktrees",
  )(function* ({ projectId }) {
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
      .pipe(Effect.orElseSucceed(() => null));
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
  const gitUserName: BoardWorkspace["gitUserName"] = Effect.fn("LocalBoardWorkspace.gitUserName")(
    function* ({ projectId }) {
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
    },
  );

  /** The branch's tip on the remote, freshly fetched; null when the remote
      does not have it, or there is no remote. A remote that can't be asked
      fails instead: "not there" offers a restart from base, which
      forgets pushed work, so it must not be guessed from a network error. */
  const remoteBranchTip: BoardWorkspace["remoteBranchTip"] = Effect.fn(
    "LocalBoardWorkspace.remoteBranchTip",
  )(function* ({ projectId, branch }) {
    const cwd = yield* rootOf("remoteBranchTip", projectId);
    const remoteName = yield* primaryRemote(cwd);
    if (remoteName === null) return null;
    const unreachable = new BoardWorkerGitError({
      operation: "remoteBranchTip",
      detail: `The remote ${remoteName} couldn't be reached.`,
    });
    const listed = yield* git
      .execute({
        operation: "boardRemoteBranchTip.lsRemote",
        cwd,
        args: ["ls-remote", "--heads", remoteName, `refs/heads/${branch}`],
        timeoutMs: 60_000,
        allowNonZeroExit: true,
      })
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (listed === null || listed.exitCode !== 0) return yield* unreachable;
    if (listed.stdout.trim().length === 0) return null;
    if (!(yield* fetchRemoteBranch("boardRemoteBranchTip.fetch", cwd, remoteName, branch))) {
      return yield* unreachable;
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
    closePullRequest: ({ projectId, number }) =>
      pullRequests.close({ projectId, number }).pipe(Effect.mapError(forgeFailed("close"))),
    pullRequestRepository: ({ projectId }) =>
      pullRequests.repository(projectId).pipe(Effect.mapError(forgeFailed("repository"))),
    reclaimWorktree,
  };
}
