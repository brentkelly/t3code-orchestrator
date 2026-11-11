/**
 * T3o: plan review — the one place the server resolves a card's plan
 * review from Settings and composes the instructions its planning agent gets.
 * The MCP handlers (propose, complete, context) and the supervisor reactor
 * (respawn and nudge prompts) all read through here, so they cannot disagree.
 */
import {
  boardCardStepState,
  boardProjectStageConfig,
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
  type BoardStepCompletion,
} from "@t3tools/contracts";

function planStageExecution(board: BoardState, settings: BoardSettings, card: BoardCard) {
  const planStage = boardStageWithRole(board, "plan");
  if (planStage === null) return null;
  const execution = resolveBoardStageExecution(
    settings,
    planStage.stageId,
    boardProjectStageConfig(board, card.projectId),
  );
  return execution.kind === "simple" ? execution : null;
}

/** The card's effective plan review: its own setting or the Settings default. */
export function resolveCardPlanReview(input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly settings: BoardSettings;
}): BoardCardPlanReview {
  return resolveBoardCardPlanReview(
    input.card,
    planStageExecution(input.board, input.settings, input.card),
  );
}

/** The card's live plan step while a plan review is running on it, or null.
    A started review outlives a Settings default change; only the card's own
    toggle stops it, because only that emits the stop turn. */
export function runningPlanReviewStep(input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly settings: BoardSettings;
}): BoardCardStepState | null {
  const state = boardCardStepState(input.board, input.card.id);
  const planStage = boardStageWithRole(input.board, "plan");
  if (state === null || planStage === null) return null;
  if (state.stepId !== planStage.stageId || isBoardTerminalStepStatus(state.status)) return null;
  if (state.planReviewStartedAt === undefined || state.planReviewRounds === undefined) return null;
  return input.card.planReview?.enabled === false ? null : state;
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
  if (input.state.planReviewStartedAt === undefined || rounds === undefined) return null;
  const { prompt } = resolveBoardPlanReviewSettings(
    planStageExecution(input.board, input.settings, input.card),
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

/**
 * Whether a new `succeeded` completion replaces the pinned one: only when the
 * step was reopened after that completion was recorded, by a late plan review
 * or by turning Auto-plan on. The one reading of "is this step reopened": a
 * stale stamp stops counting once a newer completion exists.
 */
export function boardCompletionReopened(
  existing: BoardStepCompletion | undefined,
  current: BoardCardStepState | null,
): boolean {
  const stamps = reopenStampsAfter(existing, current);
  return stamps.planReview || stamps.autoPlan;
}

/** Turning Auto-plan on reopened this step and the agent has not finished
    again since: `boardCompletionReopened`, by the Auto-plan stamp. */
export function boardCompletionReopenedByAutoPlan(
  existing: BoardStepCompletion | undefined,
  current: BoardCardStepState | null,
): boolean {
  return reopenStampsAfter(existing, current).autoPlan;
}

/** Which reopen stamps are newer than the pinned success on a live step. */
function reopenStampsAfter(
  existing: BoardStepCompletion | undefined,
  current: BoardCardStepState | null,
): { readonly planReview: boolean; readonly autoPlan: boolean } {
  if (
    existing === undefined ||
    existing.outcome !== "succeeded" ||
    current === null ||
    current.stepId !== existing.stepId ||
    isBoardTerminalStepStatus(current.status)
  )
    return { planReview: false, autoPlan: false };
  const after = (at: string | undefined) => at !== undefined && existing.completedAt < at;
  return { planReview: after(current.planReviewStartedAt), autoPlan: after(current.reopenedAt) };
}
