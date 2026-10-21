/**
 * T3o (T3O-64, D21): where a card's git and forge work runs.
 *
 * A `BoardWorkspace` is one worker's set of NAMED operations — the
 * `boardWorker.git.*` vocabulary in `@t3tools/contracts` — each taking that
 * worker's project id and typed arguments, never raw git. `LocalBoardWorkspace`
 * runs them on this server; `RemoteBoardWorkspace` sends them to a worker,
 * which runs the very same local implementation.
 *
 * The supervisor never picks one itself. `BoardWorkspaces.forCard` answers
 * where a card runs, bound to the card's checkout there, so every call site
 * reads the same: `(yield* workspaceFor(card)).measureBaseTip(...)`. Until
 * placement exists (T3O-65) every card is local.
 *
 * Failures are two kinds and callers must keep them apart: `BoardWorkerGitError`
 * is the operation failing, `WorkerUnavailable` is the worker being out of
 * reach — not a git failure, never counted as an attempt, retried on the next
 * pass.
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
   * Remove a card's worktree when it is gone already, or clean and durable
   * (T3O-52), asking `stillWanted` again before anything is removed. Not a
   * named operation of its own: `stillWanted` is a question for the board,
   * so on a remote worker it is composed from `goneWorktreePath`,
   * `probeWorktreeDurability` and `retireWorktree`.
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
 * One card's workspace: a worker, bound to the card's project checkout there.
 *
 * The forge operations fail with `BoardWorkerGitError` alone. An unreachable
 * worker reads as the pull-request gateway's `unavailable` refusal — "the
 * attempt could not be made right now, a retry may well work" — which is
 * exactly what every forge caller already does with it.
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
 * handed `stillWanted` (T3O-52's rule, unchanged): a checkout whose folder is
 * gone only loses its registration; anything else is probed, judged, and
 * retired only while the board still wants it gone.
 */
export const reclaimThroughOperations = (
  workspace: BoardWorkspaceOperations<BoardWorkspaceFailure> & { readonly workerId: string },
  input: BoardWorkspaceReclaimInput,
  stillWanted?: Effect.Effect<boolean>,
) =>
  Effect.gen(function* () {
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
  });

/** Where a card runs, when it is not here. Supplied by placement (T3O-65);
    tests supply their own. */
export interface BoardWorkspacePlacement {
  readonly workerId: Exclude<BoardWorkerId, typeof BOARD_LOCAL_WORKER_ID>;
  /** The WORKER's project id for the card's project. */
  readonly projectId: ProjectId;
}

export interface BoardWorkspacesShape {
  /** This server's own workspace. */
  readonly local: BoardWorkspace;
  /** The same workspace as the central server that dialed this one sees it:
      the checkouts it provisions are marked as the central board's, and its
      orphan sweep lists only those (`BoardWorktreeOwner`). */
  readonly forCentral: BoardWorkspace;
  /**
   * Whether `path` is one of `projectId`'s worktrees on this server: under its
   * worktrees directory, or registered with the checkout's git (never the
   * checkout itself). The worker checks every path a central server names.
   */
  readonly ownsWorktreePath: (projectId: ProjectId, path: string) => Effect.Effect<boolean>;
  /** The workspace a card's git and forge work runs in, bound to its checkout. */
  readonly forCard: (
    card: Pick<BoardCard, "id" | "projectId">,
  ) => Effect.Effect<BoardCardWorkspace>;
  /** A project's workspace on this server — for work that has no card yet. */
  readonly localProject: (projectId: ProjectId) => Effect.Effect<BoardCardWorkspace>;
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
