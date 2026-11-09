/**
 * When resolved Auto-build will start this card after Ready, Planning's
 * forward button reads as Ready's Begin build — still moving to Ready.
 * Sibling of `boardCardAutomation.ts`, which owns the Automation *section*.
 */
import {
  boardStageBeforeBuild,
  effectiveBoardStageRole,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
} from "@t3tools/contracts";

import type { BoardStagePrimaryAction } from "./boardStageActions";

/** A `BoardState` view over a bare stage list, so `boardStageBeforeBuild`
    cannot fall back to the seed pipeline on a customised list. */
function stageStateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

export type BoardCardAutomationForwardAutoBuild = {
  readonly value: boolean;
  readonly waitingForGroupStart: boolean;
};

/**
 * Rewrite Planning's Move to Ready as Begin build when resolved Auto-build
 * will start this card immediately after Ready. `toStage` stays Ready.
 */
export function boardCardAutomationForwardAction(
  primary: BoardStagePrimaryAction | null,
  input: {
    readonly stages: ReadonlyArray<BoardStageDefinition>;
    readonly stage: BoardStageId;
    readonly autoBuild: BoardCardAutomationForwardAutoBuild;
    readonly unmetCount: number;
    readonly isGroup: boolean;
  },
): BoardStagePrimaryAction | null {
  if (primary === null || primary.kind !== "move" || input.isGroup) return primary;
  const current = input.stages.find((stage) => stage.stageId === input.stage);
  if (current === undefined || effectiveBoardStageRole(current) !== "plan") return primary;
  const beforeBuild = boardStageBeforeBuild(stageStateOf(input.stages));
  if (beforeBuild === null || primary.toStage !== beforeBuild.stageId) return primary;
  // `value` already excludes inherited waiting; `waitingForGroupStart` is an
  // explicit guard so a lying `{ value: true, waitingForGroupStart: true }`
  // cannot promise a start.
  const willStart = input.autoBuild.value && !input.autoBuild.waitingForGroupStart;
  if (!willStart || input.unmetCount !== 0) return primary;
  return { ...primary, label: "Begin build", emphasised: true };
}

/** Hide Human in the loop while resolved Auto-build owns the build. */
export function boardCardHumanInLoopProp<T>(input: {
  readonly autoBuildValue: boolean;
  readonly humanInLoop: T;
}): T | null {
  return input.autoBuildValue ? null : input.humanInLoop;
}
