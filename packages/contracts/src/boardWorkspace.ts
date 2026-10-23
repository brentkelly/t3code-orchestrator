/**
 * T3o distributed board: the named git and forge operations a central server
 * runs on a card's worker (T3O-64, overview D21).
 *
 * Remote callers never get raw `git`: each operation here has typed inputs, a
 * bounded effect and a test. Every payload names the WORKER's project id, and
 * the worker resolves it to its own checkout — a path the central server sends
 * is only ever a worktree of that checkout, which the worker checks.
 *
 * The same shapes back `BoardWorkspace` on the server, so the local and the
 * remote implementation answer in one vocabulary.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsStatusChangeRequest } from "./git.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";

// ── Results ────────────────────────────────────────────────────────────

/** The checkout's default branch; `defaultBranch === ""` is the failure
    signal, and the other two fields say which way it failed. */
export const BoardWorkspaceDefaultBranch = Schema.Struct({
  defaultBranch: Schema.String,
  detachedHead: Schema.Boolean,
  unbornBranch: Schema.String,
  /** The checkout's path on its worker, for messages that name it. */
  checkoutPath: Schema.String,
});
export type BoardWorkspaceDefaultBranch = typeof BoardWorkspaceDefaultBranch.Type;

export const BoardWorkspaceProvisionedWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
});
export type BoardWorkspaceProvisionedWorktree = typeof BoardWorkspaceProvisionedWorktree.Type;

/** Cutting a split parent's integration branch (D12). `create-failed` is git
    itself failing on a repository that is otherwise fine. */
export const BoardWorkspaceIntegrationBranch = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("ready"), pushed: Schema.Boolean }),
  Schema.Struct({ outcome: Schema.Literal("create-failed") }),
]);
export type BoardWorkspaceIntegrationBranch = typeof BoardWorkspaceIntegrationBranch.Type;

/**
 * What the durability probe found (T3O-52, D1). `durable`, `unmergedCount`
 * and the changed paths drive the reclaim decision; `unpushedCount` and
 * `hasUpstream` are the detail a move-refusal screen shows.
 */
/** How many unpushed commits a durability probe names. */
export const BOARD_UNPUSHED_COMMITS_MAX = 10;

export const BoardWorkspaceDurability = Schema.Struct({
  hasWorkingTreeChanges: Schema.Boolean,
  changedPaths: Schema.Array(Schema.String),
  openPullRequestNumber: Schema.NullOr(PositiveInt),
  durable: Schema.Boolean,
  /** Commits on `HEAD` that no remote-tracking ref contains. */
  unmergedCount: NonNegativeInt,
  /** Commits on `HEAD` that its upstream does not have; every commit no
      remote has when there is no upstream. */
  unpushedCount: NonNegativeInt,
  /** Whether the checked-out branch tracks a remote branch. */
  hasUpstream: Schema.Boolean,
  /** The newest of those commits, at most `BOARD_UNPUSHED_COMMITS_MAX`, for the
      move refusal to list (T3O-65). Empty from a worker that predates it. */
  unpushedCommits: Schema.Array(
    Schema.Struct({ sha: TrimmedNonEmptyString, subject: Schema.String }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Whether this probe fetched the base branch, so a pass fetches each base
      once rather than once per card. */
  baseFetched: Schema.Boolean,
});
export type BoardWorkspaceDurability = typeof BoardWorkspaceDurability.Type;

export const BoardWorkspaceRetireResult = Schema.NullOr(
  Schema.Union([
    Schema.Struct({
      outcome: Schema.Literal("removed"),
      hookWarning: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({ outcome: Schema.Literal("blocked"), reason: Schema.String }),
  ]),
);
export type BoardWorkspaceRetireResult = typeof BoardWorkspaceRetireResult.Type;

/** A `board/*` worktree under the worker's own worktrees directory. */
export const BoardWorkspaceWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type BoardWorkspaceWorktree = typeof BoardWorkspaceWorktree.Type;

export const BoardWorkspaceBranchCleanup = Schema.Struct({
  remoteDeleted: Schema.Boolean,
  localDeleted: Schema.Boolean,
  skippedReason: Schema.NullOr(Schema.String),
});
export type BoardWorkspaceBranchCleanup = typeof BoardWorkspaceBranchCleanup.Type;

export const BoardWorkspaceBaseBranchSync = Schema.Struct({
  updated: Schema.Boolean,
  skippedReason: Schema.NullOr(Schema.String),
});
export type BoardWorkspaceBaseBranchSync = typeof BoardWorkspaceBaseBranchSync.Type;

export const BoardWorkspaceLocalMergeConflict = Schema.Literals(["conflict", "clean", "unknown"]);
export type BoardWorkspaceLocalMergeConflict = typeof BoardWorkspaceLocalMergeConflict.Type;

/** The tip of a branch on the remote, for the move and force-move dialogs. */
export const BoardWorkspaceRemoteBranchTip = Schema.NullOr(
  Schema.Struct({
    sha: TrimmedNonEmptyString,
    subject: Schema.String,
    committedAt: Schema.String,
    author: Schema.String,
  }),
);
export type BoardWorkspaceRemoteBranchTip = typeof BoardWorkspaceRemoteBranchTip.Type;

/** A pull request as the board reads it (`BoardFoundPullRequest`). */
export const BoardWorkspacePullRequest = Schema.Struct({
  ...VcsStatusChangeRequest.fields,
  mergedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  closedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type BoardWorkspacePullRequest = typeof BoardWorkspacePullRequest.Type;

/** Why the forge is refusing a merge (`BoardMergeState`). */
export const BoardWorkspaceMergeState = Schema.Struct({
  mergeable: Schema.Literals(["mergeable", "blocked", "unknown"]),
  blockedReason: Schema.NullOr(Schema.Literals(["behind", "draft", "conflict"])),
  checks: Schema.Struct({
    total: NonNegativeInt,
    passed: NonNegativeInt,
    pending: NonNegativeInt,
    failed: NonNegativeInt,
    failing: Schema.Array(Schema.String),
    running: Schema.Array(Schema.String),
  }),
  headSha: Schema.NullOr(Schema.String),
  checksUnread: Schema.Boolean,
});
export type BoardWorkspaceMergeState = typeof BoardWorkspaceMergeState.Type;

/** The repository the board's pull requests live on (`BoardRepository`). */
export const BoardWorkspaceRepository = Schema.NullOr(
  Schema.Struct({
    repository: Schema.String,
    host: Schema.optionalKey(Schema.String),
    path: Schema.String,
  }),
);
export type BoardWorkspaceRepository = typeof BoardWorkspaceRepository.Type;

/**
 * A named operation the worker ran and that failed — git, or the forge. The
 * pull-request operations carry the gateway's `refusal`, so a merge refused on
 * a remote worker reads exactly like one refused locally.
 */
export class BoardWorkerGitError extends Schema.TaggedError<BoardWorkerGitError>()(
  "BoardWorkerGitError",
  {
    operation: Schema.String,
    detail: Schema.String,
    refusal: Schema.optionalKey(Schema.Literals(["host", "blocked", "unavailable"])),
  },
) {}

// ── Operations (`boardWorker.git.*`) ───────────────────────────────────

export const BOARD_WORKER_GIT_WS_METHODS = {
  resolveDefaultBranch: "boardWorker.git.resolveDefaultBranch",
  remoteDefaultBranch: "boardWorker.git.remoteDefaultBranch",
  ensureLocalBaseBranch: "boardWorker.git.ensureLocalBaseBranch",
  provisionWorktree: "boardWorker.git.provisionWorktree",
  provisionWorktreeFromRemoteBranch: "boardWorker.git.provisionWorktreeFromRemoteBranch",
  pinGhDefault: "boardWorker.git.pinGhDefault",
  branchHeartbeat: "boardWorker.git.branchHeartbeat",
  measureBaseTip: "boardWorker.git.measureBaseTip",
  createIntegrationBranch: "boardWorker.git.createIntegrationBranch",
  probeLocalMergeConflict: "boardWorker.git.probeLocalMergeConflict",
  pullMergedBaseBranch: "boardWorker.git.pullMergedBaseBranch",
  probeWorktreeDurability: "boardWorker.git.probeWorktreeDurability",
  goneWorktreePath: "boardWorker.git.goneWorktreePath",
  pruneWorktree: "boardWorker.git.pruneWorktree",
  retireWorktree: "boardWorker.git.retireWorktree",
  listBoardWorktrees: "boardWorker.git.listBoardWorktrees",
  deleteCardBranch: "boardWorker.git.deleteCardBranch",
  gitUserName: "boardWorker.git.gitUserName",
  remoteBranchTip: "boardWorker.git.remoteBranchTip",
  pullRequestByBranch: "boardWorker.git.pullRequestByBranch",
  getPullRequest: "boardWorker.git.getPullRequest",
  mergePullRequest: "boardWorker.git.mergePullRequest",
  pullRequestMergeState: "boardWorker.git.pullRequestMergeState",
  markPullRequestReady: "boardWorker.git.markPullRequestReady",
  pullRequestRepository: "boardWorker.git.pullRequestRepository",
} as const;

export type BoardWorkerGitOperation = keyof typeof BOARD_WORKER_GIT_WS_METHODS;

const gitError = Schema.Union([BoardWorkerGitError, EnvironmentAuthorizationError]);
const M = BOARD_WORKER_GIT_WS_METHODS;
const onProject = { projectId: ProjectId };
/**
 * A branch name git accepts (`git check-ref-format --branch`'s core rules),
 * which also cannot be read as an option: a worker passes it to git argv.
 */
const isGitBranchName = Schema.makeFilter(
  (value: string) =>
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.includes("/.") &&
    !value.startsWith(".") &&
    value !== "@" &&
    // oxlint-disable-next-line no-control-regex -- git forbids control characters in a ref
    !/[\x00-\x20\x7f~^:?*[\\]/.test(value),
  { expected: "a git branch name" },
);
const branchName = TrimmedNonEmptyString.check(isGitBranchName);
/** A card's own branch: the only kind a worker creates, pushes or deletes. */
const boardBranchName = branchName.check(
  Schema.makeFilter((value: string) => value.startsWith("board/"), {
    expected: "a board/ branch",
  }),
);
const path = TrimmedNonEmptyString;

export const BOARD_WORKER_GIT_RPCS = [
  Rpc.make(M.resolveDefaultBranch, {
    payload: onProject,
    success: BoardWorkspaceDefaultBranch,
    error: gitError,
  }),
  Rpc.make(M.remoteDefaultBranch, {
    payload: onProject,
    success: Schema.Struct({ branch: Schema.String }),
    error: gitError,
  }),
  Rpc.make(M.ensureLocalBaseBranch, {
    payload: { ...onProject, base: branchName },
    success: Schema.Struct({ exists: Schema.Boolean }),
    error: gitError,
  }),
  Rpc.make(M.provisionWorktree, {
    payload: { ...onProject, branch: boardBranchName, baseRefName: branchName },
    success: BoardWorkspaceProvisionedWorktree,
    error: gitError,
  }),
  Rpc.make(M.provisionWorktreeFromRemoteBranch, {
    payload: { ...onProject, branch: boardBranchName, baseRefName: branchName },
    success: BoardWorkspaceProvisionedWorktree,
    error: gitError,
  }),
  Rpc.make(M.pinGhDefault, {
    payload: { ...onProject, worktreePath: path },
    success: Schema.Void,
    error: gitError,
  }),
  Rpc.make(M.branchHeartbeat, {
    payload: { ...onProject, worktreePath: path, baseRefName: branchName },
    success: Schema.Struct({ committedAt: Schema.NullOr(Schema.String) }),
    error: gitError,
  }),
  Rpc.make(M.measureBaseTip, {
    payload: { ...onProject, baseRefName: branchName },
    success: Schema.Struct({ tip: Schema.NullOr(Schema.String) }),
    error: gitError,
  }),
  Rpc.make(M.createIntegrationBranch, {
    payload: { ...onProject, branch: boardBranchName, base: branchName },
    success: BoardWorkspaceIntegrationBranch,
    error: gitError,
  }),
  Rpc.make(M.probeLocalMergeConflict, {
    payload: { ...onProject, headBranch: branchName, baseBranch: branchName },
    success: Schema.Struct({ result: BoardWorkspaceLocalMergeConflict }),
    error: gitError,
  }),
  Rpc.make(M.pullMergedBaseBranch, {
    payload: { ...onProject, baseBranch: branchName },
    success: BoardWorkspaceBaseBranchSync,
    error: gitError,
  }),
  Rpc.make(M.probeWorktreeDurability, {
    payload: {
      ...onProject,
      worktreePath: path,
      baseRefName: branchName,
      branch: branchName,
      mergedPullRequestNumbers: Schema.Array(PositiveInt),
      openPullRequestNumber: Schema.NullOr(PositiveInt),
      baseAlreadyFetched: Schema.Boolean,
    },
    success: BoardWorkspaceDurability,
    error: gitError,
  }),
  Rpc.make(M.goneWorktreePath, {
    payload: { ...onProject, worktreePath: path, branch: branchName },
    success: Schema.Struct({ path: Schema.NullOr(Schema.String) }),
    error: gitError,
  }),
  Rpc.make(M.pruneWorktree, {
    payload: { ...onProject, worktreePath: path },
    success: Schema.Void,
    error: gitError,
  }),
  Rpc.make(M.retireWorktree, {
    payload: {
      ...onProject,
      worktreePath: path,
      kind: Schema.Literals(["reclaim", "forced"]),
      verifiedClean: Schema.Boolean,
    },
    success: BoardWorkspaceRetireResult,
    error: gitError,
  }),
  Rpc.make(M.listBoardWorktrees, {
    payload: onProject,
    success: Schema.Struct({ worktrees: Schema.Array(BoardWorkspaceWorktree) }),
    error: gitError,
  }),
  Rpc.make(M.deleteCardBranch, {
    payload: { ...onProject, branch: boardBranchName },
    success: BoardWorkspaceBranchCleanup,
    error: gitError,
  }),
  Rpc.make(M.gitUserName, {
    payload: onProject,
    success: Schema.Struct({ name: Schema.String }),
    error: gitError,
  }),
  Rpc.make(M.remoteBranchTip, {
    payload: { ...onProject, branch: branchName },
    success: BoardWorkspaceRemoteBranchTip,
    error: gitError,
  }),
  Rpc.make(M.pullRequestByBranch, {
    payload: {
      ...onProject,
      branch: branchName,
      /** Looked up from this worktree when it is still there. */
      worktreePath: Schema.NullOr(path),
      force: Schema.Boolean,
    },
    success: Schema.NullOr(BoardWorkspacePullRequest),
    error: gitError,
  }),
  Rpc.make(M.getPullRequest, {
    payload: { ...onProject, number: PositiveInt, force: Schema.Boolean },
    success: BoardWorkspacePullRequest,
    error: gitError,
  }),
  Rpc.make(M.mergePullRequest, {
    payload: { ...onProject, number: PositiveInt, method: PullRequestMergeMethod },
    success: Schema.Void,
    error: gitError,
  }),
  Rpc.make(M.pullRequestMergeState, {
    payload: { ...onProject, number: PositiveInt },
    success: BoardWorkspaceMergeState,
    error: gitError,
  }),
  Rpc.make(M.markPullRequestReady, {
    payload: { ...onProject, number: PositiveInt },
    success: Schema.Literals(["readied", "not-draft"]),
    error: gitError,
  }),
  Rpc.make(M.pullRequestRepository, {
    payload: onProject,
    success: BoardWorkspaceRepository,
    error: gitError,
  }),
] as const;

export type BoardWorkerGitRpc = (typeof BOARD_WORKER_GIT_RPCS)[number];
export type BoardWorkerGitMethod = BoardWorkerGitRpc["_tag"];
export type BoardWorkerGitPayload<Method extends BoardWorkerGitMethod> = Rpc.Payload<
  Rpc.ExtractTag<BoardWorkerGitRpc, Method>
>;
export type BoardWorkerGitSuccess<Method extends BoardWorkerGitMethod> = Rpc.Success<
  Rpc.ExtractTag<BoardWorkerGitRpc, Method>
>;

/**
 * Each operation's scope, which the worker's handler checks. Reads sit at the thread-read tier;
 * anything that writes to the repository — a ref, a worktree, a branch, a
 * merge, even a fetch's remote-tracking refs — at source-control write. The
 * board's own session holds both (D19).
 */
export const BOARD_WORKER_GIT_RPC_SCOPES = {
  [M.resolveDefaultBranch]: AuthOrchestrationReadScope,
  [M.remoteDefaultBranch]: AuthOrchestrationReadScope,
  [M.ensureLocalBaseBranch]: AuthSourceControlWriteScope,
  [M.provisionWorktree]: AuthSourceControlWriteScope,
  [M.provisionWorktreeFromRemoteBranch]: AuthSourceControlWriteScope,
  [M.pinGhDefault]: AuthSourceControlWriteScope,
  [M.branchHeartbeat]: AuthOrchestrationReadScope,
  [M.measureBaseTip]: AuthSourceControlWriteScope,
  [M.createIntegrationBranch]: AuthSourceControlWriteScope,
  [M.probeLocalMergeConflict]: AuthSourceControlWriteScope,
  [M.pullMergedBaseBranch]: AuthSourceControlWriteScope,
  [M.probeWorktreeDurability]: AuthSourceControlWriteScope,
  [M.goneWorktreePath]: AuthOrchestrationReadScope,
  [M.pruneWorktree]: AuthSourceControlWriteScope,
  [M.retireWorktree]: AuthSourceControlWriteScope,
  [M.listBoardWorktrees]: AuthOrchestrationReadScope,
  [M.deleteCardBranch]: AuthSourceControlWriteScope,
  [M.gitUserName]: AuthOrchestrationReadScope,
  [M.remoteBranchTip]: AuthSourceControlWriteScope,
  [M.pullRequestByBranch]: AuthOrchestrationReadScope,
  [M.getPullRequest]: AuthOrchestrationReadScope,
  [M.mergePullRequest]: AuthSourceControlWriteScope,
  [M.pullRequestMergeState]: AuthOrchestrationReadScope,
  [M.markPullRequestReady]: AuthSourceControlWriteScope,
  [M.pullRequestRepository]: AuthOrchestrationReadScope,
} as const satisfies Record<BoardWorkerGitMethod, string>;

// ── The RPC (`boardWorker.git.call`) ───────────────────────────────────

/**
 * The one RPC every operation above travels as. The WebSocket RPC group is at
 * the edge of what the type checker will instantiate (see `BoardGatewayCall`),
 * so the operations are not registered one each: `payload` is the operation's
 * payload encoded with its own schema, the answer is its success encoded the
 * same way, and each end codes them with `BOARD_WORKER_GIT_RPCS`. The worker's
 * handler enforces the operation's own scope; the call sits at the lowest.
 */
export const BOARD_WORKER_GIT_CALL_WS_METHODS = {
  call: "boardWorker.git.call",
} as const;

export const BoardWorkerGitCall = Schema.Struct({
  method: Schema.Literals(Object.values(M) as ReadonlyArray<BoardWorkerGitMethod>),
  payload: Schema.Unknown,
});
export type BoardWorkerGitCall = typeof BoardWorkerGitCall.Type;

export const BOARD_WORKER_GIT_CALL_RPCS = [
  Rpc.make(BOARD_WORKER_GIT_CALL_WS_METHODS.call, {
    payload: BoardWorkerGitCall,
    success: Schema.Unknown,
    error: gitError,
  }),
] as const;

/** Spread into `BOARD_RPC_SCOPES`. */
export const BOARD_WORKER_GIT_CALL_RPC_SCOPES = {
  [BOARD_WORKER_GIT_CALL_WS_METHODS.call]: AuthOrchestrationReadScope,
} as const;
