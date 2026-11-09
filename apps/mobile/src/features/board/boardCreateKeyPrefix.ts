/**
 * The key prefix a phone-created card should carry (D14).
 *
 * Web's create dialog and the board MCP handler both call `assignBoardKeyPrefix`
 * and persist a new acronym. Without that, `board.card.create` falls through to
 * `CARD` and a T3O-n project splits its keys.
 */
import {
  DEFAULT_BOARD_SETTINGS,
  assignBoardKeyPrefix,
  type BoardSettings,
  type ProjectId,
} from "@t3tools/contracts";

export function boardCreateKeyPrefix(input: {
  readonly board: BoardSettings | null | undefined;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
}): { readonly prefix: string; readonly assigned: boolean } {
  return assignBoardKeyPrefix({
    board: input.board ?? DEFAULT_BOARD_SETTINGS,
    projectId: input.projectId,
    projectTitle: input.projectTitle,
  });
}

export function boardKeyPrefixPersistPatch(input: {
  readonly board: BoardSettings;
  readonly projectId: ProjectId;
  readonly prefix: string;
}): { readonly projects: BoardSettings["projects"] } {
  const current = input.board.projects[input.projectId];
  return {
    projects: {
      ...input.board.projects,
      [input.projectId]: {
        keyPrefix: input.prefix,
        hidden: current?.hidden ?? false,
      },
    },
  };
}
