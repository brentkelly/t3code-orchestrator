/**
 * T3o (T3O-64, D21): `BoardWorkspaces`, the one answer to "where does this
 * card's git run".
 *
 * Built from the local workspace and a placement (T3O-65): a card runs where
 * it holds its worktree, else on its pin, else on the default worker, and its
 * project maps to that worker's checkout of the same repository. A board with
 * no workers places every card here, exactly as it always did.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  boardCardEffectiveWorkerId,
  boardRepositoryGroupingKey,
  EMPTY_BOARD_STATE,
  resolveBoardWorkerCheckout,
  type BoardCard,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { BoardEngine } from "../BoardEngine.ts";
import { BoardPullRequestGateway } from "../BoardPullRequestGateway.ts";
import { ThreadGateway } from "../ThreadGateway.ts";
import { parseRegisteredWorktrees } from "../worktree.ts";
import { WorkerConnections } from "../workers/WorkerConnections.ts";
import { WorktreeRetirer } from "../worktreeRetire.ts";
import {
  bindBoardWorkspace,
  BoardWorkspaces,
  type BoardCardWorkspace,
  type BoardWorkspacePlacement,
  type BoardWorkspacesShape,
} from "./BoardWorkspace.ts";
import {
  boardWorktreeOwner,
  makeLocalBoardWorkspace,
  type LocalBoardWorkspaceDeps,
} from "./LocalBoardWorkspace.ts";
import { remoteCardWorkspace } from "./RemoteBoardWorkspace.ts";

export interface BoardWorkspacesOptions {
  /** Where a card runs when it is not here; null for this server. */
  readonly placementOf?: (
    card: Pick<BoardCard, "id" | "projectId">,
  ) => Effect.Effect<BoardWorkspacePlacement | null>;
  /** The placed card's workspace on its worker. */
  readonly remote?: (placement: BoardWorkspacePlacement) => Effect.Effect<BoardCardWorkspace>;
  /** A board project's id on a worker — its checkout of the same repository —
      or null when the worker has none. */
  readonly workerProjectOf?: (
    workerId: BoardWorkspacePlacement["workerId"],
    projectId: ProjectId,
  ) => Effect.Effect<ProjectId | null>;
}

export function makeBoardWorkspaces(
  deps: LocalBoardWorkspaceDeps,
  options: BoardWorkspacesOptions = {},
): BoardWorkspacesShape {
  const local = makeLocalBoardWorkspace(deps);
  const forCentral = makeLocalBoardWorkspace(deps, "central");
  const { path: pathService } = deps;

  const localProject = (projectId: ProjectId) =>
    deps
      .projectRoot(projectId)
      .pipe(
        Effect.map((checkoutPath) =>
          bindBoardWorkspace({ workspace: local, projectId, checkoutPath }),
        ),
      );

  const forCard: BoardWorkspacesShape["forCard"] = (card) =>
    Effect.gen(function* () {
      const placement =
        options.placementOf === undefined || options.remote === undefined
          ? null
          : yield* options.placementOf(card);
      if (placement === null || options.remote === undefined) {
        return yield* localProject(card.projectId);
      }
      return yield* options.remote(placement);
    });

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = pathService.relative(root, candidate);
    return relative !== "" && !relative.startsWith("..") && !pathService.isAbsolute(relative);
  };

  /**
   * Whether `path` is one of the project's worktrees on this server: a
   * checkout the project's repository has registered, or — a checkout already
   * gone from disk and from git, which a reclaim or forced removal may still
   * name on retry — a missing path under the worktrees directory. A folder
   * that exists there but is not the project's (another project's checkout,
   * the per-repository container) is refused. With `owner`, a registered
   * checkout still on disk must carry that board's marker too.
   */
  const ownsWorktreePath: BoardWorkspacesShape["ownsWorktreePath"] = (projectId, path, owner) =>
    Effect.gen(function* () {
      const resolved = pathService.resolve(path);
      const cwd = yield* deps.projectRoot(projectId);
      if (cwd === null) return false;
      const listed = yield* deps.git
        .execute({
          operation: "board.workspace.ownsWorktree",
          cwd,
          args: ["worktree", "list", "--porcelain"],
          allowNonZeroExit: true,
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (listed === null || listed.exitCode !== 0) return false;
      const registered = parseRegisteredWorktrees(listed.stdout)
        .slice(1)
        .some((worktree) => pathService.resolve(worktree.path) === resolved);
      const exists = yield* deps.fileSystem.exists(resolved).pipe(Effect.orElseSucceed(() => true));
      if (registered) {
        return (
          owner === undefined || !exists || (yield* boardWorktreeOwner(deps, resolved)) === owner
        );
      }
      const roots = yield* deps.worktreeRoots;
      if (!roots.some((root) => isWithinRoot(resolved, root))) return false;
      return !exists;
    });

  const forWorker: BoardWorkspacesShape["forWorker"] = (workerId, projectId) =>
    Effect.gen(function* () {
      if (workerId === BOARD_LOCAL_WORKER_ID || options.remote === undefined) {
        return yield* localProject(projectId);
      }
      const workerProjectId =
        options.workerProjectOf === undefined
          ? projectId
          : ((yield* options.workerProjectOf(workerId, projectId)) ?? projectId);
      return yield* options.remote({ workerId, projectId: workerProjectId });
    });

  return {
    local,
    forCentral,
    ownsWorktreePath,
    forCard,
    localProject,
    forWorker,
    groupByWorkspace: (cards) =>
      Effect.gen(function* () {
        const groups = new Map<
          string,
          { workspace: BoardCardWorkspace; cards: Array<(typeof cards)[number]> }
        >();
        for (const card of cards) {
          const workspace = yield* forCard(card);
          const key = `${workspace.workerId}\0${workspace.projectId}`;
          const group = groups.get(key);
          if (group === undefined) groups.set(key, { workspace, cards: [card] });
          else group.cards.push(card);
        }
        return [...groups.values()];
      }),
  };
}

/** The local workspace's services, read from context. */
export const localBoardWorkspaceDeps = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const pullRequests = yield* BoardPullRequestGateway;
  const retirer = yield* WorktreeRetirer;
  const threads = yield* ThreadGateway;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const worktreeRoots = Option.match(serverConfig, {
    onNone: () => Effect.succeed([] as ReadonlyArray<string>),
    onSome: (config) => {
      const spelled = path.resolve(config.worktreesDir);
      return fileSystem.realPath(spelled).pipe(
        Effect.map((real) => [...new Set([spelled, path.resolve(real)])]),
        Effect.orElseSucceed(() => [spelled]),
      );
    },
  });
  return {
    git,
    pullRequests,
    retirer,
    fileSystem,
    path,
    projectRoot: (projectId: ProjectId) =>
      threads.project(projectId).pipe(
        Effect.map((project) => project?.workspaceRoot ?? null),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    worktreeRoots,
  } satisfies LocalBoardWorkspaceDeps;
});

/**
 * Each card's workspace where the board places it (T3O-65, D20). A worker with
 * no checkout of the card's project yields a workspace whose `checkoutPath` is
 * null, which every caller already reads as "no checkout there".
 */
export const BoardWorkspacesLive = Layer.effect(
  BoardWorkspaces,
  Effect.gen(function* () {
    const engine = yield* BoardEngine;
    const deps: LocalBoardWorkspaceDeps = {
      ...(yield* localBoardWorkspaceDeps),
      boardHasWorkers: engine.getReadModel.pipe(
        Effect.map((model) => (model.board?.workers ?? []).length > 0),
      ),
    };
    const connections = yield* WorkerConnections;
    const threads = yield* ThreadGateway;
    const workerProjectOf = (workerId: EnvironmentId, projectId: ProjectId) =>
      Effect.gen(function* () {
        const project = yield* threads
          .project(projectId)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        const runtime = (yield* connections.current).get(workerId);
        return (
          resolveBoardWorkerCheckout(
            boardRepositoryGroupingKey(project?.repositoryIdentity),
            runtime?.snapshot?.checkouts ?? [],
          )?.projectId ?? null
        );
      });
    return makeBoardWorkspaces(deps, {
      placementOf: (card) =>
        Effect.gen(function* () {
          const board = (yield* engine.getReadModel).board ?? EMPTY_BOARD_STATE;
          const placed = board.cards.find((candidate) => candidate.id === card.id);
          if (placed === undefined) return null;
          const workerId = boardCardEffectiveWorkerId(placed, board.defaultWorkerId);
          if (workerId === BOARD_LOCAL_WORKER_ID) return null;
          return {
            workerId,
            projectId: (yield* workerProjectOf(workerId, card.projectId)) ?? card.projectId,
          };
        }),
      remote: remoteCardWorkspace(connections),
      workerProjectOf,
    });
  }),
);
