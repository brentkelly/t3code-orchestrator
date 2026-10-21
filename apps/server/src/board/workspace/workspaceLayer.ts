/**
 * T3o (T3O-64, D21): `BoardWorkspaces`, the one answer to "where does this
 * card's git run".
 *
 * Built from the local workspace and a placement. Until placement lands
 * (T3O-65) `BoardWorkspacesLive` has none, so every card is local and the
 * board behaves exactly as it did; a test supplies a placement and a remote
 * resolver to put a card on another worker.
 */
import type { BoardCard, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { BoardPullRequestGateway } from "../BoardPullRequestGateway.ts";
import { ThreadGateway } from "../ThreadGateway.ts";
import { parseRegisteredWorktrees } from "../worktree.ts";
import { WorktreeRetirer } from "../worktreeRetire.ts";
import {
  bindBoardWorkspace,
  BoardWorkspaces,
  type BoardCardWorkspace,
  type BoardWorkspacePlacement,
  type BoardWorkspacesShape,
} from "./BoardWorkspace.ts";
import { makeLocalBoardWorkspace, type LocalBoardWorkspaceDeps } from "./LocalBoardWorkspace.ts";

export interface BoardWorkspacesOptions {
  /** Where a card runs when it is not here; null for this server. */
  readonly placementOf?: (
    card: Pick<BoardCard, "id" | "projectId">,
  ) => Effect.Effect<BoardWorkspacePlacement | null>;
  /** The placed card's workspace on its worker. */
  readonly remote?: (placement: BoardWorkspacePlacement) => Effect.Effect<BoardCardWorkspace>;
}

export function makeBoardWorkspaces(
  deps: LocalBoardWorkspaceDeps,
  options: BoardWorkspacesOptions = {},
): BoardWorkspacesShape {
  const local = makeLocalBoardWorkspace(deps);
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

  const ownsWorktreePath: BoardWorkspacesShape["ownsWorktreePath"] = (projectId, path) =>
    Effect.gen(function* () {
      const resolved = pathService.resolve(path);
      const roots = yield* deps.worktreeRoots;
      if (roots.some((root) => isWithinRoot(resolved, root))) return true;
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
      return parseRegisteredWorktrees(listed.stdout)
        .slice(1)
        .some((registered) => pathService.resolve(registered.path) === resolved);
    });

  return {
    local,
    ownsWorktreePath,
    forCard,
    localProject,
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

/** Every card local: today's board. Placement (T3O-65) replaces this. */
export const BoardWorkspacesLive = Layer.effect(
  BoardWorkspaces,
  localBoardWorkspaceDeps.pipe(Effect.map((deps) => makeBoardWorkspaces(deps))),
);
