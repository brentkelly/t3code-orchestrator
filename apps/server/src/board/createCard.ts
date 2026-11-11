/**
 * Creating a card, shared by `board_create_card` and webhook board rules (T3O-78): the
 * key prefix, the one atomic create command, and its dispatch under the caller's actor.
 * Callers resolve their own project, labels and dependencies first.
 */
import {
  assignBoardKeyPrefix,
  type BoardActivityActor,
  type BoardCardCreateCommand,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { stampBoardActivityActor } from "./activityActors.ts";
import type { BoardEngineShape } from "./BoardEngine.ts";

/**
 * The key prefix a new card should carry. A project with no stored prefix is assigned one and it
 * is PERSISTED, so agent-, human- and webhook-created cards share one key namespace across
 * renames. An unknown project passes an empty name, which yields the compiled-in default.
 */
export const resolveBoardCardKeyPrefix = Effect.fn("BoardCards.resolveKeyPrefix")(function* (
  projectId: ProjectId,
  projectTitle: string,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings;
  const { prefix, assigned } = assignBoardKeyPrefix({
    board: current.board,
    projectId,
    projectTitle,
  });
  if (assigned) {
    yield* settings.updateSettings({
      board: {
        projects: {
          ...current.board.projects,
          [projectId]: {
            keyPrefix: prefix,
            hidden: current.board.projects[projectId]?.hidden ?? false,
          },
        },
      },
    });
  }
  return prefix;
});

/** Everything of the create command but its key prefix and type. */
export type BoardCardCreateInput = Omit<BoardCardCreateCommand, "type" | "keyPrefix">;

export const createBoardCard = Effect.fn("BoardCards.create")(function* (input: {
  readonly engine: BoardEngineShape;
  readonly actor: BoardActivityActor;
  readonly projectTitle: string;
  readonly create: BoardCardCreateInput;
}) {
  const command: BoardCardCreateCommand = {
    type: "board.card.create",
    ...input.create,
    keyPrefix: yield* resolveBoardCardKeyPrefix(input.create.projectId, input.projectTitle),
  };
  stampBoardActivityActor(command.commandId, input.actor);
  return yield* input.engine.dispatch(command);
});
