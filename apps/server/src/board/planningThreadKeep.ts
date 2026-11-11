/**
 * A planning interview the card leaves unfinished keeps its thread, and a
 * re-entry resumes the step on it. Pure rules the supervisor reactor calls.
 */
import {
  boardCardStepCompletions,
  boardCardStepState,
  boardStageById,
  BoardStageId,
  effectiveBoardStageRole,
  isBoardTerminalStepStatus,
  type BoardCard,
  type BoardCardStepState,
  type BoardState,
  type ThreadId,
  isLiveBoardCardThreadLink,
} from "@t3tools/contracts";

const isPlanStage = (board: BoardState, stageId: string): boolean => {
  const stage = boardStageById(board, BoardStageId.make(stageId));
  return stage !== null && effectiveBoardStageRole(stage) === "plan";
};

/**
 * Whether a card moving to `toStage` keeps the thread of its live step.
 *
 * True only for a plan-role step the card is leaving. A `stalled` step is the
 * exception: its agent already gave up, so it is not a conversation worth
 * keeping. Dragging that card out and back in is how a human restarts it.
 */
export function keepsPlanningThreadOnExit(
  board: BoardState,
  state: Pick<BoardCardStepState, "stepId" | "status">,
  toStage: string,
): boolean {
  return state.stepId !== toStage && state.status !== "stalled" && isPlanStage(board, state.stepId);
}

/**
 * The thread a card re-entering its plan-role stage resumes: its latest live
 * link for the stage, unless the interview finished. Null runs the stage as
 * usual.
 */
export function keptPlanningThreadId(
  board: BoardState,
  card: Pick<BoardCard, "id" | "stage" | "threadLinks" | "worktree">,
): ThreadId | null {
  // Its worktree is gone and release has settled it.
  if (!isPlanStage(board, card.stage) || card.worktree?.status === "reclaimed") return null;
  const link = card.threadLinks.findLast(
    (candidate) => candidate.role === card.stage && isLiveBoardCardThreadLink(candidate),
  );
  if (link === undefined) return null;
  return interviewFinished(board, card, card.stage, link.threadId) ? null : link.threadId;
}

/**
 * Only a `succeeded` report finishes the interview: failed or blocked still
 * needs the human, and an agent often writes the plan before confirming it.
 * Resume and release share this, so a thread is never resumed and settled.
 */
function interviewFinished(
  board: BoardState,
  card: Pick<BoardCard, "id">,
  stepId: string,
  threadId: ThreadId,
): boolean {
  return boardCardStepCompletions(board, card.id).some(
    (completion) =>
      completion.stepId === stepId &&
      completion.outcome === "succeeded" &&
      completion.threadId === threadId,
  );
}

/**
 * Whether `threadId` is a kept, unfinished planning interview. The release
 * sweep leaves it in the inbox, since the agent may still ask something.
 */
export function isUnfinishedKeptInterview(
  board: BoardState,
  card: Pick<BoardCard, "id" | "stage" | "threadLinks">,
  threadId: ThreadId,
): boolean {
  const stepId = keptPlanningStepId(board, card, threadId);
  return stepId !== null && !interviewFinished(board, card, stepId, threadId);
}

/**
 * Whether `threadId` is the kept thread of plan-role step `stepId`, so its
 * `board_complete_step` still lands after the card moved on.
 */
export function isKeptStepThread(
  board: BoardState,
  card: Pick<BoardCard, "id" | "stage" | "threadLinks">,
  stepId: string,
  threadId: ThreadId | null,
): boolean {
  return threadId !== null && keptPlanningStepId(board, card, threadId) === stepId;
}

/**
 * Read from the card's links, not its step-state row, which the next stage's
 * step replaces. A live link under a plan-role stage is a kept interview,
 * except a link to the stage's live step, which the live-step rule owns.
 */
export function keptPlanningStepId(
  board: BoardState,
  card: Pick<BoardCard, "id" | "stage" | "threadLinks">,
  threadId: ThreadId,
): string | null {
  const link = card.threadLinks.findLast(
    (candidate) => candidate.threadId === threadId && isLiveBoardCardThreadLink(candidate),
  );
  if (link === undefined || !isPlanStage(board, link.role)) return null;
  if (link.role === card.stage) {
    const state = boardCardStepState(board, card.id);
    if (state !== null && state.stepId === link.role && !isBoardTerminalStepStatus(state.status))
      return null;
  }
  return link.role;
}
