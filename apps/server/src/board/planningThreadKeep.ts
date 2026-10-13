/**
 * A planning interview that the card leaves unfinished keeps its thread (T3O-19).
 *
 * Every other stage's live step is abandoned and its thread unlinked when the
 * card moves away, and a later re-entry runs the stage from scratch. Planning is
 * different: the card used to lose the whole conversation if a human moved it
 * on before the plan was written, and moving it back started a fresh interview.
 * So the card keeps the link when it leaves, and a re-entry resumes the step on
 * that same thread.
 *
 * The supervisor reactor calls both rules. They are pure functions of board
 * state.
 */
import {
  boardCardPlans,
  boardCardStepCompletions,
  boardStageById,
  BoardStageId,
  effectiveBoardStageRole,
  type BoardCard,
  type BoardCardStepState,
  type BoardState,
  type ThreadId,
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
 * The thread a card re-entering its plan-role stage resumes, or null to run the
 * stage as usual.
 *
 * This is the card's most recent live link for the stage, unless the interview
 * already finished: that thread completed the step successfully, or a plan was
 * written (the thread may have written it after the card left). A finished
 * interview is not resumed: re-entry keeps its existing rule and leaves that
 * thread alone on the card.
 */
export function keptPlanningThreadId(
  board: BoardState,
  card: Pick<BoardCard, "id" | "stage" | "threadLinks">,
): ThreadId | null {
  if (!isPlanStage(board, card.stage)) return null;
  const link = card.threadLinks.findLast(
    (candidate) => candidate.role === card.stage && candidate.tombstonedAt === null,
  );
  if (link === undefined) return null;
  if (boardCardPlans(board, card.id).length > 0) return null;
  const finished = boardCardStepCompletions(board, card.id).some(
    (completion) =>
      completion.stepId === card.stage &&
      completion.outcome === "succeeded" &&
      completion.threadId === link.threadId,
  );
  return finished ? null : link.threadId;
}

/**
 * Whether `threadId` is the kept planning thread of the card's abandoned step,
 * and so may still record that step's completion.
 *
 * Leaving Planning settles the step as `abandoned` but keeps its thread running
 * (`keepsPlanningThreadOnExit`), so the interview can finish after the card has
 * moved on. Its `board_complete_step` must land, or the finished interview is
 * never recorded and a re-entry resumes it as if it were not. Only the thread
 * still linked to the card under a plan-role step qualifies: every other
 * stage's thread was dropped when its card left, and has nothing to record.
 */
export function isKeptStepThread(
  board: BoardState,
  card: Pick<BoardCard, "threadLinks">,
  state: Pick<BoardCardStepState, "stepId" | "status" | "threadId"> | null,
  stepId: string,
  threadId: ThreadId | null,
): boolean {
  return (
    state !== null &&
    state.stepId === stepId &&
    state.status === "abandoned" &&
    state.threadId === threadId &&
    isPlanStage(board, stepId) &&
    card.threadLinks.some(
      (link) => link.threadId === threadId && link.role === stepId && link.tombstonedAt === null,
    )
  );
}
