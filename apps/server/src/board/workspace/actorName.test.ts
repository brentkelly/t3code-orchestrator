/**
 * T3o (T3O-64): where the human actor's name comes from on a distributed
 * board — this server's own checkout of the card's project when it has one,
 * otherwise the card's worker, where the commits are made.
 */
import {
  BoardCardId,
  BoardWorkerGitError,
  CommandId,
  ProjectId,
  type BoardCardDetail,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardActivityActorFor, resetBoardActivityActors } from "../activityActors.ts";
import { inertBoardQueries } from "../boardServices.testkit.ts";
import { boardActorStamp } from "../rpc.ts";
import { bindBoardWorkspace, type BoardWorkspace } from "./BoardWorkspace.ts";

const cardId = BoardCardId.make("card-1");
const projectId = ProjectId.make("project-1");

/** A workspace that only knows its user's name. */
const namedWorkspace = (name: string, asked: Array<string>) =>
  ({
    gitUserName: () =>
      Effect.sync(() => {
        asked.push(name);
        return { name };
      }),
  }) as unknown as BoardWorkspace;

const deps = (centralCheckout: string | null, asked: Array<string>) => ({
  threads: {
    project: () =>
      Effect.succeed(
        centralCheckout === null
          ? null
          : {
              id: projectId,
              title: "Project",
              workspaceRoot: centralCheckout,
              deleted: false,
              scripts: [],
              repositoryIdentity: null,
            },
      ),
  },
  boardQueries: inertBoardQueries({
    boardCardDetail: () => Effect.succeed({ card: { projectId } } as unknown as BoardCardDetail),
  }),
  workspaces: {
    localProject: () =>
      Effect.succeed(
        bindBoardWorkspace({
          workspace: namedWorkspace("Central Dev", asked),
          projectId,
          checkoutPath: centralCheckout,
        }),
      ),
    forCard: () =>
      Effect.succeed(
        bindBoardWorkspace({
          workspace: namedWorkspace("Worker Dev", asked),
          projectId,
          checkoutPath: "/worker/project",
        }),
      ),
  },
});

const update = (commandId: string) =>
  ({
    type: "board.card.update",
    commandId: CommandId.make(commandId),
    cardId,
    title: "Renamed",
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as never;

describe("the activity actor's name on a distributed board", () => {
  it.effect("reads this server's checkout of the project when it has one", () =>
    Effect.gen(function* () {
      resetBoardActivityActors();
      const asked: Array<string> = [];
      yield* boardActorStamp(deps("/central/project", asked))(update("cmd-central"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-central")).name, "Central Dev");
      assert.deepStrictEqual(asked, ["Central Dev"]);
    }),
  );

  it.effect("falls back to the card's worker when this server has no checkout", () =>
    Effect.gen(function* () {
      resetBoardActivityActors();
      const asked: Array<string> = [];
      yield* boardActorStamp(deps(null, asked))(update("cmd-worker"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-worker")).name, "Worker Dev");
      assert.deepStrictEqual(asked, ["Worker Dev"]);
    }),
  );

  it.effect("an unreachable worker degrades to the fallback name, never a failed dispatch", () =>
    Effect.gen(function* () {
      resetBoardActivityActors();
      const failing = {
        ...deps(null, []),
        workspaces: {
          ...deps(null, []).workspaces,
          forCard: () =>
            Effect.succeed(
              bindBoardWorkspace({
                workspace: {
                  gitUserName: () =>
                    Effect.fail(
                      new BoardWorkerGitError({ operation: "gitUserName", detail: "offline" }),
                    ),
                } as unknown as BoardWorkspace,
                projectId,
                checkoutPath: null,
              }),
            ),
        },
      };
      yield* boardActorStamp(failing)(update("cmd-offline"));
      assert.strictEqual(boardActivityActorFor(CommandId.make("cmd-offline")).name, "You");
    }),
  );
});
