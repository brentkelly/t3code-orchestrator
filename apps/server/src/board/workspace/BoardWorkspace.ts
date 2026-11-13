/**
 * Where a card's git and forge work runs: a worker's named operations, never raw
 * git. Callers must keep the two failures apart: `BoardWorkerGitError` is the
 * operation failing; `WorkerUnavailable` is the worker out of reach, never
 * counted as an attempt and retried on the next pass.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_GIT_WS_METHODS,
  BoardWorkerGitError,
  type BoardCard,
  type BoardWorkerGitOperation,
  type BoardWorkerGitPayload,
  type BoardWorkerGitSuccess,
  type BoardWorkerId,
  type BoardWorkspaceDurability,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { WorkerUnavailable } from "../workers/WorkerConnections.ts";
import {
  boardCardWorktreeReclaimDecision,
  type BoardCardWorktreeReclaimResult,
} from "../worktree.ts";
import type { BoardWorktreeOwner } from "./LocalBoardWorkspace.ts";

type Method<Op extends BoardWorkerGitOperation> = (typeof BOARD_WORKER_GIT_WS_METHODS)[Op];

export type BoardWorkspaceInput<Op extends BoardWorkerGitOperation> = BoardWorkerGitPayload<
  Method<Op>
>;
export type BoardWorkspaceResult<Op extends BoardWorkerGitOperation> = BoardWorkerGitSuccess<
  Method<Op>
>;

export type BoardWorkspaceFailure = BoardWorkerGitError | WorkerUnavailable;

/** Every named operation, with the worker's own error vocabulary. */
export type BoardWorkspaceOperations<E> = {
  readonly [Op in BoardWorkerGitOperation]: (
    input: BoardWorkspaceInput<Op>,
  ) => Effect.Effect<BoardWorkspaceResult<Op>, E>;
};

/** What a reclaim needs to know about the checkout it may remove. */
export interface BoardWorkspaceReclaimInput {
  readonly projectId: ProjectId;
  readonly worktreePath: string;
  readonly baseRefName: string;
  readonly branch: string;
  readonly mergedPullRequestNumbers: ReadonlyArray<number>;
  readonly openPullRequestNumber?: number | null | undefined;
  /** Base branches this pass already fetched; the reclaim adds to it. */
  readonly fetchedBases?: Set<string> | undefined;
}

export interface BoardWorkspace extends BoardWorkspaceOperations<BoardWorkspaceFailure> {
  readonly workerId: BoardWorkerId;
  /**
   * Remove a gone or clean, durable worktree, asking `stillWanted` again before
   * removing. Not a named operation: on a remote worker it is composed from
   * `goneWorktreePath`, `probeWorktreeDurability` and `retireWorktree`.
   */
  readonly reclaimWorktree: (
    input: BoardWorkspaceReclaimInput,
    stillWanted?: Effect.Effect<boolean>,
  ) => Effect.Effect<BoardCardWorktreeReclaimResult | null, BoardWorkspaceFailure>;
}

/** The operations that read or act on the forge rather than on git. */
const PULL_REQUEST_OPERATIONS = [
  "pullRequestByBranch",
  "getPullRequest",
  "mergePullRequest",
  "pullRequestMergeState",
  "markPullRequestReady",
  "closePullRequest",
  "pullRequestRepository",
] as const satisfies ReadonlyArray<BoardWorkerGitOperation>;

type PullRequestOperation = (typeof PULL_REQUEST_OPERATIONS)[number];
const isPullRequestOperation = new Set<BoardWorkerGitOperation>(PULL_REQUEST_OPERATIONS);

type Bound<Op extends BoardWorkerGitOperation> = (
  input: Omit<BoardWorkspaceInput<Op>, "projectId">,
) => Effect.Effect<
  BoardWorkspaceResult<Op>,
  Op extends PullRequestOperation ? BoardWorkerGitError : BoardWorkspaceFailure
>;

/**
 * One card's workspace, bound to its project checkout. An unreachable worker
 * reads as the forge's `unavailable` refusal, which every forge caller already
 * retries.
 */
export type BoardCardWorkspace = {
  readonly [Op in BoardWorkerGitOperation]: Bound<Op>;
} & {
  readonly workerId: BoardWorkerId;
  readonly projectId: ProjectId;
  /** The checkout's path on its worker, or null when the worker has none. For
      messages that name it, and the one "no workspace" check. */
  readonly checkoutPath: string | null;
  readonly workspace: BoardWorkspace;
  readonly reclaimWorktree: (
    input: Omit<BoardWorkspaceReclaimInput, "projectId">,
    stillWanted?: Effect.Effect<boolean>,
  ) => Effect.Effect<BoardCardWorktreeReclaimResult | null, BoardWorkspaceFailure>;
};

const asForgeFailure = (operation: string) => (error: BoardWorkspaceFailure) =>
  error._tag === "WorkerUnavailable"
    ? new BoardWorkerGitError({ operation, detail: error.message, refusal: "unavailable" })
    : error;

export function bindBoardWorkspace(input: {
  readonly workspace: BoardWorkspace;
  readonly projectId: ProjectId;
  readonly checkoutPath: string | null;
}): BoardCardWorkspace {
  const { workspace, projectId } = input;
  const bound: Record<string, unknown> = {
    workerId: workspace.workerId,
    projectId,
    checkoutPath: input.checkoutPath,
    workspace,
    reclaimWorktree: (
      reclaim: Omit<BoardWorkspaceReclaimInput, "projectId">,
      stillWanted?: Effect.Effect<boolean>,
    ) => workspace.reclaimWorktree({ ...reclaim, projectId }, stillWanted),
  };
  for (const op of Object.keys(BOARD_WORKER_GIT_WS_METHODS) as Array<BoardWorkerGitOperation>) {
    const run = workspace[op] as (
      payload: unknown,
    ) => Effect.Effect<unknown, BoardWorkspaceFailure>;
    bound[op] = isPullRequestOperation.has(op)
      ? (args: object) => run({ ...args, projectId }).pipe(Effect.mapError(asForgeFailure(op)))
      : (args: object) => run({ ...args, projectId });
  }
  return bound as BoardCardWorkspace;
}

/**
 * A reclaim composed from the named operations, for a worker that cannot be
 * handed `stillWanted`: a checkout whose folder is
 * gone only loses its registration; anything else is probed, judged, and
 * retired only while the board still wants it gone.
 */
export const reclaimThroughOperations = Effect.fn("BoardWorkspace.reclaimThroughOperations")(
  function* (
    workspace: BoardWorkspaceOperations<BoardWorkspaceFailure> & { readonly workerId: string },
    input: BoardWorkspaceReclaimInput,
    stillWanted?: Effect.Effect<boolean>,
  ) {
    const wanted = stillWanted ?? Effect.succeed(true);
    const gone = yield* workspace.goneWorktreePath({
      projectId: input.projectId,
      worktreePath: input.worktreePath,
      branch: input.branch,
    });
    if (gone.path !== null) {
      if (!(yield* wanted)) return null;
      yield* workspace.pruneWorktree({ projectId: input.projectId, worktreePath: gone.path });
      return { outcome: "removed", reason: null } satisfies BoardCardWorktreeReclaimResult;
    }
    const fetchKey = `${workspace.workerId}\0${input.projectId}\0${input.baseRefName}`;
    const facts: BoardWorkspaceDurability = yield* workspace.probeWorktreeDurability({
      projectId: input.projectId,
      worktreePath: input.worktreePath,
      baseRefName: input.baseRefName,
      branch: input.branch,
      mergedPullRequestNumbers: input.mergedPullRequestNumbers,
      openPullRequestNumber: input.openPullRequestNumber ?? null,
      baseAlreadyFetched: input.fetchedBases?.has(fetchKey) === true,
    });
    if (facts.baseFetched) input.fetchedBases?.add(fetchKey);
    const decision = boardCardWorktreeReclaimDecision(facts);
    if (!decision.safe) {
      return {
        outcome: "blocked",
        reason: decision.reason,
      } satisfies BoardCardWorktreeReclaimResult;
    }
    if (!(yield* wanted)) return null;
    const retired = yield* workspace.retireWorktree({
      projectId: input.projectId,
      worktreePath: input.worktreePath,
      kind: "reclaim",
      verifiedClean: true,
    });
    if (retired === null) return null;
    if (retired.outcome === "blocked") {
      return {
        outcome: "blocked",
        reason: retired.reason,
      } satisfies BoardCardWorktreeReclaimResult;
    }
    return {
      outcome: "removed",
      reason: null,
      ...(retired.hookWarning === null ? {} : { hookWarning: retired.hookWarning }),
    } satisfies BoardCardWorktreeReclaimResult;
  },
);

/** Where a card runs, when it is not here. Supplied by placement;
    tests supply their own. */
export interface BoardWorkspacePlacement {
  readonly workerId: Exclude<BoardWorkerId, typeof BOARD_LOCAL_WORKER_ID>;
  /** The WORKER's project id for the card's project. */
  readonly projectId: ProjectId;
}

export interface BoardWorkspacesShape {
  /** This server's own workspace. */
  readonly local: BoardWorkspace;
  /** The same workspace as a board that dialed this one sees it: the
      checkouts it provisions are marked with that board's environment id, and
      its orphan sweep lists only those (`BoardWorktreeOwner`). The board id
      comes from the calling session's `t3o-board:<id>` subject. */
  readonly forBoard: (boardId: string) => BoardWorkspace;
  /**
   * Whether `path` is one of `projectId`'s worktrees on this server (never the
   * checkout itself). With `owner`, a checkout still on disk must be that board's,
   * so a central server never touches this server's own board's or a user's
   * worktrees; one already gone is allowed, for a retry to finish.
   */
  readonly ownsWorktreePath: (
    projectId: ProjectId,
    path: string,
    owner?: BoardWorktreeOwner,
  ) => Effect.Effect<boolean>;
  /**
   * Whether board `boardId` may delete `branch` here: not on this server's own
   * board's cards, and not checked out in a worktree that board didn't make.
   * `deleteCardBranch` names no path for `ownsWorktreePath` to check.
   */
  readonly centralMayDeleteBranch: (
    projectId: ProjectId,
    branch: string,
    boardId: string,
  ) => Effect.Effect<boolean>;
  /**
   * Whether a central server may build on `branch` here: not a branch on this
   * server's own board's cards. Both boards name branches `board/<key>`, so a
   * central card could otherwise attach to the worker board's card's commits.
   * The worker asks it before provisioning a central card's worktree.
   */
  readonly centralMayUseBranch: (branch: string) => Effect.Effect<boolean>;
  /** The workspace a card's git and forge work runs in, bound to its checkout. */
  readonly forCard: (
    card: Pick<BoardCard, "id" | "projectId">,
  ) => Effect.Effect<BoardCardWorkspace>;
  /** A project's workspace on this server — for work that has no card yet. */
  readonly localProject: (projectId: ProjectId) => Effect.Effect<BoardCardWorkspace>;
  /** A board project's workspace on a given worker, bound to that worker's
      checkout of it — where a card is about to move. */
  readonly forWorker: (
    workerId: BoardWorkerId,
    projectId: ProjectId,
  ) => Effect.Effect<BoardCardWorkspace>;
  /**
   * Every distinct workspace the given cards run in, each with the cards
   * placed there — so a sweep runs once per worker and project, and only
   * judges the cards that live there.
   */
  readonly groupByWorkspace: <C extends Pick<BoardCard, "id" | "projectId">>(
    cards: ReadonlyArray<C>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly workspace: BoardCardWorkspace; readonly cards: ReadonlyArray<C> }>
  >;
}

export class BoardWorkspaces extends Context.Service<BoardWorkspaces, BoardWorkspacesShape>()(
  "t3/board/workspace/BoardWorkspace/BoardWorkspaces",
) {}
