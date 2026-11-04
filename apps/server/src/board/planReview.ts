/**
 * T3o: plan review (T3O-39) — the one place the server resolves a card's plan
 * review from Settings and composes the instructions its planning agent gets.
 * The MCP handlers (propose, complete, context) and the supervisor reactor
 * (respawn and nudge prompts) all read through here, so they cannot disagree.
 */
import {
  boardCardStepState,
  boardStageWithRole,
  composePlanReviewInstructions,
  isBoardCardAutoPlanPending,
  isBoardTerminalStepStatus,
  resolveBoardCardPlanReview,
  resolveBoardPlanReviewSettings,
  resolveBoardStageExecution,
  type BoardCard,
  type BoardCardPlanReview,
  type BoardCardStepState,
  type BoardSettings,
  type BoardState,
} from "@t3tools/contracts";

function planStageExecution(board: BoardState, settings: BoardSettings) {
  const planStage = boardStageWithRole(board, "plan");
  return planStage === null ? null : resolveBoardStageExecution(settings, planStage.stageId);
}

/** The card's effective plan review: its own setting or the Settings default. */
export function resolveCardPlanReview(input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly settings: BoardSettings;
}): BoardCardPlanReview {
  return resolveBoardCardPlanReview(input.card, planStageExecution(input.board, input.settings));
}

/** The card's live plan step while a plan review is running on it, or null. */
export function runningPlanReviewStep(input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly settings: BoardSettings;
}): BoardCardStepState | null {
  const state = boardCardStepState(input.board, input.card.id);
  const planStage = boardStageWithRole(input.board, "plan");
  if (state === null || planStage === null) return null;
  if (state.stepId !== planStage.stageId || isBoardTerminalStepStatus(state.status)) return null;
  if (state.planReviewStartedAt === null || state.planReviewRounds === null) return null;
  return resolveCardPlanReview(input).enabled ? state : null;
}

/** The instructions for a started review, worded for the step's stance now:
    an auto-plan pending turns a human-in-the-loop run unattended. */
export function planReviewInstructions(input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly settings: BoardSettings;
  readonly state: BoardCardStepState;
}): { readonly rounds: number; readonly instructions: string } | null {
  const rounds = input.state.planReviewRounds;
  if (input.state.planReviewStartedAt === null || rounds === null) return null;
  const { prompt } = resolveBoardPlanReviewSettings(
    planStageExecution(input.board, input.settings),
  );
  return {
    rounds,
    instructions: composePlanReviewInstructions({
      prompt,
      rounds,
      humanInLoop: input.state.humanInLoop && !isBoardCardAutoPlanPending(input.card),
    }),
  };
}
