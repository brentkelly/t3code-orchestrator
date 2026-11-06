/**
 * T3o: turning one project's `t3o.json` read into a board command, or nothing
 * (T3O-43). Pure, so the supervisor's sweep and its tests share one answer to
 * "did anything change?". It resolves against the board as it stands, so a
 * global stage edit that changes what the file means is picked up too.
 */
import {
  boardAllStages,
  boardProjectStageConfig,
  isBoardProjectStageConfigPlanEmpty,
  planBoardProjectStageConfig,
  resolveT3oProjectFile,
  type BoardProjectStageConfig,
  type BoardStageDefinition,
  type BoardState,
  type ProjectId,
} from "@t3tools/contracts";

import type { BoardProjectFileRead } from "./BoardProjectConfig.ts";

export interface BoardProjectStageConfigUpdate {
  readonly projectId: ProjectId;
  readonly config: BoardProjectStageConfig;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
}

export function boardProjectStageConfigUpdate(input: {
  readonly board: BoardState;
  readonly projectId: ProjectId;
  readonly read: BoardProjectFileRead;
  readonly now: string;
}): BoardProjectStageConfigUpdate | null {
  const resolved =
    keepPersistedOnUnusable(input) ??
    resolveT3oProjectFile({
      raw: input.read.raw,
      board: input.board,
      projectId: input.projectId,
      source: input.read.source,
      now: input.now,
      warnings: input.read.warnings,
    });
  const plan = planBoardProjectStageConfig({
    board: input.board,
    projectId: input.projectId,
    config: resolved.config,
    stages: resolved.stages,
  });
  if (isBoardProjectStageConfigPlanEmpty(plan)) return null;
  return { projectId: input.projectId, config: resolved.config, stages: resolved.stages };
}

/** A broken file the reader has no good version of (first read after a
    restart): keep what the board last loaded, with the new warning, so a bad
    save never resets the pipeline — or lets CI cards skip CI at boot. */
function keepPersistedOnUnusable(input: {
  readonly board: BoardState;
  readonly projectId: ProjectId;
  readonly read: BoardProjectFileRead;
}): { config: BoardProjectStageConfig; stages: ReadonlyArray<BoardStageDefinition> } | null {
  const problem = input.read.unusable;
  if (problem === undefined) return null;
  const persisted = boardProjectStageConfig(input.board, input.projectId);
  if (persisted === null || persisted.source === null) return null;
  const rows = boardAllStages(input.board);
  const stages = persisted.addedStageIds.flatMap((stageId) =>
    rows.filter((row) => row.stageId === stageId && row.projectId === input.projectId),
  );
  return {
    config: {
      ...persisted,
      warnings: [`${problem}. Using the version the board last loaded.`],
    },
    stages,
  };
}
