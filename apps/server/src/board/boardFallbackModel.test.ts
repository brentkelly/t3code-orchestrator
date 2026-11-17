import { DEFAULT_SERVER_SETTINGS, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { boardModelSelectionFor } from "./boardFallbackModel.ts";

const projectId = ProjectId.make("project-1");
const boardDefault = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "board-model" };
const projectDefault = { instanceId: ProviderInstanceId.make("codex"), model: "project-model" };

const settings = (withProjectDefault: boolean) => ({
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsFolded: true,
  board: { ...DEFAULT_SERVER_SETTINGS.board, defaultModel: boardDefault },
  projectSettingsOverrides: withProjectDefault
    ? { [projectId]: { defaultModelSelection: projectDefault } }
    : {},
});

describe("boardModelSelectionFor", () => {
  it("puts the board default first for card stages, the project default first for schedules", () => {
    assert.deepStrictEqual(boardModelSelectionFor(settings(true), projectId, false), boardDefault);
    assert.deepStrictEqual(boardModelSelectionFor(settings(true), projectId, true), projectDefault);
    assert.deepStrictEqual(boardModelSelectionFor(settings(false), projectId, true), boardDefault);
  });
});
