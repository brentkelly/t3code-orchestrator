/**
 * T3o: the ways out of a stalled step (T3O-13).
 *
 * A step that stalls — its thread died, or its spawn failed so it never had one
 * — drives nothing until a human acts. The card offers three exits as one split
 * button, Continue first:
 *
 *  - Continue re-queues the SAME step (`board.card.requeue-step`): its live
 *    thread is nudged, and a step with no thread gets a fresh one running the
 *    step's own prompt. In a review loop that is the phase the loop owes.
 *  - Restart supersedes it (`board.card.start-stage-thread`): the step is
 *    settled abandoned and the stage's executor plans again from its record,
 *    so a review loop starts its owed phase in a fresh thread.
 *  - Move to the next stage is the ordinary move, which settles the step.
 *
 * None of the three is gated on the card's thread state. That state is summed
 * over every linked thread, so a human talking to an earlier phase's thread
 * made the card read "in flight" and hid the only restart there was — while the
 * step that needed restarting had nothing running at all.
 */
import { boardNextStageId, type BoardStageDefinition, type BoardStageId } from "@t3tools/contracts";

import type { BoardReviewPhaseStatus } from "./boardReviewLoop";
import { boardStageLabelMidSentence } from "./boardCardThreadMenu";
import { boardStageLabel } from "./boardStages";

export interface BoardStepRecovery {
  readonly continueLabel: string;
  readonly restartLabel: string;
  /** Null on the last stage, where there is nowhere to move to. */
  readonly next: {
    readonly label: string;
    readonly toStage: BoardStageId;
    /** Shown, disabled, while dependencies block the card: the decider would
        refuse the move anyway. */
    readonly disabledReason: string | null;
  } | null;
}

export function resolveBoardStepRecovery(input: {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly stage: BoardStageId;
  readonly stalled: boolean;
  readonly archived: boolean;
  readonly blocked: boolean;
}): BoardStepRecovery | null {
  if (!input.stalled || input.archived) return null;
  const stage = boardStageLabelMidSentence(boardStageLabel(input.stages, input.stage));
  const nextStage = boardNextStageId(
    { cards: [], stages: input.stages, nextCardNumberByProject: {} },
    input.stage,
  );
  return {
    continueLabel: `Continue ${stage}`,
    restartLabel: `Restart ${stage}`,
    next:
      nextStage === null
        ? null
        : {
            label: `Move to ${boardStageLabel(input.stages, nextStage)}`,
            toStage: nextStage,
            disabledReason: input.blocked ? "Blocked by unmet dependencies" : null,
          },
  };
}

/** How the Review pane shows a phase — not always what the ledger walk says.
    The walk calls the owed phase `running` because it is next, but off the
    review stage nobody is in it (T3O-3), and when its step has stalled nothing
    is running it either (T3O-13). */
export function boardReviewPhaseShownStatus(
  status: BoardReviewPhaseStatus,
  context: { readonly offStage: boolean; readonly stalled: boolean },
): BoardReviewPhaseStatus | "stopped" {
  if (status !== "running") return status;
  if (context.offStage) return "pending";
  return context.stalled ? "stopped" : "running";
}
