/**
 * The ways out of a stalled step: Continue (re-queue the same step), Restart
 * (supersede it) or move on. None is gated on the card's thread state, which
 * sums every linked thread and would hide the restart.
 */
import type { BoardStageDefinition, BoardStageId } from "@t3tools/contracts";

import type { BoardReviewPhaseStatus } from "./boardReviewLoop";
import { boardStageLabelMidSentence } from "./boardCardThreadMenu";
import { boardCiAwareNextStageId } from "./boardStageActions";
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
  /** False on a group card: its stage is derived from its children, so a hand
      move is not a way out. */
  readonly handMoves?: boolean;
  /** The card has a live CI entry: it leaves CI by passing or by
      Skip CI, never by a move. */
  readonly ciEntryLive?: boolean;
}): BoardStepRecovery | null {
  if (!input.stalled || input.archived) return null;
  const stage = boardStageLabelMidSentence(boardStageLabel(input.stages, input.stage));
  // The list is the card's own pipeline, so this walks into CI, never past it.
  const nextStage = boardCiAwareNextStageId(input.stages, input.stage, input.ciEntryLive === true);
  return {
    continueLabel: `Continue ${stage}`,
    restartLabel: `Restart ${stage}`,
    next:
      nextStage === null || input.handMoves === false
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
    review stage nobody is in it, and when its step has stalled nothing
    is running it either. */
export function boardReviewPhaseShownStatus(
  status: BoardReviewPhaseStatus,
  context: { readonly offStage: boolean; readonly stalled: boolean },
): BoardReviewPhaseStatus | "stopped" {
  if (status !== "running") return status;
  if (context.offStage) return "pending";
  return context.stalled ? "stopped" : "running";
}

/** Whether the Review pane shows the owed phase as stopped. A waiting stall
    (usage limit, retry backoff) is one the board resumes by itself, and its
    banner says so; calling it stopped beside that banner contradicts it. */
export function boardReviewPaneStopped(stepFailure: { readonly waiting: boolean } | null): boolean {
  return stepFailure !== null && !stepFailure.waiting;
}

/** Whether the ordinary forward move renders beside the recovery button: not
    when the recovery caret offers the same move. A forward button with its own
    caret stays; Merge is never a duplicate. */
export function boardForwardShownBesideRecovery(
  forward: { readonly kind: "move"; readonly toStage: BoardStageId } | { readonly kind: "merge" },
  recovery: BoardStepRecovery | null,
  hasSecondary: boolean,
): boolean {
  if (recovery === null || hasSecondary || forward.kind !== "move") return true;
  return recovery.next?.toStage !== forward.toStage;
}
