/**
 * T3o: the automation gate-due model (T3O-115). One pure question per card — "which gate is due
 * for this card now?" — asked by the event that put the card at a gate (speed) and by the 30s
 * tick and the boot pass (certainty). Both read this predicate, so they cannot disagree, and a
 * gate already acted on is never due again. No I/O.
 */
import {
  boardCardAutoMergeArmed,
  boardCardInheritedDependsOn,
  boardCardStepThisStay,
  boardNextStageId,
  boardProjectStageConfig,
  boardStageBeforeBuild,
  boardStageById,
  boardStageWithRole,
  boardStages,
  effectiveBoardStageRole,
  isBoardCardPullRequestTerminal,
  isBoardMergeStageExecution,
  isBoardPlanReviewRunning,
  isBoardTerminalStepStatus,
  isLiveBoardCardThreadLink,
  resolveBoardCardAutomation,
  resolveBoardCardPlanReview,
  resolveBoardStageExecution,
  unmetBoardCardDependencies,
  type BoardCard,
  type BoardCardPlanReview,
  type BoardGate,
  type BoardCardStepState,
  type BoardPlan,
  type BoardResolvedAutomation,
  type BoardSettings,
  type BoardState,
} from "./board.ts";
import { boardCardGroupOf } from "./boardGroups.ts";

export type BoardGateDue = { readonly gate: BoardGate } | null;

/** How many questions the board answers on one planning step before the next waits for a person. */
export const BOARD_AUTO_ANSWER_LIMIT = 3;

/** The lookups one sweep pass builds once, so evaluating every card stays linear. */
export interface BoardGateIndex {
  readonly cardsById: ReadonlyMap<string, BoardCard>;
  readonly stepByCard: ReadonlyMap<string, BoardCardStepState>;
  readonly plansByCard: ReadonlyMap<string, ReadonlyArray<BoardPlan>>;
  readonly liveChildCount: ReadonlyMap<string, number>;
}

export function boardGateIndex(board: BoardState): BoardGateIndex {
  const cardsById = new Map<string, BoardCard>();
  const liveChildCount = new Map<string, number>();
  for (const card of board.cards) {
    cardsById.set(String(card.id), card);
    if (card.parentCardId !== null && card.archivedAt === null) {
      const parent = String(card.parentCardId);
      liveChildCount.set(parent, (liveChildCount.get(parent) ?? 0) + 1);
    }
  }
  const stepByCard = new Map<string, BoardCardStepState>();
  for (const state of board.stepStates ?? []) {
    if (!stepByCard.has(String(state.cardId))) stepByCard.set(String(state.cardId), state);
  }
  const plansByCard = new Map<string, Array<BoardPlan>>();
  for (const plan of board.plans ?? []) {
    const list = plansByCard.get(String(plan.cardId));
    if (list === undefined) plansByCard.set(String(plan.cardId), [plan]);
    else list.push(plan);
  }
  return { cardsById, stepByCard, plansByCard, liveChildCount };
}

export interface BoardGateInput {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly settings: BoardSettings;
  /** Whether the board cannot reach a worker now; a card bound to one has no gate due. */
  readonly workerUnreachable?: ((workerId: string) => boolean) | undefined;
  /** Prebuilt lookups for a whole-board pass; built on demand otherwise. */
  readonly index?: BoardGateIndex | undefined;
  /** The current time, for the merge gate's retry rung. Omitted, a pending rung is never due. */
  readonly nowMs?: number | undefined;
}

/** The facts every gate reads, resolved once per card. */
export interface BoardGateFacts {
  readonly automation: BoardResolvedAutomation;
  readonly planReview: BoardCardPlanReview;
  /** The card's step row for its current stay, or null. */
  readonly stay: BoardCardStepState | null;
  readonly plans: ReadonlyArray<BoardPlan>;
}

/** The card's effective automation, plan review and current-stay step. */
export function boardGateFacts(input: BoardGateInput): BoardGateFacts {
  const { board, card, settings } = input;
  const index = input.index ?? boardGateIndex(board);
  const automation = resolveBoardCardAutomation({
    stages: boardStages(board),
    lookup: (id) => {
      const node = index.cardsById.get(id);
      // A split parent from before groups reads as the group the migrations backfilled.
      if (node === undefined || node.group !== null || !index.liveChildCount.has(id)) return node;
      return { ...node, group: boardCardGroupOf(board, node) };
    },
    card,
    boardWideAutoMerge: false,
  });
  const execution = resolveBoardStageExecution(
    settings,
    card.stage,
    boardProjectStageConfig(board, card.projectId),
  );
  const planReview = resolveBoardCardPlanReview(
    card,
    execution.kind === "simple" ? execution : null,
  );
  return {
    automation,
    planReview,
    stay: boardCardStepThisStay(index.stepByCard.get(String(card.id)) ?? null, card),
    plans: index.plansByCard.get(String(card.id)) ?? [],
  };
}

/**
 * The gate due for this card now, in pipeline order, or null. At most one per card. A gate
 * that has been acted on is not due: the act moves the card or writes a step row for its stay.
 */
export function boardGateDue(input: BoardGateInput): BoardGateDue {
  const { board, card } = input;
  if (card.archivedAt !== null || card.group !== null) return null;
  const index = input.index ?? boardGateIndex(board);
  const hasChildren = (index.liveChildCount.get(String(card.id)) ?? 0) > 0;
  const bound = card.placedWorkerId ?? card.pinnedWorkerId;
  if (bound !== null && input.workerUnreachable?.(String(bound)) === true) return null;
  const stage = boardStageById(board, card.stage);
  if (stage === null) return null;
  const role = effectiveBoardStageRole(stage);
  if (role === "merge") return boardMergeGateDue(input, index);
  const before = boardStageBeforeBuild(board);
  if (role !== "plan" && card.stage !== before?.stageId) return null;
  const facts = boardGateFacts({ ...input, index });
  const { automation, planReview, stay, plans } = facts;

  if (role === "plan") {
    // A split parent's plans are frozen: nothing left to plan or sign off.
    if (hasChildren) return null;
    if (stay === null) {
      // Never run this stay. A pending split already planned; it waits at its own gate.
      return automation.autoPlan.value && plans.length < 2 ? { gate: "plan" } : null;
    }
    if (stay.status === "awaiting-input") {
      // A question (or a blocked completion) on an unattended run: the board answers it, once per
      // wait and at most `BOARD_AUTO_ANSWER_LIMIT` times a step. A Stop is a person's.
      // An unattended review counts only while it runs on this step; before it starts the
      // questions are the attended planning run's.
      const unattended =
        automation.autoPlan.value ||
        (planReview.enabled && planReview.unattended === true && isBoardPlanReviewRunning(stay));
      // Parking clears the mark, so it is present only once this wait was answered.
      const answeredThisWait = stay.autoAnsweredAt !== undefined;
      return unattended &&
        stay.awaitingReason === "question" &&
        stay.threadId !== null &&
        !answeredThisWait &&
        (stay.autoAnswers ?? 0) < BOARD_AUTO_ANSWER_LIMIT
        ? { gate: "answer" }
        : null;
    }
    if (stay.status !== "succeeded") return null;
    const reviewStarted = stay.planReviewStartedAt !== undefined;
    if (
      planReview.enabled &&
      !reviewStarted &&
      plans.length > 0 &&
      card.pendingSplitApproval === undefined &&
      (automation.autoPlan.value || planReview.unattended === true || automation.autoSignOff.value)
    ) {
      return { gate: "review-start" };
    }
    if (card.pendingSplitApproval !== undefined) return { gate: "split" };
    const reviewFinished = !planReview.enabled || reviewStarted;
    if (!automation.autoSignOff.value || !reviewFinished) return null;
    if (plans.length === 1) {
      return boardNextStageId(board, card.stage, card.projectId) === null
        ? null
        : { gate: "sign-off" };
    }
    if (plans.length >= 2 && before !== null) return { gate: "split-sign-off" };
    return null;
  }

  // The stage before build. A scheduled start holds the step there, not the gate.
  if (!automation.autoBuild.value) return null;
  // A pending split waits for its approval, never builds as one card.
  if (plans.length >= 2 && !hasChildren) return null;
  const unmet = unmetBoardCardDependencies({
    board,
    dependsOn: boardCardInheritedDependsOn(board, card),
    cards: board.cards,
  });
  return unmet.length === 0 ? { gate: "build" } : null;
}

/** Whether this card's merge runs itself: its own toggle, its group's, or the board-wide setting. */
export function boardCardAutoMergeOn(input: {
  readonly board: BoardState;
  readonly card: BoardCard;
  readonly settings: BoardSettings;
}): boolean {
  const { board, card, settings } = input;
  const mergeStage = boardStageWithRole(board, "merge");
  if (mergeStage === null) return false;
  const exec = resolveBoardStageExecution(
    settings,
    mergeStage.stageId,
    boardProjectStageConfig(board, card.projectId),
  );
  return boardCardAutoMergeArmed({
    board,
    card,
    boardWide: isBoardMergeStageExecution(exec) ? exec.autoMerge : false,
  });
}

/**
 * The merge gates (T3O-116), on a card in Ready for merge. merged-done first: a pull request
 * already merged (cached state, kept current by the merge-stage refresh) moves the card on and is
 * never merged again. Then merge: Auto-merge on, not blocked, nothing running on the stage, and no
 * hold that still applies. A hard hold applies until a human or someone else's push revives it,
 * except a no-pull-request stop, which a linked pull request clears. A soft hold waits its rung.
 */
function boardMergeGateDue(input: BoardGateInput, index: BoardGateIndex): BoardGateDue {
  const { board, card } = input;
  const pullRequest = card.pullRequest;
  if (isBoardCardPullRequestTerminal(pullRequest)) {
    return boardNextStageId(board, card.stage, card.projectId) === null
      ? null
      : { gate: "merged-done" };
  }
  if (card.blocked) return null;
  if ((index.liveChildCount.get(String(card.id)) ?? 0) > 0) return null;
  if (!boardCardAutoMergeOn(input)) return null;
  const step = index.stepByCard.get(String(card.id)) ?? null;
  if (step !== null && !isBoardTerminalStepStatus(step.status)) return null;
  if (card.threadLinks.some((link) => link.role === card.stage && isLiveBoardCardThreadLink(link))) {
    return null;
  }
  const hold = card.autoMergeHold;
  if (hold !== null) {
    if (hold.retryAt === null) {
      const cleared = hold.stop === "no-pull-request" && pullRequest !== null;
      if (!cleared) return null;
    } else {
      const dueMs = Date.parse(hold.retryAt);
      if (input.nowMs === undefined || !Number.isFinite(dueMs) || input.nowMs < dueMs) return null;
    }
  }
  // A card with no pull request is attempted too: the attempt records the hold that says so.
  return { gate: "merge" };
}
