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
 * already finished: that thread completed the step successfully. A finished
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
  const finished = boardCardStepCompletions(board, card.id).some(
    (completion) =>
      completion.stepId === card.stage &&
      completion.outcome === "succeeded" &&
      completion.threadId === link.threadId,
  );
  return finished ? null : link.threadId;
}

/**
 * Whether `threadId` is a planning interview the card kept when it left, and
 * that has not finished yet.
 *
 * The release sweep leaves such a thread in the inbox. The card has moved on,
 * but the conversation has not: the agent may still ask something in prose, or
 * wait on an answer, and settling it would hide that from everywhere but the
 * card's own thread tab. A thread that reported its step at all, even as
 * failed, has nothing more to say and is released.
 *
 * A written plan does not finish the interview: planning ends with
 * `board_complete_step`, and an agent often writes the plan, then asks the
 * human to confirm it before reporting.
 */
export function isUnfinishedKeptInterview(
  board: BoardState,
  card: Pick<BoardCard, "id" | "stage" | "threadLinks">,
  threadId: ThreadId,
): boolean {
  const stepId = keptPlanningStepId(board, card, threadId);
  return (
    stepId !== null &&
    !boardCardStepCompletions(board, card.id).some(
      (completion) => completion.stepId === stepId && completion.threadId === threadId,
    )
  );
}

/**
 * Whether `threadId` is the kept planning thread of the card's plan-role step
 * `stepId`, and so may still record that step's completion.
 *
 * Leaving Planning settles the step as `abandoned` but keeps its thread running
 * (`keepsPlanningThreadOnExit`), so the interview can finish after the card has
 * moved on. Its `board_complete_step` must land, or the finished interview is
 * never recorded and a re-entry resumes it as if it were not.
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
 * The plan-role step whose thread `threadId` the card kept when it left that
 * stage, or null.
 *
 * Read from the card's links, never its step-state row: the card holds one row,
 * and the next stage's step replaces the abandoned planning one (Planning →
 * Ready → Building), while the kept thread is still talking. Every other
 * stage's thread was dropped when its card left, so a live link under a
 * plan-role stage can only be a kept interview, finished or not.
 *
 * The one exception is a link to the stage's live step: back in Planning, the
 * step is running again and the ordinary live-step rule owns it. A card back in
 * Planning whose step stayed terminal (it was not resumed) still keeps the
 * thread, so the interview can report.
 */
export function keptPlanningStepId(
  board: BoardState,
  card: Pick<BoardCard, "id" | "stage" | "threadLinks">,
  threadId: ThreadId,
): string | null {
  const link = card.threadLinks.findLast(
    (candidate) => candidate.threadId === threadId && candidate.tombstonedAt === null,
  );
  if (link === undefined || !isPlanStage(board, link.role)) return null;
  if (link.role === card.stage) {
    const state = boardCardStepState(board, card.id);
    if (state !== null && state.stepId === link.role && !isBoardTerminalStepStatus(state.status))
      return null;
  }
  return link.role;
}
