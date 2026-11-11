/**
 * `localGitOnlyBoardWorkspaces`: the real local workspace for suites that only
 * read git. Its forge and retirement collaborators die if touched, so a suite
 * that reaches them fails loudly rather than passing on a stub.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { ThreadGateway } from "../ThreadGateway.ts";
import { BoardWorkspaces } from "./BoardWorkspace.ts";
import { makeBoardWorkspaces } from "./workspaceLayer.ts";

const unexpected = (what: string) =>
  new Proxy(
    {},
    {
      get: (_target, property) => () =>
        Effect.die(new Error(`This suite's workspace has no ${what} (${String(property)}).`)),
    },
  );

export const localGitOnlyBoardWorkspaces = Layer.effect(
  BoardWorkspaces,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const threads = yield* ThreadGateway;
    const path = yield* Path.Path;
    return makeBoardWorkspaces({
      git,
      pullRequests: unexpected("forge") as never,
      retirer: unexpected("worktree retirer") as never,
      fileSystem: unexpected("file system") as never,
      path,
      projectRoot: (projectId) =>
        threads.project(projectId).pipe(
          Effect.map((project) => project?.workspaceRoot ?? null),
          Effect.orElseSucceed(() => null),
        ),
      worktreeRoots: Effect.succeed([]),
    });
  }),
);
