/**
 * `boardActorStamp` must follow a card that changes project, or every activity row it writes
 * is attributed to the git identity of the project it LEFT.
 */
import { BoardCardId, CommandId, ProjectId, type BoardState } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ExecuteGitInput, ExecuteGitResult, GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { boardActivityActorFor, resetBoardActivityActors } from "./activityActors.ts";
import { boardActorStamp } from "./rpc.ts";
import { makeBoardWorkspaces } from "./workspace/workspaceLayer.ts";

const cardId = BoardCardId.make("card-1");
const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");
const NOW = "2026-01-01T00:00:00.000Z";

/** Git `user.name` per checkout — the whole reason the project matters here. */
const USER_NAME_BY_ROOT: Record<string, string> = {
  "/tmp/project-alpha": "Alpha Dev",
  "/tmp/project-beta": "Beta Dev",
};

function fakeDeps(projectOf: { current: ProjectId }) {
  const git = {
    execute: (input: ExecuteGitInput) =>
      Effect.succeed({
        exitCode: 0 as ExecuteGitResult["exitCode"],
        stdout: `${USER_NAME_BY_ROOT[input.cwd] ?? ""}\n`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      } satisfies ExecuteGitResult),
  } as unknown as GitVcsDriver["Service"];

  // The in-memory board is where the stamp learns the card's project.
  const readModel = Effect.sync(() => ({
    board: { cards: [{ id: cardId, projectId: projectOf.current }] } as unknown as BoardState,
  }));
  const threads = {
    project: (projectId: ProjectId) =>
      Effect.succeed({
        id: projectId,
        title: String(projectId),
        workspaceRoot: `/tmp/${projectId}`,
        deleted: false,
        scripts: [],
        repositoryIdentity: null,
      }),
  };

  // The real local workspace over the faked driver: the name is read where
  // the board reads every other git fact.
  const workspaces = makeBoardWorkspaces({
    git,
    pullRequests: {} as never,
    retirer: {} as never,
    fileSystem: {} as never,
    path: {} as never,
    projectRoot: (projectId) => Effect.succeed(`/tmp/${projectId}`),
    worktreeRoots: Effect.succeed([]),
  });

  return { threads, readModel, workspaces };
}

const updateCommand = (commandId: string) =>
  ({
    type: "board.card.update",
    commandId: CommandId.make(commandId),
    cardId,
    title: "Renamed",
    createdAt: NOW,
  }) as never;

const setProjectCommand = (commandId: string) =>
  ({
    type: "board.card.set-project",
    commandId: CommandId.make(commandId),
    cardId,
    projectId: beta,
    createdAt: NOW,
  }) as never;

describe("boardActorStamp after a card changes project", () => {
  it.effect("resolves later commands against the card's NEW project", () =>
    Effect.gen(function* () {
      resetBoardActivityActors();
      const projectOf = { current: alpha };
      const stamp = boardActorStamp(fakeDeps(projectOf));

      yield* stamp(updateCommand("cmd-before"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-before")).name, "Alpha Dev");

      // The move itself keeps the old identity: the command has not been decided
      // yet, so the card still reads as Alpha's — and the human did act there.
      yield* stamp(setProjectCommand("cmd-move"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-move")).name, "Alpha Dev");

      // …and the next command reads the card's new project.
      projectOf.current = beta;
      yield* stamp(updateCommand("cmd-after"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-after")).name, "Beta Dev");
    }),
  );
});
