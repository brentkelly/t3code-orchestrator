/**
 * The card→project cache inside `boardActorStamp` (T3O-33).
 *
 * The stamp resolves a human actor's name from the card's PROJECT git identity,
 * and caches the card→project mapping. That cache was documented as valid
 * forever, on the grounds that a card never changes project. It does now — so
 * without an eviction, every activity row a moved card ever writes is
 * attributed to the git identity of the project it LEFT, for the life of the
 * server process.
 *
 * The git driver is faked down to the two calls this path makes.
 */
import { BoardCardId, CommandId, ProjectId, type BoardCardDetail } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ExecuteGitInput, ExecuteGitResult, GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { boardActivityActorFor, resetBoardActivityActors } from "./activityActors.ts";
import { boardActorStamp } from "./rpc.ts";

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

  const projectionSnapshotQuery = {
    // The board method set the stamp probes for; only `boardCardDetail` is read.
    boardCardDetail: () =>
      Effect.succeed({
        card: { projectId: projectOf.current },
      } as unknown as BoardCardDetail),
    boardCardActivity: () => Effect.succeed([]),
    boardPlanBody: () => Effect.succeed(null),
    boardCardThreads: () => Effect.succeed([]),
    boardCardIdForThread: () => Effect.succeed(null),
    boardThreadTodo: () => Effect.succeed(null),
    boardLatestAssistantMessage: () => Effect.succeed(null),
    boardThreadLastSignalAt: () => Effect.succeed(null),
    boardThreadPendingTurnStartAt: () => Effect.succeed(null),
    boardSweepThreadTodos: () => Effect.void,
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(Option.some({ id: projectId, workspaceRoot: `/tmp/${projectId}` })),
  } as unknown as ProjectionSnapshotQueryShape;

  return { git, projectionSnapshotQuery };
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

      // A first command warms the cache with Alpha.
      yield* stamp(updateCommand("cmd-before"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-before")).name, "Alpha Dev");

      // The move itself keeps the old identity: the command has not been decided
      // yet, so the card still reads as Alpha's — and the human did act there.
      yield* stamp(setProjectCommand("cmd-move"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-move")).name, "Alpha Dev");

      // …but the mapping is evicted, so the next command re-reads the card and
      // gets Beta. Without the eviction this stays "Alpha Dev" forever.
      projectOf.current = beta;
      yield* stamp(updateCommand("cmd-after"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-after")).name, "Beta Dev");
    }),
  );

  it.effect("keeps caching a card that never moves", () =>
    Effect.gen(function* () {
      resetBoardActivityActors();
      const projectOf = { current: alpha };
      const stamp = boardActorStamp(fakeDeps(projectOf));

      yield* stamp(updateCommand("cmd-one"));
      // The card's project changing UNDERNEATH an unmoved card is impossible in
      // production; flipping it here proves the cache is genuinely still held,
      // so the eviction above is the thing doing the work.
      projectOf.current = beta;
      yield* stamp(updateCommand("cmd-two"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-two")).name, "Alpha Dev");
    }),
  );
});
