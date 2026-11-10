/**
 * A card's finished threads are released (settled out of the inbox, links kept) by a
 * predicate over board state, re-derived at every step boundary, on a timer and at boot, so
 * a settle refused mid-turn lands later. Kept: the live step-state row's thread while the
 * row is this stage's, a step still being admitted, and an unfinished planning interview.
 */
import {
  boardCardStepState,
  boardStageById,
  effectiveBoardStageRole,
  parseReviewStepId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardState,
} from "@t3tools/contracts";

import { isUnfinishedKeptInterview } from "./planningThreadKeep.ts";

/**
 * A review-loop step id (`<phase>@<round>`) belongs to the stage with the `review` role.
 * The row outlives the stage, so without this a graduated card's thread stays protected.
 */
function boardStepBelongsToStage(
  board: BoardState,
  card: Pick<BoardCard, "stage">,
  state: Pick<BoardCardStepState, "stepId">,
): boolean {
  if (state.stepId === card.stage) return true;
  if (parseReviewStepId(state.stepId) === null) return false;
  const stage = boardStageById(board, card.stage);
  return stage !== null && effectiveBoardStageRole(stage) === "review";
}

/**
 * The settle candidates, in card then link order. `abandoned` (threads unlinked while alive)
 * is returned verbatim. Whether a settle can land now is the decider's call; ask again later.
 */
export function boardReleasedThreadIds(
  board: BoardState,
  abandoned: ReadonlySet<string> = new Set(),
): ReadonlyArray<ThreadId> {
  const released: Array<ThreadId> = [];
  const seen = new Set<string>();
  const add = (threadId: ThreadId) => {
    if (seen.has(String(threadId))) return;
    seen.add(String(threadId));
    released.push(threadId);
  };
  for (const card of board.cards) {
    const state = boardCardStepState(board, card.id);
    // An archived card is done with every thread it holds, whatever its last
    // step row still says.
    const current =
      card.archivedAt !== null || state === null || !boardStepBelongsToStage(board, card, state)
        ? null
        : state;
    for (const link of card.threadLinks) {
      if (link.tombstonedAt !== null) continue;
      // The board retired it (T3O-41): finished, whatever its role says.
      if (link.retiredAt !== undefined) {
        add(link.threadId);
        continue;
      }
      if (current !== null && (current.threadId === link.threadId || current.stepId === link.role))
        continue;
      // A planning interview the card left unfinished (T3O-19) is still a
      // conversation, whatever column the card is in.
      if (card.archivedAt === null && isUnfinishedKeptInterview(board, card, link.threadId))
        continue;
      add(link.threadId);
    }
  }
  for (const threadId of abandoned) add(ThreadId.make(threadId));
  return released;
}
