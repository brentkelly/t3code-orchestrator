/**
 * T3o: plan review — the one place the server resolves a card's plan
 * review from Settings and composes the instructions its planning agent gets.
 * The MCP handlers (propose, complete, context) and the supervisor reactor
 * (respawn and nudge prompts) all read through here, so they cannot disagree.
 */
import {
  boardPlanReviewCreationDefaults,
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
  type ProjectId,
  type BoardState,
  type BoardStepCompletion,
} from "@t3tools/contracts";

function planStageExecution(
  board: BoardState,
  settings: BoardSettings,
  card: Pick<BoardCard, "projectId">,
) {
  const planStage = boardStageWithRole(board, "plan");
  if (planStage === null) return null;
  const execution = resolveBoardStageExecution(
    settings,
    planStage.stageId,
    boardProjectStageConfig(board, card.projectId),
  );
  return execution.kind === "simple" ? execution : null;
}

/** A create command with the project's new-card plan review stamped on, unless it names
    its own or creates a heading, which plans nothing. */
export function withPlanReviewCreationDefaults<
  C extends {
    readonly projectId: ProjectId;
    readonly heading?: boolean | undefined;
    readonly planReview?: BoardCardPlanReview | undefined;
  },
>(command: C, board: BoardState, settings: BoardSettings): C {
  if (command.planReview !== undefined || command.heading === true) return command;
  return {
    ...command,
    planReview: boardPlanReviewCreationDefaults(
      planStageExecution(board, settings, { projectId: command.projectId }),
    ),
  };
}

/** What the planning agent must know between rounds: delivered by the round tool's
    response, or steered when it changes. */
export interface BoardPlanReviewPolicy {
  readonly targetRounds: number;
  readonly unattended: boolean;
  /** A human approved the proposed split to take effect when the review ends (T3O-105). */
  readonly splitApprovedAfterReview: boolean;
}

/** The running review's policy now, or null when no review has started on the step. */
export function planReviewPolicy(input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly settings: BoardSettings;
  readonly state: BoardCardStepState;
}): BoardPlanReviewPolicy | null {
  const rounds = input.state.planReviewRounds;
  if (input.state.planReviewStartedAt === undefined || rounds === undefined) return null;
  return {
    targetRounds: rounds,
    unattended: resolveCardPlanReview(input).unattended === true,
    splitApprovedAfterReview: input.card.pendingSplitApproval !== undefined,
  };
}

/** The stored form of a policy, compared to `planReviewPolicySent`. */
export function planReviewPolicyFingerprint(policy: BoardPlanReviewPolicy): string {
  return `rounds=${policy.targetRounds};unattended=${policy.unattended};split=${policy.splitApprovedAfterReview}`;
}

/** The one message that tells the agent its review policy changed. Review-specific wording,
    never the Auto-plan text. */
export function planReviewPolicyMessage(
  policy: BoardPlanReviewPolicy,
  previous: string | undefined,
): string {
  const rounds = policy.targetRounds === 1 ? "1 round" : `${policy.targetRounds} rounds`;
  const signOff = policy.splitApprovedAfterReview
    ? ""
    : ", and wait for sign-off before calling board_complete_step";
  const stance = policy.unattended
    ? "The review is now unattended: do not ask the human anything for the rest of it. Decide every finding yourself, flag a contentious or uncertain call as unclear or important with board_record_decisions, and when the review ends summarise the final plan and call board_complete_step without waiting for sign-off."
    : previous !== undefined && previous.includes("unattended=true")
      ? `The human is back: the review is attended again. If you need a human decision on a finding, ask through your runtime's user-input request${signOff}.`
      : `The review is attended: ask the human through your runtime's user-input request if you need a decision${signOff}.`;
  const split = policy.splitApprovedAfterReview
    ? "The split is approved to take effect when the review finishes; when done, summarise and call board_complete_step without waiting for further sign-off."
    : previous !== undefined && previous.includes("split=true")
      ? "The split approval was undone: the proposed split waits for the human's approval again."
      : null;
  return [
    `Plan review update from the board. The review target is now ${rounds} in total; if you have already run that many, finish the round you are in, then stop reviewing and summarise.`,
    stance,
    ...(split === null ? [] : [split]),
    "Keep calling board_plan_review_round before each round; its returned target and policy win over this message.",
  ].join(" ");
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
      humanInLoop:
        input.state.humanInLoop &&
        !isBoardCardAutoPlanPending(input.card) &&
        resolveCardPlanReview(input).unattended !== true,
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
