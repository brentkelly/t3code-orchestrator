/**
 * The status a tab title names for the card or thread it shows (T3O-82). Derived from the same
 * face the board card wears, so the tab and the card can never disagree. Words are fixed, with
 * no clocks: a ticking title would churn the tab.
 */
import {
  BOARD_ATTENTION_SETTLE_MS,
  boardCardAttention,
  boardCardChildAttentionLabel,
  deriveBoardCardChildAttention,
  deriveBoardCardChildRunning,
  isBoardCardWorking,
  type BoardCardAttentionReason,
  type BoardCardChildAttention,
} from "@t3tools/contracts";

import type { SidebarThreadStatus } from "../../components/Sidebar.logic";
import { nextBoardAttentionSettleAt } from "../boardAttentionSettle";
import { boardCardFace } from "../boardCardFace";
import { boardCardNoPullRequest, type BoardCardNotice } from "../boardCardNotice";
import {
  boardCardReadyForMerge,
  type BoardCardNotificationObservation,
} from "../boardCardNotifications.logic";
import { createBoardCardObserver, type BoardCardObservationSources } from "../boardCardObservations";
import { boardCardSummary } from "../boardCardSummary";
import { boardCardStageGoneNotes } from "../boardProjectPipelines";

export interface TabStatus {
  readonly label: string;
  /** Violet or amber: someone has to act. Marked with a leading `*`. */
  readonly needsYou: boolean;
}

const needsYou = (label: string): TabStatus => ({ label, needsYou: true });
const WORKING: TabStatus = { label: "Working", needsYou: false };

/** Paused is the human's own instruction and takes no colour, so no status either. */
const ATTENTION_WORDS: Record<BoardCardAttentionReason, string | null> = {
  paused: null,
  stalled: "Stalled",
  approval: "Plan approval needed",
  "review-stuck": "Review needs your call",
  "review-held": "Review stopped",
  "ci-stopped": "CI needs you",
  held: "Needs a human",
  stopped: "Needs a human",
  input: "Input needed",
  permission: "Permission needed",
};

const fromReason = (reason: BoardCardAttentionReason): TabStatus | null => {
  const word = ATTENTION_WORDS[reason];
  return word === null ? null : needsYou(word);
};

/** A notice's status; `undefined` when the notice says nothing a title should carry. */
function fromNotice(
  notice: BoardCardNotice,
  inherited: BoardCardChildAttention | null,
): TabStatus | null | undefined {
  switch (notice.kind) {
    case "attention":
      if (notice.attention.tone === "neutral") return null;
      return inherited === null
        ? fromReason(notice.attention.reason)
        : needsYou(boardCardChildAttentionLabel(inherited));
    case "worker":
      return needsYou(notice.trouble.kind === "removed" ? "Worker removed" : "Worker offline");
    case "worker-move":
      return notice.move.status === "moving"
        ? { label: "Moving", needsYou: false }
        : needsYou("Move failed");
    case "conflicts":
      return needsYou("Conflicts");
    case "auto-merge":
      return needsYou(notice.pill.icon === "alert" ? "Merge needs you" : "Merge held");
    case "no-pull-request":
      return needsYou("No PR");
    case "blocked":
      return needsYou("Blocked");
    case "stage-gone":
      return needsYou("Stage removed");
    case "worktree-kept":
      return undefined;
  }
}

/**
 * One card's tab status: the ranked card-face notice first, then Ready for merge (the card
 * notifier's rule), then the working dot. Done, archived and hidden cards carry none.
 */
export function boardCardTabStatus(
  input: BoardCardNotificationObservation & {
    readonly childAttention: BoardCardChildAttention | null;
    readonly childRunning: number;
    readonly stageGone: string | null;
    readonly now: number;
  },
): TabStatus | null {
  const { card, now } = input;
  if (input.projectHidden || card.archivedAt != null) return null;
  const summary = boardCardSummary(card);
  if (summary.muted) return null;
  const withIdle =
    input.threadIdleSince === null ? card : { ...card, threadIdleSince: input.threadIdleSince };
  const atMergeStage = input.mergeStageId !== null && card.stage === input.mergeStageId;
  const { own, notice } = boardCardFace({
    card,
    summary,
    attention: boardCardAttention({ card: withIdle, stages: input.stages, now }),
    childAttention: input.childAttention,
    isGroup: input.isGroup,
    noPullRequest: boardCardNoPullRequest({
      atMergeStage,
      hasPr: card.hasPr,
      threadIdleSince: input.threadIdleSince,
      now,
    }),
    worktreeKeptReason: null,
    stageGone: input.stageGone,
    workers: input.workers,
    now,
  });
  // The round row hides a held or stuck review loop's chip; the card still wears its tone.
  if (
    own !== null &&
    (own.reason === "review-held" || own.reason === "review-stuck") &&
    (notice === null || notice.kind === "blocked")
  ) {
    return fromReason(own.reason);
  }
  if (notice !== null) {
    const status = fromNotice(notice, own === null ? input.childAttention : null);
    if (status !== undefined) return status;
  }
  const settling =
    input.threadIdleSince !== null &&
    now - Date.parse(input.threadIdleSince) < BOARD_ATTENTION_SETTLE_MS;
  if (
    boardCardReadyForMerge({
      card,
      atMergeStage,
      autoMergeArmed: input.autoMergeArmed,
      isGroup: input.isGroup,
      settling,
    })
  ) {
    return needsYou("Ready for merge");
  }
  if ((!input.isGroup && isBoardCardWorking(card)) || input.childRunning > 0) return WORKING;
  return null;
}

/**
 * The status of the one card a tab shows, from the board's sources narrowed to that card, its
 * ancestors (auto-merge inherits down them) and its children (plan progress, roll-ups). Also
 * when a settle grace ends and the answer can change, so the caller sets one timer.
 */
export function resolveCardTabStatus(
  input: BoardCardObservationSources & { readonly cardId: string; readonly now: number },
): { readonly status: TabStatus | null; readonly settleAt: number | null } {
  const byId = new Map(input.cards.map((card) => [String(card.cardId), card]));
  const target = byId.get(input.cardId);
  if (target === undefined) return { status: null, settleAt: null };
  const related = [target];
  const seen = new Set([input.cardId]);
  for (let parent = target.parentCardId; parent !== undefined; ) {
    const ancestor = byId.get(String(parent));
    if (ancestor === undefined || seen.has(String(parent))) break;
    seen.add(String(parent));
    related.push(ancestor);
    parent = ancestor.parentCardId;
  }
  const children = input.cards.filter((card) => String(card.parentCardId) === input.cardId);
  related.push(...children);

  const view = createBoardCardObserver()({ ...input, cards: related });
  const observation = view.observations[0];
  if (observation === undefined) return { status: null, settleAt: null };
  const liveChildren = view.cards
    .filter((card) => String(card.parentCardId) === input.cardId)
    .map((card) => {
      const threadIdleSince = view.idleByCard.get(String(card.cardId));
      return threadIdleSince === undefined ? card : { ...card, threadIdleSince };
    });
  const childAttention =
    deriveBoardCardChildAttention({
      cards: liveChildren,
      stages: view.stages,
      now: input.now,
    }).get(observation.card.cardId) ?? null;
  const childRunning =
    deriveBoardCardChildRunning({ cards: liveChildren }).get(observation.card.cardId) ?? 0;
  const stageGone = boardCardStageGoneNotes(
    { stages: view.stages, projectStageConfigs: input.projectStageConfigs, cards: related },
    () => "",
  )(observation.card);
  return {
    status: boardCardTabStatus({
      ...observation,
      childAttention,
      childRunning,
      stageGone,
      now: input.now,
    }),
    settleAt: nextBoardAttentionSettleAt(view.idleByCard.values(), input.now),
  };
}

const THREAD_STATUS: Record<SidebarThreadStatus, TabStatus | null> = {
  working: WORKING,
  preparing: WORKING,
  input: needsYou("Input needed"),
  approval: needsYou("Approval needed"),
  request: needsYou("Guest request"),
  failed: needsYou("Failed"),
  limited: needsYou("Usage limit"),
  waiting: null,
  ready: null,
};

/** A plain thread's tab status, in the sidebar's own words. */
export function threadTabStatus(status: SidebarThreadStatus): TabStatus | null {
  return THREAD_STATUS[status];
}
