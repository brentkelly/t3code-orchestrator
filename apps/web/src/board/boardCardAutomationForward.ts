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

import { boardStagePrimaryAction, type BoardStagePrimaryAction } from "./boardStageActions";

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

/** Copy for the no-plan Planning-exit confirm (T3O-19), matching the
    rewritten Begin build label when that rewrite applies to this hop. */
function boardPlanningExitConfirmCopy(input: {
  readonly cardKey: string;
  readonly toStageLabel: string;
  readonly primary: BoardStagePrimaryAction | null;
  readonly toStage: BoardStageId;
}): {
  readonly title: string;
  readonly confirmLabel: string;
  readonly extra: string | null;
} {
  const beginBuild =
    input.primary?.kind === "move" &&
    input.primary.toStage === input.toStage &&
    input.primary.label === "Begin build";
  if (beginBuild) {
    return {
      title: `Begin build for ${input.cardKey} without a plan?`,
      confirmLabel: "Begin build",
      extra: `Auto-build will start the card once it reaches ${input.toStageLabel}.`,
    };
  }
  return {
    title: `Move ${input.cardKey} to ${input.toStageLabel} without a plan?`,
    confirmLabel: `Move to ${input.toStageLabel}`,
    extra: null,
  };
}

/** The no-plan confirm for a Planning exit, with Auto-build rewrite applied. */
export function boardPlanningExitConfirmCopyForMove(input: {
  readonly cardKey: string;
  readonly toStageLabel: string;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly fromStage: BoardStageId;
  readonly toStage: BoardStageId;
  readonly autoBuild: BoardCardAutomationForwardAutoBuild;
  readonly unmetCount: number;
  readonly isGroup: boolean;
}): ReturnType<typeof boardPlanningExitConfirmCopy> {
  const primary = boardCardAutomationForwardAction(
    boardStagePrimaryAction(input.stages, input.fromStage),
    {
      stages: input.stages,
      stage: input.fromStage,
      autoBuild: input.autoBuild,
      unmetCount: input.unmetCount,
      isGroup: input.isGroup,
    },
  );
  return boardPlanningExitConfirmCopy({
    cardKey: input.cardKey,
    toStageLabel: input.toStageLabel,
    toStage: input.toStage,
    primary,
  });
}

/** Hide Human in the loop while resolved Auto-build owns the build. */
export function boardCardHumanInLoopProp<T>(input: {
  readonly autoBuildValue: boolean;
  readonly humanInLoop: T;
}): T | null {
  return input.autoBuildValue ? null : input.humanInLoop;
}
