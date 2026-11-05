/**
 * T3o: turning one project's `t3o.json` read into a board command, or nothing
 * (T3O-43). Pure, so the supervisor's sweep and its tests share one answer to
 * "did anything change?". It resolves against the board as it stands, so a
 * global stage edit that changes what the file means is picked up too.
 */
import {
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
  const resolved = resolveT3oProjectFile({
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
