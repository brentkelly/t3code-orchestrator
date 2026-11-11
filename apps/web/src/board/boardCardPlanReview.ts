/**
 * T3o: the card sidebar's Plan review section (plan review), as data.
 * Pure, so the visibility and clamp rules are tested without rendering.
 */
import {
  BOARD_PLAN_REVIEW_ROUNDS_MAX,
  BOARD_PLAN_REVIEW_ROUNDS_MIN,
  clampBoardPlanReviewRounds,
  compareBoardStages,
  effectiveBoardStageRole,
  resolveBoardCardPlanReview,
  resolveBoardStageExecution,
  type BoardCardPlanReview,
  type BoardSettings,
  type BoardPlanReviewSettings,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardProjectExecutionConfig,
} from "@t3tools/contracts";

export interface BoardCardPlanReviewView {
  readonly enabled: boolean;
  readonly rounds: number;
  /** A review is running on the live planning step. Its rounds can still
      change; the agent is told the new total. */
  readonly inProgress: boolean;
  readonly summary: string;
  readonly note: string;
  readonly canDecrease: boolean;
  readonly canIncrease: boolean;
}

/** The plan-role stage's execution config, where plan review settings live. */
export function boardPlanStageExecution(
  settings: BoardSettings,
  stages: ReadonlyArray<BoardStageDefinition>,
  projectConfig?: BoardProjectExecutionConfig | null,
): { readonly planReview?: BoardPlanReviewSettings | undefined } | null {
  const planStage = stages.find((stage) => effectiveBoardStageRole(stage) === "plan");
  if (planStage === undefined) return null;
  const execution = resolveBoardStageExecution(settings, planStage.stageId, projectConfig);
  return execution.kind === "simple" ? execution : null;
}

function roundsWord(rounds: number): string {
  return rounds === 1 ? "1 round" : `${rounds} rounds`;
}

/** The section, or null where it is hidden: on a group, and after Planning. */
export function boardCardPlanReviewView(input: {
  readonly card: {
    readonly stage: BoardStageId;
    readonly planReview?: BoardCardPlanReview | undefined;
  };
  readonly isGroup: boolean;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly planStageExecution:
    | { readonly planReview?: BoardPlanReviewSettings | undefined }
    | null
    | undefined;
  readonly planReviewStarted?: { readonly rounds: number } | undefined;
}): BoardCardPlanReviewView | null {
  if (input.isGroup) return null;
  const ordered = [...input.stages].sort(compareBoardStages);
  const planIndex = ordered.findIndex((stage) => effectiveBoardStageRole(stage) === "plan");
  const cardIndex = ordered.findIndex((stage) => stage.stageId === input.card.stage);
  if (planIndex === -1 || cardIndex === -1 || cardIndex > planIndex) return null;
  const resolved = resolveBoardCardPlanReview(input.card, input.planStageExecution);
  // Mirrors the server: a started review runs until the card's own toggle stops it.
  const inProgress =
    input.card.planReview?.enabled !== false &&
    cardIndex === planIndex &&
    input.planReviewStarted !== undefined;
  const enabled = resolved.enabled || inProgress;
  const rounds = inProgress
    ? (input.planReviewStarted?.rounds ?? resolved.rounds)
    : resolved.rounds;
  return {
    enabled,
    rounds,
    inProgress,
    summary: !enabled
      ? "Off"
      : inProgress
        ? `In progress · ${roundsWord(rounds)}`
        : roundsWord(rounds),
    note: inProgress
      ? `The planning agent is reviewing the plan, up to ${roundsWord(rounds)}. Changing the rounds tells it the new total. The final plan comes to you for sign-off.`
      : enabled
        ? `When the plan is posted, the planning agent runs up to ${roundsWord(rounds)} of review. The number and focus of reviewing subagents launched each round is outlined in the plan review prompt. The final plan comes to you for sign-off.`
        : "The plan comes straight to you for sign-off.",
    canDecrease: rounds > BOARD_PLAN_REVIEW_ROUNDS_MIN,
    canIncrease: rounds < BOARD_PLAN_REVIEW_ROUNDS_MAX,
  };
}

/** The card's next setting after a toggle or a rounds change. Always an
    explicit value: touching the control pins the card. */
export function nextBoardCardPlanReview(
  view: Pick<BoardCardPlanReviewView, "enabled" | "rounds">,
  change: { readonly enabled: boolean } | { readonly rounds: number },
): BoardCardPlanReview {
  return "enabled" in change
    ? { enabled: change.enabled, rounds: view.rounds }
    : { enabled: view.enabled, rounds: clampBoardPlanReviewRounds(change.rounds) };
}
