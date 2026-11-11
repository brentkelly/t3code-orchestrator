/**
 * T3o: which card waits raise a notification, and when. Classified from the
 * card face (`boardCardFace`), so an alert never disagrees with the card's
 * colour. Pure: the coordinator passes `now` and every resolved input.
 */
import {
  BOARD_ATTENTION_SETTLE_MS,
  boardCardAttention,
  isBoardCardCiActive,
  isBoardCardWorking,
} from "@t3tools/contracts";
import type {
  BoardCardAttentionReason,
  BoardCardId,
  BoardCardShell,
  BoardCardStepStalledReason,
  BoardNotificationSettings,
  BoardStageDefinition,
  BoardWorkersState,
} from "@t3tools/contracts";

import type { SidebarThreadStatus } from "../components/Sidebar.logic";
import { boardCardFace } from "./boardCardFace";
import { boardCardNoPullRequest } from "./boardCardNotice";
import { boardCardSummary } from "./boardCardSummary";

export type BoardCardNotificationCategory = "waiting" | "needsHuman" | "readyForMerge" | "blocked";

export interface BoardCardNotificationReason {
  readonly category: BoardCardNotificationCategory;
  /** What the card waits on, e.g. `input`, `held`, `no-pr`, `merge-gave-up`, `ready`. */
  readonly reason: BoardCardAttentionReason | "no-pr" | "merge-gave-up" | "ready" | "blocked";
  /** `category:reason:stage`. Never the label: labels carry clocks. */
  readonly key: string;
  readonly title: string;
}

export interface BoardCardNotificationInput {
  /** The live shell, with client-derived plan progress already applied. */
  readonly card: BoardCardShell;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly mergeStageId: string | null;
  /** Effective auto-merge (`boardShellAutoMergeArmedByCard`). */
  readonly autoMergeArmed: boolean;
  /** A group or split parent with children: its roll-up is the child's wait. */
  readonly isGroup: boolean;
  readonly projectHidden: boolean;
  readonly workers: BoardWorkersState;
}

/** Stalls the board ends by itself never notify; the rest need a human. */
const HUMAN_STALLS: ReadonlySet<BoardCardStepStalledReason> = new Set([
  "gave-up",
  "no-worktree",
  "provider-not-on-worker",
  "worker-removed",
]);

const WAITING_REASONS: ReadonlySet<BoardCardAttentionReason> = new Set([
  "approval",
  "input",
  "permission",
  "review-stuck",
  "ci-stopped",
]);

const TITLES: Record<BoardCardNotificationReason["reason"], string> = {
  approval: "Plan approval needed",
  input: "Input needed",
  permission: "Permission needed",
  "review-stuck": "Review needs your call",
  "ci-stopped": "CI needs you",
  held: "Needs a human",
  stopped: "Needs a human",
  "review-held": "Review stopped",
  stalled: "Stalled: needs a human",
  paused: "Paused",
  "no-pr": "No pull request at merge",
  "merge-gave-up": "Merge needs you",
  ready: "Ready for merge",
  blocked: "Blocked",
};

function reasonOf(
  category: BoardCardNotificationCategory,
  reason: BoardCardNotificationReason["reason"],
  stage: string,
): BoardCardNotificationReason {
  return { category, reason, key: `${category}:${reason}:${stage}`, title: TITLES[reason] };
}

function attentionCategory(
  reason: BoardCardAttentionReason,
  stalledReason: BoardCardStepStalledReason | undefined,
): BoardCardNotificationCategory | null {
  if (WAITING_REASONS.has(reason)) return "waiting";
  if (reason === "held" || reason === "stopped" || reason === "review-held") return "needsHuman";
  if (reason === "stalled" && HUMAN_STALLS.has(stalledReason ?? "gave-up")) return "needsHuman";
  return null;
}

/**
 * Why a card waits on a human right now, or null. `threadIdleSince` drives the
 * same settle grace the card face waits out.
 */
export function boardCardNotificationReason(
  input: BoardCardNotificationInput & {
    readonly threadIdleSince: string | null;
    readonly now: number;
  },
): BoardCardNotificationReason | null {
  const { card, now } = input;
  if (input.projectHidden || card.archivedAt != null) return null;
  const withIdle =
    input.threadIdleSince === null ? card : { ...card, threadIdleSince: input.threadIdleSince };
  const attention = boardCardAttention({ card: withIdle, stages: input.stages, now });
  const atMergeStage = input.mergeStageId !== null && card.stage === input.mergeStageId;
  const settling =
    input.threadIdleSince !== null &&
    now - Date.parse(input.threadIdleSince) < BOARD_ATTENTION_SETTLE_MS;
  const face = boardCardFace({
    card,
    summary: boardCardSummary(card),
    attention,
    // A parent's roll-up is its child's wait; only the child notifies.
    childAttention: null,
    isGroup: input.isGroup,
    noPullRequest: boardCardNoPullRequest({
      atMergeStage,
      hasPr: card.hasPr,
      threadIdleSince: input.threadIdleSince,
      now,
    }),
    // Both rank below every notice that notifies, so they never change the answer.
    worktreeKeptReason: null,
    stageGone: null,
    workers: input.workers,
    now,
  });
  const { own, notice } = face;
  // The round row hides a held or stuck review loop's chip; the card still wears its tone.
  if (
    own !== null &&
    (own.reason === "review-held" || own.reason === "review-stuck") &&
    (notice === null || notice.kind === "blocked")
  ) {
    return reasonOf(
      own.reason === "review-stuck" ? "waiting" : "needsHuman",
      own.reason,
      card.stage,
    );
  }
  if (notice !== null) {
    switch (notice.kind) {
      case "attention": {
        const category = attentionCategory(notice.attention.reason, card.stalledReason);
        return category === null ? null : reasonOf(category, notice.attention.reason, card.stage);
      }
      case "auto-merge":
        return notice.pill.icon === "alert"
          ? reasonOf("needsHuman", "merge-gave-up", card.stage)
          : null;
      case "no-pull-request":
        return reasonOf("needsHuman", "no-pr", card.stage);
      case "blocked":
        return reasonOf("blocked", "blocked", card.stage);
      default:
        // Conflicts, worker trouble, moves, a removed stage: the board is on it,
        // or the card's own panel says what to do.
        return null;
    }
  }
  if (
    atMergeStage &&
    card.hasPr &&
    !input.autoMergeArmed &&
    !input.isGroup &&
    !isBoardCardWorking(card) &&
    !card.stepRunning &&
    !card.queued &&
    !isBoardCardCiActive(card) &&
    !settling
  ) {
    return reasonOf("readyForMerge", "ready", card.stage);
  }
  return null;
}

const CATEGORY_SETTING: Record<
  BoardCardNotificationCategory,
  keyof Omit<BoardNotificationSettings, "enabled" | "muteRoutineThreadAlerts">
> = {
  waiting: "waiting",
  needsHuman: "needsHuman",
  readyForMerge: "readyForMerge",
  blocked: "blocked",
};

function isBoardCardNotificationCategoryOn(
  settings: BoardNotificationSettings,
  category: BoardCardNotificationCategory,
): boolean {
  return settings.enabled && settings[CATEGORY_SETTING[category]];
}

function anyBoardCardNotificationOn(settings: BoardNotificationSettings): boolean {
  return (
    settings.enabled &&
    (settings.waiting || settings.needsHuman || settings.readyForMerge || settings.blocked)
  );
}

/** Whether the notifier must watch the board: to alert, or to keep the routine mute current. */
export function boardCardNotifierNeeded(settings: BoardNotificationSettings): boolean {
  return (
    anyBoardCardNotificationOn(settings) || (settings.enabled && settings.muteRoutineThreadAlerts)
  );
}

export interface BoardCardNotificationObservation extends BoardCardNotificationInput {
  /** When the card's active thread last finished a turn, if the board's shell knows. */
  readonly threadIdleSince: string | null;
}

export interface BoardCardNotificationFiring {
  readonly card: BoardCardShell;
  readonly reason: BoardCardNotificationReason;
}

interface CardMemory {
  readonly key: string | null;
  /** The card's raw (graceless) key and when the notifier first saw it. */
  readonly firstSeenKey: string | null;
  readonly firstSeenAt: number;
  /** A No PR or Ready for merge alert already fired on this merge-stage visit. */
  readonly mergeVisitAlerted: boolean;
  readonly cache: {
    readonly input: BoardCardNotificationObservation;
    readonly idle: string | null;
    /** When it was computed: a reason computed inside the grace is stale once it ends. */
    readonly at: number;
    readonly reason: BoardCardNotificationReason | null;
  } | null;
}

const isMergeVisitReason = (reason: BoardCardNotificationReason | null) =>
  reason !== null && (reason.reason === "no-pr" || reason.reason === "ready");

/**
 * Turns per-card reasons into alerts. The first evaluation after `reset` is a
 * silent baseline. A key that changes to a new non-null value fires; one that
 * goes null or changes is reported cleared so its alerts close.
 */
export function createBoardCardNotificationGate() {
  let memory = new Map<BoardCardId, CardMemory>();
  let baseline = true;

  const sameInput = (a: BoardCardNotificationObservation, b: BoardCardNotificationObservation) =>
    a.card === b.card &&
    a.stages === b.stages &&
    a.mergeStageId === b.mergeStageId &&
    a.autoMergeArmed === b.autoMergeArmed &&
    a.isGroup === b.isGroup &&
    a.projectHidden === b.projectHidden &&
    a.workers === b.workers &&
    a.threadIdleSince === b.threadIdleSince;

  return {
    /** The next evaluation re-baselines: a new subscription or another board server. */
    reset(): void {
      memory = new Map();
      baseline = true;
    },
    evaluate(input: {
      readonly cards: ReadonlyArray<BoardCardNotificationObservation>;
      readonly settings: BoardNotificationSettings;
      readonly now: number;
    }): {
      readonly fire: ReadonlyArray<BoardCardNotificationFiring>;
      readonly cleared: ReadonlyArray<BoardCardId>;
      /** When a settle grace next expires; re-evaluate then. */
      readonly wakeAt: number | null;
    } {
      const { now } = input;
      const silent = baseline;
      baseline = false;
      const next = new Map<BoardCardId, CardMemory>();
      const fire: Array<BoardCardNotificationFiring> = [];
      const cleared: Array<BoardCardId> = [];
      let wakeAt: number | null = null;
      const wakeFor = (iso: string | null) => {
        if (iso === null) return;
        const at = Date.parse(iso) + BOARD_ATTENTION_SETTLE_MS;
        if (Number.isFinite(at) && at > now && (wakeAt === null || at < wakeAt)) wakeAt = at;
      };
      for (const observation of input.cards) {
        const { card } = observation;
        const prior = memory.get(card.cardId);
        // Worker-hosted threads are not in the board's shell, so they have no idle
        // time; the moment this notifier first saw the wait is the only settle guard.
        let firstSeenKey = prior?.firstSeenKey ?? null;
        let firstSeenAt = prior?.firstSeenAt ?? now;
        let idle = observation.threadIdleSince;
        if (idle === null) {
          const raw = boardCardNotificationReason({ ...observation, threadIdleSince: null, now });
          const rawKey = raw?.key ?? null;
          if (rawKey !== firstSeenKey) {
            firstSeenKey = rawKey;
            firstSeenAt = now;
          }
          // The baseline accepts what is already there rather than waiting it out.
          idle = rawKey === null || silent ? null : new Date(firstSeenAt).toISOString();
        }
        const cached = prior?.cache;
        const reusable =
          cached != null &&
          cached.idle === idle &&
          sameInput(cached.input, observation) &&
          (idle === null || cached.at - Date.parse(idle) >= BOARD_ATTENTION_SETTLE_MS);
        const reason = reusable
          ? cached.reason
          : boardCardNotificationReason({ ...observation, threadIdleSince: idle, now });
        wakeFor(idle);
        const key = reason?.key ?? null;
        const atMergeStage =
          observation.mergeStageId !== null && card.stage === observation.mergeStageId;
        let mergeVisitAlerted = atMergeStage && (prior?.mergeVisitAlerted ?? false);
        const priorKey = prior?.key ?? null;
        if (priorKey !== null && priorKey !== key) cleared.push(card.cardId);
        if (silent || prior === undefined) {
          if (isMergeVisitReason(reason)) mergeVisitAlerted = true;
        } else if (reason !== null && key !== priorKey) {
          const suppressed = isMergeVisitReason(reason) && mergeVisitAlerted;
          if (!suppressed && isBoardCardNotificationCategoryOn(input.settings, reason.category)) {
            fire.push({ card, reason });
            // Only a raised alert spends the visit, so a muted No PR leaves Ready for merge.
            if (isMergeVisitReason(reason)) mergeVisitAlerted = true;
          }
        }
        next.set(card.cardId, {
          key,
          firstSeenKey,
          firstSeenAt,
          mergeVisitAlerted,
          cache: reusable ? cached : { input: observation, idle, at: now, reason },
        });
      }
      for (const [cardId, prior] of memory) {
        if (!next.has(cardId) && prior.key !== null) cleared.push(cardId);
      }
      memory = next;
      return { fire, cleared, wakeAt };
    },
  };
}

/** A card thread's upstream alert state, as upstream's coordinator would read it. */
export interface BoardCardThreadAlertState {
  /** `resolveSidebarThreadStatus`, with upstream's ready-and-failed promotion. */
  readonly status: SidebarThreadStatus;
  readonly archived: boolean;
  /** The card's `activeThreadId`: the only thread whose failure can be this wait's cause. */
  readonly active: boolean;
  /** Upstream skips it: delegated under a parent, or hidden by a tag filter. */
  readonly upstreamSkips: boolean;
}

/**
 * Whether the card's own thread already raised an upstream alert for this
 * same wait, so the card stays quiet. A question the board parked
 * (`stepAwaiting: "question"`) has no live prompt, so it always alerts.
 */
export function boardCardWaitAlreadyAlerted(input: {
  readonly reason: BoardCardNotificationReason;
  readonly card: Pick<BoardCardShell, "awaitingInput" | "stepAwaiting">;
  /** The card's live threads that the board environment's shell holds. */
  readonly threads: ReadonlyArray<BoardCardThreadAlertState>;
  readonly upstreamAlertsOn: boolean;
  readonly boardConnected: boolean;
}): boolean {
  if (!input.upstreamAlertsOn || !input.boardConnected) return false;
  const matches = (test: (thread: BoardCardThreadAlertState) => boolean) =>
    input.threads.some((thread) => !thread.upstreamSkips && test(thread));
  switch (input.reason.reason) {
    case "input":
      if (!input.card.awaitingInput) return false;
      return matches((thread) => thread.status === "input" || thread.status === "request");
    case "permission":
      return matches((thread) => thread.status === "approval");
    case "held":
    case "stopped":
      // A failed status sticks until that thread runs again, so an earlier stage's
      // failed thread says nothing about this wait.
      return matches((thread) => thread.active && thread.status === "failed" && !thread.archived);
    default:
      return false;
  }
}
