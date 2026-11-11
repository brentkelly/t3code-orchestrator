/**
 * A card face's tone and its one header notice, from resolved values. The card
 * and the card notifier both call it, so an alert can never disagree with the
 * colour the card wears.
 */
import { boardCardChildAttentionLabel, isBoardReviewLoopHeld } from "@t3tools/contracts";
import type {
  BoardCardAttention,
  BoardCardAttentionTone,
  BoardCardChildAttention,
  BoardCardShell,
  BoardWorkersState,
} from "@t3tools/contracts";

import { boardAutoMergePill } from "./boardAutoMergeHold";
import { boardCardNotice, boardCardProviderStalled, type BoardCardNotice } from "./boardCardNotice";
import type { BoardCardSummary } from "./boardCardSummary";
import { boardConflictFix } from "./boardConflictFix";
import { boardCardMoveNotice, boardCardWorkerTrouble } from "./workers/cardWorker";

export interface BoardCardFace {
  /** The card's own attention, before the round row or the notice ranking hid it. */
  readonly own: BoardCardAttention | null;
  readonly tone: BoardCardAttentionTone | null;
  readonly notice: BoardCardNotice | null;
}

export function boardCardFace(input: {
  readonly card: BoardCardShell;
  readonly summary: BoardCardSummary;
  readonly attention: BoardCardAttention | null;
  readonly childAttention: BoardCardChildAttention | null;
  readonly isGroup: boolean;
  /** Already past the settle grace (`boardCardNoPullRequest`). */
  readonly noPullRequest: boolean;
  readonly worktreeKeptReason: string | null | undefined;
  readonly stageGone: string | null | undefined;
  readonly workers: BoardWorkersState;
  readonly now: number;
  /** Drop the worker, move and conflicts notices to see the wait they outrank. */
  readonly withoutQuietNotices?: boolean;
}): BoardCardFace {
  const quiet = input.isGroup || input.withoutQuietNotices === true;
  const { card, summary, isGroup } = input;
  // A parent with no problem of its own inherits its worst child's tone: it
  // cannot advance while a child is stuck. A muted Done card or a group takes
  // no tone.
  const own = summary.muted || isGroup ? null : input.attention;
  const inherited = summary.muted || isGroup || own !== null ? null : input.childAttention;
  const flag = own ?? inherited;
  // A held review loop's round row already says why, so skip the chip — keyed
  // on the row actually rendering, since it is stage-conditional.
  const roundRowExplainsIt = summary.items.some(
    (item) =>
      item.kind === "round" && item.outcome !== undefined && isBoardReviewLoopHeld(item.outcome),
  );
  const chip =
    flag === null ||
    (own !== null &&
      (own.reason === "review-held" || own.reason === "review-stuck") &&
      roundRowExplainsIt)
      ? null
      : {
          reason: flag.reason,
          tone: flag.tone,
          label: inherited === null ? flag.label : boardCardChildAttentionLabel(inherited),
          tooltip: inherited === null ? flag.detail : `A child of this card: ${inherited.detail}`,
        };
  // A Done card is muted and asking for nothing, so it never wears the
  // conflicts pill.
  const conflictFix = summary.muted
    ? null
    : boardConflictFix({
        live: card.stepConflictFix,
        checks: card.stepChecksFix,
        queued: card.queued,
      });
  const autoMergeHold = boardAutoMergePill({
    heldSince: card.autoMergeHeldSince,
    gaveUp: card.autoMergeGaveUp,
    done: summary.muted,
    nowMs: input.now,
  });
  // ONE notice for the whole header. A group keeps only its own dependency
  // gate; its children's states are in its stats.
  const notice = boardCardNotice({
    attention: isGroup ? null : chip,
    conflictFix: quiet ? null : conflictFix,
    autoMergeHold: isGroup ? null : autoMergeHold,
    // T3o: a Done card is asking for nothing, whatever a stale prop says.
    noPullRequestAtMerge: !isGroup && input.noPullRequest && !summary.muted,
    blocked: card.blocked,
    dependencyCount: card.dependencyCount,
    worktreeKeptReason: isGroup ? null : input.worktreeKeptReason,
    stageGone: isGroup ? null : input.stageGone,
    workerMove: quiet ? null : boardCardMoveNotice(card, input.workers),
    workerTrouble: quiet ? null : boardCardWorkerTrouble(card, input.workers),
    providerMissing: !isGroup && boardCardProviderStalled(card),
  });
  return { own, tone: flag?.tone ?? null, notice };
}
