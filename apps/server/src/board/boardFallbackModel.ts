/**
 * The model a board-launched thread runs on when nothing names one: the board's default,
 * else the project's own default override, else the project-resolved text-generation
 * selection. Not the environment-wide chat default, which would move every unset stage onto it.
 */
import {
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  resolveBoardDefaultModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";

import type { ServerSettingsService } from "../serverSettings.ts";

export const boardFallbackModelSelection = (
  serverSettings: ServerSettingsService["Service"],
  projectId: ProjectId,
) =>
  serverSettings.getSettings.pipe(
    Effect.map((settings) => {
      const resolved = resolveProjectSettings(settings, projectId);
      const projectDefault =
        resolved.sources.defaultModelSelection === "project"
          ? resolved.settings.defaultModelSelection
          : null;
      const selection = projectDefault ?? resolved.settings.textGenerationModelSelection;
      return resolveBoardDefaultModelSelection(settings.board ?? DEFAULT_BOARD_SETTINGS, {
        instanceId: selection.instanceId,
        model: selection.model,
        ...(selection.options === undefined ? {} : { options: selection.options }),
      });
    }),
    Effect.catchCause(() =>
      Effect.succeed({
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      }),
    ),
  );
