import { describe, expect, it } from "vitest";

import { ProjectId } from "./baseSchemas.ts";
import { EMPTY_BOARD_STATE, withBoardProjectConfigVersion, type BoardState } from "./board.ts";
import { boardWebhookDefaultArchiveStages, boardWebhookStageSpan } from "./boardWebhookAction.ts";

const project = ProjectId.make("project-hooks");
const noBacklog = ProjectId.make("project-no-backlog");

const board: BoardState = {
  ...EMPTY_BOARD_STATE,
  projectStageConfigs: {
    [noBacklog]: withBoardProjectConfigVersion({
      stageSwitches: { backlog: false },
      overrides: {},
      ci: { steps: [] },
      dismissedImportSha: null,
      warnings: [],
      lastChangedBy: null,
    }),
  },
};

const ids = (stages: ReadonlyArray<{ readonly stageId: string }>) =>
  stages.map((stage) => stage.stageId);

describe("boardWebhookStageSpan", () => {
  it("runs up to the plan-role stage in each project's own pipeline", () => {
    expect(ids(boardWebhookStageSpan(board, project))).toEqual(["backlog", "sprint", "planning"]);
    expect(ids(boardWebhookStageSpan(board, noBacklog))).toEqual(["sprint", "planning"]);
    expect(ids(boardWebhookDefaultArchiveStages(board, project))).toEqual(["backlog", "sprint"]);
    expect(ids(boardWebhookDefaultArchiveStages(board, noBacklog))).toEqual(["sprint"]);
  });

  it("stops before the build-role stage when stages are reordered", () => {
    const reordered: BoardState = {
      ...board,
      stages: (board.stages ?? []).map((stage) =>
        stage.stageId === "planning" ? { ...stage, orderKey: "zzzz" } : stage,
      ),
    };
    expect(ids(boardWebhookStageSpan(reordered, project))).not.toContain("building");
    expect(ids(boardWebhookStageSpan(reordered, project))).not.toContain("planning");
  });
});
