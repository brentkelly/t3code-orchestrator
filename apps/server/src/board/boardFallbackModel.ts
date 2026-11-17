/**
 * The model a board-launched thread runs on when nothing names one: the board's default and
 * the project's own default override (in the order `boardModelSelectionFor` documents), else
 * the project-resolved text-generation selection. Not the environment-wide chat default,
 * which would move every unset stage onto it.
 */
import {
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  resolveBoardDefaultModelSelection,
  type ModelSelection,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";

import type { ServerSettingsService } from "../serverSettings.ts";

const toSelection = (selection: ModelSelection) => ({
  instanceId: selection.instanceId,
  model: selection.model,
  ...("options" in selection && selection.options !== undefined
    ? { options: selection.options }
    : {}),
});

/**
 * `projectFirst` puts the project's own default override ahead of the board's default:
 * schedule runs follow the project, card stages follow the board.
 */
export const boardModelSelectionFor = (
  settings: ServerSettings,
  projectId: ProjectId,
  projectFirst: boolean,
) => {
  const resolved = resolveProjectSettings(settings, projectId);
  const projectDefault =
    resolved.sources.defaultModelSelection === "project"
      ? resolved.settings.defaultModelSelection
      : null;
  if (projectFirst && projectDefault !== null) return toSelection(projectDefault);
  const selection = projectDefault ?? resolved.settings.textGenerationModelSelection;
  return resolveBoardDefaultModelSelection(
    settings.board ?? DEFAULT_BOARD_SETTINGS,
    toSelection(selection),
  );
};

export const boardFallbackModelSelection = (
  serverSettings: ServerSettingsService["Service"],
  projectId: ProjectId,
  options: { readonly projectFirst?: boolean } = {},
) =>
  serverSettings.getSettings.pipe(
    Effect.map((settings) =>
      boardModelSelectionFor(settings, projectId, options.projectFirst === true),
    ),
    Effect.catchCause(() =>
      Effect.succeed({
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      }),
    ),
  );
