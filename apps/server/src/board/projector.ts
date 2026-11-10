/**
 * Board events onto the in-memory read model, and onto card shell deltas. Every
 * payload carries the whole post-change card, so no re-read is needed. Archived
 * cards stay in the model for unarchive; deleted cards leave it, but the key
 * counter never rolls back.
 */
import {
  BOARD_CARD_BRIEF_BODY_KIND,
  boardSplitChildPlanCopy,
  BoardCardArchivedPayload,
  boardCardCreatedDependsOn,
  boardCardCreatedLabels,
  BoardCardCreatedPayload,
  BoardCardDeletedPayload,
  BoardCardMovedPayload,
  BoardCardProjectChangedPayload,
  BoardCardReorderedPayload,
  BoardCardStepCompletedPayload,
  BoardCardThreadLinkedPayload,
  BoardCardAttachedPayload,
  BoardCardDetachedPayload,
  BoardCardThreadUnlinkedPayload,
  BoardCardUnarchivedPayload,
  BoardCardWorktreeFailedPayload,
  BoardCardWorktreeProvisioningPayload,
  BoardCardWorktreeReadyPayload,
  BoardCardWorktreeReclaimedPayload,
  BoardCardAutoMergeHoldRecordedPayload,
  BoardCardCiRecordedPayload,
  BoardCardPullRequestRecordedPayload,
  BoardCardStepSelectedPayload,
  BoardCardStepAdmittedPayload,
  BoardCardStepAwaitingInputPayload,
  BoardCardStepForceStartRequestedPayload,
  BoardCardStepPausedPayload,
  BoardCardStepRecoveredPayload,
  BoardCardStepSettledPayload,
  BoardCardStepRetunedPayload,
  BoardCardStepSteeredPayload,
  BoardCardStepCheckedInPayload,
  BoardDefaultWorkerSetPayload,
  BoardWorkerRegisteredPayload,
  BoardWorkerRemovedPayload,
  BOARD_LOCAL_WORKER_ID,
  compareBoardWorkers,
  type BoardWorker,
  type BoardWorkerId,
  type EnvironmentId,
  BoardCardStageThreadRequestedPayload,
  BoardCardUpdatedPayload,
  boardBriefHasImage,
  boardCardShellFromCard,
  boardLabelCatalogue,
  BoardLabelCreatedPayload,
  BoardLabelDeletedPayload,
  BoardLabelUndeletedPayload,
  BoardLabelUpdatedPayload,
  BoardPlansApprovedPayload,
  BoardPlansProposedPayload,
  BoardPlanReviewStartedPayload,
  BoardPlanReviewStoppedPayload,
  BoardPlanReviewRoundsChangedPayload,
  BoardCardBaseRefRecordedPayload,
  BoardCardPlacedPayload,
  BoardCardWorkerMoveRecordedPayload,
  BoardCardWorkerPinnedPayload,
  BoardCardWorkerRemovalPayload,
  BoardCardIntegrationBranchRecordedPayload,
  BoardPlanWrittenPayload,
  BoardStageCreatedPayload,
  BoardStageDeletedPayload,
  BoardProjectStageConfigSetPayload,
  type BoardProjectStageConfig,
  BoardStageRenamedPayload,
  BoardStageReorderedPayload,
  boardAllStages,
  boardProjectStageConfigShell,
  boardStepParkedReason,
  compareBoardLabels,
  compareBoardStages,
  EMPTY_BOARD_STATE,
  isBoardConflictFixLive,
  isBoardChecksFixLive,
  type BoardCard,
  type BoardCardId,
  type BoardCardStepState,
  type BoardLabel,
  type BoardPlan,
  type BoardStageDefinition,
  type BoardStepCompletion,
  type BoardState,
  type BoardEvent,
  type ProjectId,
  type BoardShellStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { toBoardProjectorDecodeError, type BoardProjectorDecodeError } from "./errors.ts";

export type { BoardEvent };

/** The board-only read model the decider and in-memory projector run on
    (T3O-56): the board slice, absent until the first board event. */
export interface BoardReadModel {
  readonly board?: BoardState | undefined;
}

const decodeBoardCardCreatedPayload = Schema.decodeUnknownEffect(BoardCardCreatedPayload);
const decodeBoardCardMovedPayload = Schema.decodeUnknownEffect(BoardCardMovedPayload);
const decodeBoardCardProjectChangedPayload = Schema.decodeUnknownEffect(
  BoardCardProjectChangedPayload,
);
const decodeBoardCardReorderedPayload = Schema.decodeUnknownEffect(BoardCardReorderedPayload);
const decodeBoardCardUpdatedPayload = Schema.decodeUnknownEffect(BoardCardUpdatedPayload);
const decodeBoardCardThreadLinkedPayload = Schema.decodeUnknownEffect(BoardCardThreadLinkedPayload);
const decodeBoardCardThreadUnlinkedPayload = Schema.decodeUnknownEffect(
  BoardCardThreadUnlinkedPayload,
);
const decodeBoardCardAttachedPayload = Schema.decodeUnknownEffect(BoardCardAttachedPayload);
const decodeBoardCardDetachedPayload = Schema.decodeUnknownEffect(BoardCardDetachedPayload);
const decodeBoardCardArchivedPayload = Schema.decodeUnknownEffect(BoardCardArchivedPayload);
const decodeBoardCardDeletedPayload = Schema.decodeUnknownEffect(BoardCardDeletedPayload);
const decodeBoardCardUnarchivedPayload = Schema.decodeUnknownEffect(BoardCardUnarchivedPayload);
const decodeBoardLabelCreatedPayload = Schema.decodeUnknownEffect(BoardLabelCreatedPayload);
const decodeBoardLabelUpdatedPayload = Schema.decodeUnknownEffect(BoardLabelUpdatedPayload);
const decodeBoardLabelDeletedPayload = Schema.decodeUnknownEffect(BoardLabelDeletedPayload);
const decodeBoardLabelUndeletedPayload = Schema.decodeUnknownEffect(BoardLabelUndeletedPayload);
const decodeBoardCardStepCompletedPayload = Schema.decodeUnknownEffect(
  BoardCardStepCompletedPayload,
);
const decodeBoardPlansProposedPayload = Schema.decodeUnknownEffect(BoardPlansProposedPayload);
const decodeBoardPlanReviewStartedPayload = Schema.decodeUnknownEffect(
  BoardPlanReviewStartedPayload,
);
const decodeBoardPlanReviewStoppedPayload = Schema.decodeUnknownEffect(
  BoardPlanReviewStoppedPayload,
);
const decodeBoardPlanReviewRoundsChangedPayload = Schema.decodeUnknownEffect(
  BoardPlanReviewRoundsChangedPayload,
);
const decodeBoardPlanWrittenPayload = Schema.decodeUnknownEffect(BoardPlanWrittenPayload);
const decodeBoardPlansApprovedPayload = Schema.decodeUnknownEffect(BoardPlansApprovedPayload);
const decodeBoardCardIntegrationBranchRecordedPayload = Schema.decodeUnknownEffect(
  BoardCardIntegrationBranchRecordedPayload,
);
const decodeBoardCardWorkerPinnedPayload = Schema.decodeUnknownEffect(BoardCardWorkerPinnedPayload);
const decodeBoardCardPlacedPayload = Schema.decodeUnknownEffect(BoardCardPlacedPayload);
const decodeBoardCardWorkerMoveRecordedPayload = Schema.decodeUnknownEffect(
  BoardCardWorkerMoveRecordedPayload,
);
const decodeBoardCardWorkerRemovalPayload = Schema.decodeUnknownEffect(
  BoardCardWorkerRemovalPayload,
);
const decodeBoardCardBaseRefRecordedPayload = Schema.decodeUnknownEffect(
  BoardCardBaseRefRecordedPayload,
);
const decodeBoardCardWorktreeProvisioningPayload = Schema.decodeUnknownEffect(
  BoardCardWorktreeProvisioningPayload,
);
const decodeBoardCardWorktreeReadyPayload = Schema.decodeUnknownEffect(
  BoardCardWorktreeReadyPayload,
);
const decodeBoardCardWorktreeFailedPayload = Schema.decodeUnknownEffect(
  BoardCardWorktreeFailedPayload,
);
const decodeBoardCardWorktreeReclaimedPayload = Schema.decodeUnknownEffect(
  BoardCardWorktreeReclaimedPayload,
);
const decodeBoardCardPullRequestRecordedPayload = Schema.decodeUnknownEffect(
  BoardCardPullRequestRecordedPayload,
);
const decodeBoardCardCiRecordedPayload = Schema.decodeUnknownEffect(BoardCardCiRecordedPayload);
const decodeBoardCardAutoMergeHoldRecordedPayload = Schema.decodeUnknownEffect(
  BoardCardAutoMergeHoldRecordedPayload,
);
const decodeBoardStageCreatedPayload = Schema.decodeUnknownEffect(BoardStageCreatedPayload);
const decodeBoardStageRenamedPayload = Schema.decodeUnknownEffect(BoardStageRenamedPayload);
const decodeBoardStageReorderedPayload = Schema.decodeUnknownEffect(BoardStageReorderedPayload);
const decodeBoardStageDeletedPayload = Schema.decodeUnknownEffect(BoardStageDeletedPayload);
const decodeBoardProjectStageConfigSetPayload = Schema.decodeUnknownEffect(
  BoardProjectStageConfigSetPayload,
);
const decodeBoardCardStageThreadRequestedPayload = Schema.decodeUnknownEffect(
  BoardCardStageThreadRequestedPayload,
);
const decodeBoardCardStepSelectedPayload = Schema.decodeUnknownEffect(BoardCardStepSelectedPayload);
const decodeBoardCardStepAdmittedPayload = Schema.decodeUnknownEffect(BoardCardStepAdmittedPayload);
const decodeBoardCardStepAwaitingInputPayload = Schema.decodeUnknownEffect(
  BoardCardStepAwaitingInputPayload,
);
const decodeBoardCardStepForceStartRequestedPayload = Schema.decodeUnknownEffect(
  BoardCardStepForceStartRequestedPayload,
);
const decodeBoardCardStepPausedPayload = Schema.decodeUnknownEffect(BoardCardStepPausedPayload);
const decodeBoardCardStepRecoveredPayload = Schema.decodeUnknownEffect(
  BoardCardStepRecoveredPayload,
);
const decodeBoardCardStepSettledPayload = Schema.decodeUnknownEffect(BoardCardStepSettledPayload);
const decodeBoardCardStepRetunedPayload = Schema.decodeUnknownEffect(BoardCardStepRetunedPayload);
const decodeBoardCardStepSteeredPayload = Schema.decodeUnknownEffect(BoardCardStepSteeredPayload);
const decodeBoardCardStepCheckedInPayload = Schema.decodeUnknownEffect(
  BoardCardStepCheckedInPayload,
);
const decodeBoardWorkerRegisteredPayload = Schema.decodeUnknownEffect(BoardWorkerRegisteredPayload);
const decodeBoardWorkerRemovedPayload = Schema.decodeUnknownEffect(BoardWorkerRemovedPayload);
const decodeBoardDefaultWorkerSetPayload = Schema.decodeUnknownEffect(BoardDefaultWorkerSetPayload);

// Card order is (createdAt, id), compared by code units: createdAt is client
// supplied, and localeCompare or SQL collation could disagree with JS. The
// rehydration in projection.ts sorts with this comparator too.
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareBoardCards(left: BoardCard, right: BoardCard): number {
  return compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id);
}

/**
 * The full card a created payload describes. Fields no `board.card-created`
 * payload carries start at their empty defaults — and for walking-skeleton
 * events the payload's own decoding defaults fill the rest, mirroring
 * migration 903's column defaults so replay equals rehydration.
 */
export function boardCardFromCreatedPayload(payload: BoardCardCreatedPayload): BoardCard {
  return {
    id: payload.cardId,
    key: payload.key,
    cardNumber: payload.cardNumber,
    projectId: payload.projectId,
    labels: boardCardCreatedLabels(payload),
    stage: payload.stage,
    orderKey: payload.orderKey,
    title: payload.title,
    // The brief body lives only in `board_card_bodies`. `blocked` is false at
    // birth: the decider refuses creating into a build-or-later stage with
    // unmet dependencies, and materialised children land before build.
    briefRef:
      payload.brief === undefined && payload.briefFromPlanId === undefined
        ? null
        : BOARD_CARD_BRIEF_BODY_KIND,
    dependsOn: boardCardCreatedDependsOn(payload),
    // Sub-board materialisation (t3o-23): set only on the child creations the
    // approve decider emits; absent on every other create.
    parentCardId: payload.parentCardId ?? null,
    sourcePlanId: payload.sourcePlanId ?? null,
    // A heading is born a group (T3O-27); every other card is born a leaf.
    group: payload.group ?? null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    // No overrides at birth, split children included: that is what makes a
    // child resolve its parent's model overrides.
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    // Present only when the user pinned a branch; null follows the project
    // default (legacy events and materialised children included).
    baseBranch: payload.baseBranch ?? null,
    // The card's scheduled start (T3O-19, D1) rides the flat created payload
    // the same way: absent — every legacy event and every card created without
    // a time — is null, which is "start as soon as the pipeline reaches it".
    scheduledStartAt: payload.scheduledStartAt ?? null,
    // The worker pin (T3O-65, D20) rides the flat created payload the same
    // way: absent — every legacy event and every card that follows the
    // default — is null. Nothing has spawned, so nothing is placed or moving.
    pinnedWorkerId: payload.pinnedWorkerId ?? null,
    mergeStrategy: payload.mergeStrategy ?? null,
    placedWorkerId: null,
    workerMove: null,
    placementOrphaned: null,
    ci: null,
    ciLastOutcome: null,
    ciRoundTrips: 0,
    // A card is never born armed (T3O-24, D2): the arm is a human delegating
    // the D18 build gate on a card they can already see waiting, and there is
    // no create-command field to set it with. Nor born auto-merging (T3O-38,
    // D3), for the same reason — and with nothing merged, nothing held.
    autoPlanSetting: null,
    autoBuildSetting: null,
    autoMergeSetting: null,
    autoMergeHold: null,
    // A created card never has a worktree: it is provisioned lazily on its
    // first `build`-mode stage entry (D5/D6), never at birth.
    worktree: null,
    // Nor a pull request: with no branch pushed there is nothing to look up,
    // no round has finished, and so nothing to floor.
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    // And no split has been proposed on a card that has never planned (card 11).
    splitRationale: null,
    blocked: false,
    archivedAt: null,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
}

function upsertCard<M extends BoardReadModel>(model: M, card: BoardCard): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const cards = (
    board.cards.some((existing) => existing.id === card.id)
      ? board.cards.map((existing) => (existing.id === card.id ? card : existing))
      : [...board.cards, card]
  ).toSorted(compareBoardCards);
  return { ...model, board: { ...board, cards } };
}

/**
 * Drop a card and every read-model slice keyed on it. `nextCardNumberByProject`
 * is a high-water mark and is not rolled back, so a deleted key is never
 * re-issued.
 */
function removeCard<M extends BoardReadModel>(model: M, cardId: BoardCardId): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  // Slices are stripped and re-added only when non-empty, matching
  // `loadBoardState`, which omits absent and empty slices alike. Destructuring
  // the keys out of `rest` is load-bearing: spreading an empty `readd()` over a
  // base still carrying a key would not remove it.
  const { stepCompletions, stepStates, plans, ...rest } = board;
  const readd = <T extends { readonly cardId: BoardCardId }>(
    key: "stepCompletions" | "stepStates" | "plans",
    slice: ReadonlyArray<T> | undefined,
  ) => {
    if (slice === undefined) return {};
    const kept = slice.filter((entry) => entry.cardId !== cardId);
    return kept.length > 0 ? { [key]: kept } : {};
  };
  return {
    ...model,
    board: {
      ...rest,
      ...readd("stepCompletions", stepCompletions),
      ...readd("stepStates", stepStates),
      ...readd("plans", plans),
      cards: board.cards.filter((card) => card.id !== cardId),
    },
  };
}

/** Upsert a label, kept in `compareBoardLabels` order (the comparator
    `loadBoardState` uses). Every label event carries the full label, so this
    one path serves them all. */
function upsertLabel<M extends BoardReadModel>(model: M, label: BoardLabel): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const catalogue = boardLabelCatalogue(board);
  const labels = (
    catalogue.some((existing) => existing.labelId === label.labelId)
      ? catalogue.map((existing) => (existing.labelId === label.labelId ? label : existing))
      : [...catalogue, label]
  ).toSorted(compareBoardLabels);
  return { ...model, board: { ...board, labels } };
}

/** Upsert a stage definition into the in-memory model (t3o-15), keeping the
    slice in canonical `compareBoardStages` order so replay equals rehydration. */
function upsertStage<M extends BoardReadModel>(model: M, stage: BoardStageDefinition): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const current = boardAllStages(board);
  const stages = (
    current.some((existing) => existing.stageId === stage.stageId)
      ? current.map((existing) => (existing.stageId === stage.stageId ? stage : existing))
      : [...current, stage]
  ).toSorted(compareBoardStages);
  return { ...model, board: { ...board, stages } };
}

/** Remove a stage definition from the in-memory model (t3o-15). */
function removeStage<M extends BoardReadModel>(
  model: M,
  stageId: BoardStageDefinition["stageId"],
): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const stages = boardAllStages(board).filter((stage) => stage.stageId !== stageId);
  return { ...model, board: { ...board, stages } };
}

/** Record a project's delta (T3O-43/49), in project-id order so replay
    equals rehydration, and any stage rows a T3O-43 payload wrote and dropped. */
function setProjectStageConfig<M extends BoardReadModel>(
  model: M,
  payload: BoardProjectStageConfigSetPayload,
): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const configs = { ...board.projectStageConfigs, [payload.projectId]: payload.config };
  const projectStageConfigs = Object.fromEntries(
    Object.entries(configs).toSorted(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  ) as Record<ProjectId, BoardProjectStageConfig>;
  let next: M = { ...model, board: { ...board, projectStageConfigs } };
  for (const stage of payload.upserts) next = upsertStage(next, stage);
  for (const stageId of payload.deletedStageIds) next = removeStage(next, stageId);
  return next;
}

/** Monotonic max, so a legacy event (cardNumber 0) still lands the counter at
    1, matching `MAX(card_number) + 1` rehydration. A card moving project draws
    from the counter like a create, so the two never share a key. */
function bumpNextCardNumber<M extends BoardReadModel>(
  model: M,
  allocation: { readonly projectId: ProjectId; readonly cardNumber: number },
): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const current = board.nextCardNumberByProject[allocation.projectId] ?? 1;
  return {
    ...model,
    board: {
      ...board,
      nextCardNumberByProject: {
        ...board.nextCardNumberByProject,
        [allocation.projectId]: Math.max(current, allocation.cardNumber + 1),
      },
    },
  };
}

/** Canonical step-completion order (t3o-08): (completedAt, cardId, stepId) by
    code units. Applied on BOTH sides of the replay-equals-rehydration
    invariant — here on the read model, and by `loadBoardState` on rows read
    from `board_card_steps` — so replay and rehydration cannot diverge. */
export function compareBoardStepCompletions(
  left: BoardStepCompletion,
  right: BoardStepCompletion,
): number {
  return (
    compareStrings(left.completedAt, right.completedAt) ||
    compareStrings(left.cardId, right.cardId) ||
    compareStrings(left.stepId, right.stepId)
  );
}

/** Canonical plan order (t3o-08): (cardId, ordinal, planId). The flat array
    spans cards, so it groups by card first, then the card's proposal order.
    Applied on both sides of replay-equals-rehydration, like the card and
    step comparators. */
export function compareBoardPlans(left: BoardPlan, right: BoardPlan): number {
  return (
    compareStrings(left.cardId, right.cardId) ||
    left.ordinal - right.ordinal ||
    compareStrings(left.planId, right.planId)
  );
}

/** Upsert a step completion by (cardId, stepId). Idempotent: a re-emitted
    completion (D4 retry) replaces the identical row, a no-op. */
function upsertStepCompletion<M extends BoardReadModel>(
  model: M,
  completion: BoardStepCompletion,
): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const current = board.stepCompletions ?? [];
  const exists = current.some(
    (existing) => existing.cardId === completion.cardId && existing.stepId === completion.stepId,
  );
  const stepCompletions = (
    exists
      ? current.map((existing) =>
          existing.cardId === completion.cardId && existing.stepId === completion.stepId
            ? completion
            : existing,
        )
      : [...current, completion]
  ).toSorted(compareBoardStepCompletions);
  return { ...model, board: { ...board, stepCompletions } };
}

/** Canonical step-state order (t3o-10): by cardId, one record per card.
    Applied on both sides of replay-equals-rehydration, like the other board
    slices. */
export function compareBoardStepStates(
  left: BoardCardStepState,
  right: BoardCardStepState,
): number {
  return compareStrings(left.cardId, right.cardId);
}

/** The CI-fix flag (T3O-12) for a `card-stalled` delta: present only when a
    CI fix is live, which that delta's authority reads as false otherwise. */
function checksFixShellField(state: Parameters<typeof isBoardChecksFixLive>[0]): {
  readonly stepChecksFix?: true;
} {
  return isBoardChecksFixLive(state) ? { stepChecksFix: true } : {};
}

/** The two step-derived stall fields the `card-stalled` delta carries
    (T3O-22, D10), spread whole or not at all: a step that is not stalled
    omits both, and their ABSENCE on this delta is what clears the card's
    chip. */
function stallShellFields(state: BoardCardStepState) {
  if (state.status !== "stalled") return {};
  return {
    stalledReason: state.stalledReason,
    ...(state.retryAt === null ? {} : { retryAt: state.retryAt }),
  };
}

/** Add or replace one registered worker (T3O-62), in `compareBoardWorkers`
    order on both sides of replay-equals-rehydration. */
function upsertWorker<M extends BoardReadModel>(model: M, worker: BoardWorker): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const workers = [
    ...(board.workers ?? []).filter((existing) => existing.id !== worker.id),
    worker,
  ].toSorted(compareBoardWorkers);
  return { ...model, board: { ...board, workers } };
}

/** Drop one worker. The slice goes when the last one does, so a board whose
    workers were all removed decodes exactly as one that never had any. */
function removeWorker<M extends BoardReadModel>(model: M, workerId: EnvironmentId): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const remaining = (board.workers ?? []).filter((existing) => existing.id !== workerId);
  const { workers: _dropped, ...rest } = board;
  return { ...model, board: remaining.length === 0 ? rest : { ...board, workers: remaining } };
}

/** Record the default worker. `local` is the absent default, so choosing it
    again drops the field rather than storing the value that absence means. */
function setDefaultWorker<M extends BoardReadModel>(model: M, workerId: BoardWorkerId): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const { defaultWorkerId: _dropped, ...rest } = board;
  return {
    ...model,
    board: workerId === BOARD_LOCAL_WORKER_ID ? rest : { ...board, defaultWorkerId: workerId },
  };
}

function upsertStepState<M extends BoardReadModel>(model: M, state: BoardCardStepState): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const current = board.stepStates ?? [];
  const exists = current.some((existing) => existing.cardId === state.cardId);
  const stepStates = (
    exists
      ? current.map((existing) => (existing.cardId === state.cardId ? state : existing))
      : [...current, state]
  ).toSorted(compareBoardStepStates);
  return { ...model, board: { ...board, stepStates } };
}

/** Set one card's split justification (t3o card 11). Its own helper rather than
    a card upsert because `board.plans-proposed` carries the card id and the
    plans, never the card — and a no-op for an unknown id, matching the plan
    slice's behaviour on the same event. */
function setCardSplitRationale<M extends BoardReadModel>(
  model: M,
  cardId: BoardCardId,
  splitRationale: BoardCard["splitRationale"],
  splitRecommendation: BoardCard["splitRecommendation"],
): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  if (!board.cards.some((card) => card.id === cardId)) return model;
  return {
    ...model,
    board: {
      ...board,
      cards: board.cards.map((card) => {
        if (card.id !== cardId) return card;
        const { splitRecommendation: _prior, ...rest } = card;
        return {
          ...rest,
          splitRationale,
          ...(splitRecommendation === undefined ? {} : { splitRecommendation }),
        };
      }),
    },
  };
}

/** Replace a card's whole plan set (board_propose_plans is a wholesale
    replace). Bodies are stripped — they live only in `board_plans`. */
function replaceCardPlans<M extends BoardReadModel>(
  model: M,
  cardId: BoardPlan["cardId"],
  plans: ReadonlyArray<BoardPlan>,
): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const others = (board.plans ?? []).filter((plan) => plan.cardId !== cardId);
  const next = [...others, ...plans].toSorted(compareBoardPlans);
  return { ...model, board: { ...board, plans: next } };
}

/** Upsert one plan's metadata (board_write_plan bumps `updatedAt`). */
function upsertPlan<M extends BoardReadModel>(model: M, plan: BoardPlan): M {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const current = board.plans ?? [];
  const plans = (
    current.some((existing) => existing.planId === plan.planId)
      ? current.map((existing) => (existing.planId === plan.planId ? plan : existing))
      : [...current, plan]
  ).toSorted(compareBoardPlans);
  return { ...model, board: { ...board, plans } };
}

export function projectBoardEvent<M extends BoardReadModel>(
  model: M,
  event: BoardEvent,
): Effect.Effect<M, BoardProjectorDecodeError> {
  switch (event.type) {
    case "board.card-created":
      return decodeBoardCardCreatedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => {
          const card = boardCardFromCreatedPayload(payload);
          const next = bumpNextCardNumber(upsertCard(model, card), payload);
          // A split child owns a copy of its plan (T3O-27), mirroring the SQL
          // projection's row.
          const source =
            payload.briefFromPlanId === undefined || payload.briefOnly === true
              ? undefined
              : next.board?.plans?.find((plan) => plan.planId === payload.briefFromPlanId);
          return source === undefined
            ? next
            : upsertPlan(next, boardSplitChildPlanCopy(source, card));
        }),
      );

    case "board.card-moved":
      return decodeBoardCardMovedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-project-changed":
      // The OLD project's counter is deliberately left where it is: it is
      // monotonic, and the card's number leaving that project is recorded by
      // the SQL projection's card-number floor instead — the in-memory model
      // is rebuilt from that floor on the next rehydration.
      return decodeBoardCardProjectChangedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) =>
          bumpNextCardNumber(upsertCard(model, payload.card), {
            projectId: payload.card.projectId,
            cardNumber: payload.card.cardNumber,
          }),
        ),
      );

    case "board.card-reordered":
      return decodeBoardCardReorderedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-updated":
      return decodeBoardCardUpdatedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-thread-linked":
      return decodeBoardCardThreadLinkedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-thread-unlinked":
      return decodeBoardCardThreadUnlinkedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-attached":
      return decodeBoardCardAttachedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-detached":
      return decodeBoardCardDetachedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-archived":
      // The card stays in the model (archivedAt set) so unarchive can
      // restore it on replay; only the shell drops it.
      return decodeBoardCardArchivedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-unarchived":
      return decodeBoardCardUnarchivedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-deleted":
      // The opposite of archive: the card leaves the model for good, so a
      // from-empty replay of a log containing this event reaches a state with
      // no trace of the card — matching the tables the projection just purged.
      return decodeBoardCardDeletedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => removeCard(model, payload.cardId)),
      );

    case "board.label-created":
      return decodeBoardLabelCreatedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertLabel(model, payload.label)),
      );

    case "board.label-updated":
      return decodeBoardLabelUpdatedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertLabel(model, payload.label)),
      );

    case "board.label-deleted":
      return decodeBoardLabelDeletedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertLabel(model, payload.label)),
      );

    case "board.label-undeleted":
      return decodeBoardLabelUndeletedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertLabel(model, payload.label)),
      );

    case "board.card-step-completed":
      return decodeBoardCardStepCompletedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepCompletion(model, payload.completion)),
      );

    case "board.plans-proposed":
      return decodeBoardPlansProposedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) =>
          // The split justification rides the card, not the plan set (card 11),
          // so it is a targeted field set rather than a card upsert: this event
          // carries the card id and the plans, never the card itself. Applied
          // BEFORE the plans so an unknown card id is a no-op on both.
          replaceCardPlans(
            setCardSplitRationale(
              model,
              payload.cardId,
              payload.splitRationale,
              payload.splitRecommendation,
            ),
            payload.cardId,
            // Strip the body — read model holds metadata only (D8).
            payload.plans.map(({ body: _body, ...plan }) => plan),
          ),
        ),
      );

    case "board.plan-written":
      return decodeBoardPlanWrittenPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertPlan(model, payload.plan)),
      );

    case "board.plans-approved":
      // The children rode their own card-created events and the parent's move
      // its card-moved (t3o-23, D2); this event re-asserts the post-approval
      // parent so replay is whole even if the move was skipped (parent
      // already sitting in Building).
      return decodeBoardPlansApprovedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-integration-branch-recorded":
      return decodeBoardCardIntegrationBranchRecordedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-base-ref-recorded":
      return decodeBoardCardBaseRefRecordedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    // Placement (T3O-65): each carries the whole post-change card.
    case "board.card-worker-pinned":
      return decodeBoardCardWorkerPinnedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-placed":
      return decodeBoardCardPlacedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worker-move-recorded":
      return decodeBoardCardWorkerMoveRecordedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worker-removal":
      return decodeBoardCardWorkerRemovalPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worktree-provisioning":
      return decodeBoardCardWorktreeProvisioningPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worktree-ready":
      return decodeBoardCardWorktreeReadyPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worktree-failed":
      return decodeBoardCardWorktreeFailedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worktree-reclaimed":
      return decodeBoardCardWorktreeReclaimedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-pull-request-recorded":
      return decodeBoardCardPullRequestRecordedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    // The auto-merge hold (T3O-38, D4) is on the card aggregate, so the event
    // carries the whole post-change card exactly like the pull-request record
    // above and the upsert is the whole of the fold.
    case "board.card-auto-merge-hold-recorded":
      return decodeBoardCardAutoMergeHoldRecordedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    // CI (T3O-44): the card's compact CI state is on the aggregate; pass rows
    // with their tails are table-only.
    case "board.card-ci-recorded":
      return decodeBoardCardCiRecordedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    // Reporting only — it changes no card field, so the read model is
    // unchanged and a replay that includes it lands exactly where a replay
    // without it would.
    case "board.card-note-recorded":
    // The decision log is table-only (T3O-32, D8).
    case "board.card-decisions-recorded":
      return Effect.succeed(model);

    case "board.stage-created":
      return decodeBoardStageCreatedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStage(model, payload.stage)),
      );

    case "board.stage-renamed":
    case "board.stage-updated":
      return decodeBoardStageRenamedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStage(model, payload.stage)),
      );

    case "board.stage-reordered":
      return decodeBoardStageReorderedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStage(model, payload.stage)),
      );

    case "board.stage-deleted":
      return decodeBoardStageDeletedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => removeStage(model, payload.stageId)),
      );

    case "board.card-stage-thread-requested":
      // A request signal only — the reactor reacts; the read model is unchanged.
      // Decoded to fail loudly on a malformed event.
      return decodeBoardCardStageThreadRequestedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.as(model),
      );

    case "board.card-step-selected":
      return decodeBoardCardStepSelectedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-admitted":
      return decodeBoardCardStepAdmittedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-force-start-requested":
      return decodeBoardCardStepForceStartRequestedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-awaiting-input":
      return decodeBoardCardStepAwaitingInputPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-paused":
      return decodeBoardCardStepPausedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-recovered":
      return decodeBoardCardStepRecoveredPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-settled":
      return decodeBoardCardStepSettledPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-retuned":
      return decodeBoardCardStepRetunedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-steered":
      return decodeBoardCardStepSteeredPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-checked-in":
      return decodeBoardCardStepCheckedInPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    // T3o: plan review (T3O-39). Starting writes the step state; stopping
    // clears it, so turning review back on starts a fresh one.
    case "board.plan-review-started":
      return decodeBoardPlanReviewStartedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.plan-review-stopped":
      return decodeBoardPlanReviewStoppedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.plan-review-rounds-changed":
      return decodeBoardPlanReviewRoundsChangedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    // T3o (T3O-62): the worker registry. Touches no card.
    case "board.worker-registered":
      return decodeBoardWorkerRegisteredPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertWorker(model, payload.worker)),
      );

    case "board.worker-removed":
      return decodeBoardWorkerRemovedPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => removeWorker(model, payload.workerId)),
      );

    case "board.default-worker-set":
      return decodeBoardDefaultWorkerSetPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => setDefaultWorker(model, payload.workerId)),
      );

    case "board.project-stage-config-set":
      return decodeBoardProjectStageConfigSetPayload(event.payload).pipe(
        Effect.mapError(toBoardProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => setProjectStageConfig(model, payload)),
      );

    default: {
      event satisfies never;
      // Runtime backstop for an undecoded event: leave the model unchanged.
      return Effect.succeed(model);
    }
  }
}

/**
 * Deltas carry the bounded `BoardCardShell`, built from the event's card alone.
 * Thread-derived fields leave at their "none" state; clients derive them
 * against their thread shells (`withBoardThreadFields`).
 */
export function boardShellStreamEvent(event: BoardEvent): Option.Option<BoardShellStreamEvent> {
  switch (event.type) {
    case "board.card-created":
      return Option.some({
        kind: "card-upserted",
        sequence: event.sequence,
        // The one card-carrying delta that always knows the brief body: a card
        // is created with its brief or without one, so the footer's image
        // indicator is decidable here (`boardBriefHasImage`).
        card: boardCardShellFromCard(boardCardFromCreatedPayload(event.payload), undefined, {
          briefHasImage:
            event.payload.brief === undefined ? false : boardBriefHasImage(event.payload.brief),
        }),
      });

    case "board.card-updated":
      return Option.some({
        kind: "card-upserted",
        sequence: event.sequence,
        // `brief` absent means the brief did not change, and the body is not on
        // the card — so the key is omitted and the client keeps its last known
        // value. A set or a clear is authoritative.
        card: boardCardShellFromCard(event.payload.card, undefined, {
          briefHasImage:
            event.payload.brief === undefined
              ? undefined
              : event.payload.brief === null
                ? false
                : boardBriefHasImage(event.payload.brief),
          // Carried when the edit changed the review summary (t3o-22, D7), so a
          // pure override edit moves the card face live rather than waiting for
          // the next step completion. Absent leaves the client's last value.
          reviewSummary: event.payload.reviewSummary ?? undefined,
        }),
      });

    case "board.card-moved":
      // An Advance past a stuck review loop carries the summary it changed
      // (T3O-51); every other move leaves the client's last value.
      return Option.some({
        kind: "card-upserted",
        sequence: event.sequence,
        card: boardCardShellFromCard(event.payload.card, undefined, {
          reviewSummary: event.payload.reviewSummary ?? undefined,
        }),
      });
    // T3O-33: the card's `projectId` and `key` are both on the shell, so the
    // board relabels and recolours it live.
    case "board.card-project-changed":
    case "board.card-reordered":
    case "board.card-thread-linked":
    case "board.card-thread-unlinked":
    // The attachment count IS on the shell (t3o-32) and rides the aggregate,
    // so the card-upserted delta carries the real value.
    case "board.card-attached":
    case "board.card-detached":
    case "board.card-unarchived":
    // Worktree lifecycle (t3o-09) is not itself on the bounded shell — the
    // full worktree state rides board.subscribeCard detail (D7) — but the
    // card still re-upserts so any shell field that did change (e.g. a move
    // into building landing alongside provisioning) stays consistent.
    case "board.card-worktree-provisioning":
    case "board.card-worktree-ready":
    case "board.card-worktree-failed":
    case "board.card-worktree-reclaimed":
    // Sub-board approval (t3o-23): the parent's stage moved and its shell
    // `parentCardId`-derived fields may render differently; the children ride
    // their own card-created deltas. The integration branch is detail, but the
    // event carries the whole card, so the re-upsert costs nothing extra.
    case "board.plans-approved":
    case "board.card-integration-branch-recorded":
    // A retarget rebase moved the recorded base (T3O-5, D6). Detail state, but
    // the event carries the whole card, so the re-upsert is free.
    case "board.card-base-ref-recorded":
    // The PR link IS on the bounded shell (`hasPr` / `prNumber`), and it rides
    // the card aggregate — so this delta carries the real value like any other
    // card field, with no absent-means-preserve dance.
    case "board.card-pull-request-recorded":
    // The auto-merge hold drives three shell fields (T3O-38, D14) and rides
    // the card aggregate, so this delta carries the real values like any
    // other card field.
    case "board.card-auto-merge-hold-recorded":
    // CI progress (T3O-44) is a shell field on the card aggregate.
    case "board.card-ci-recorded":
    // Placement (T3O-65): the bound worker and the move are shell fields on
    // the card aggregate.
    case "board.card-worker-pinned":
    case "board.card-placed":
    case "board.card-worker-move-recorded":
    // T3O-66: Worker removed is a shell field on the card aggregate.
    case "board.card-worker-removal":
      return Option.some({
        kind: "card-upserted",
        sequence: event.sequence,
        card: boardCardShellFromCard(event.payload.card),
      });

    case "board.stage-created":
    case "board.stage-renamed":
    case "board.stage-updated":
    case "board.stage-reordered":
      // Stage aggregate delta (t3o-15): the full post-change stage rides once,
      // so the board reads column order and labels from the read model (D13).
      return Option.some({
        kind: "stage-upserted",
        sequence: event.sequence,
        stage: event.payload.stage,
      });

    case "board.stage-deleted":
      return Option.some({
        kind: "stage-removed",
        sequence: event.sequence,
        stageId: event.payload.stageId,
      });

    case "board.card-archived":
    case "board.card-deleted":
      // Both take the card off the live board every client renders. The shell
      // has no reason to tell them apart — a client that cannot see the card
      // renders the same nothing either way — and the archive page, which does
      // care, is a separate read that only one of them appears in.
      return Option.some({
        kind: "card-removed",
        sequence: event.sequence,
        cardId: event.payload.cardId,
      });

    case "board.label-created":
    case "board.label-updated":
    case "board.label-deleted":
    case "board.label-undeleted":
      // Catalogue delta (t3o-06a): the full post-change label rides once, so a
      // recolour repaints every card that references it with no card deltas.
      // Delete/undelete are tombstone upserts — the label stays in the
      // catalogue with `deletedAt` set/cleared.
      return Option.some({
        kind: "label-upserted",
        sequence: event.sequence,
        label: event.payload.label,
      });

    case "board.card-step-admitted":
      // Admission flips the card's `queued` badge. A dedicated delta because
      // this event carries `state`, not the card, so the shell cannot be
      // rebuilt here.
      return Option.some({
        kind: "card-queued",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        queued: event.payload.state.status === "queued",
        // Admission also settles the durable "being worked" dot: held for a slot
        // (`queued`) means not running; admitted to running lights `stepRunning`.
        stepRunning: event.payload.state.status === "running",
        // Which limit holds it (T3O-65), only beside `queued`.
        ...(event.payload.state.status === "queued" && event.payload.state.queuedBy !== null
          ? { queuedBy: event.payload.state.queuedBy }
          : {}),
      });

    case "board.card-step-recovered":
      // Recovery gave up (`stalled`) or put the step back to work (badge
      // cleared). Like `card-queued`, the event carries `state`, not the card.
      return Option.some({
        kind: "card-stalled",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        stalled: event.payload.state.status === "stalled",
        // Recovery either put the step back to running (dot re-lights) or landed
        // it stalled (dot dark) — carry the durable flag on the same delta.
        stepRunning: event.payload.state.status === "running",
        // Recovery is the step being SUPERVISED, never settled, so it always
        // clears `held`: a step that gave up is `stalled`, which is its own
        // louder flag, and one that retried is running again.
        held: false,
        // Never awaiting input after recovery: this clears the parked badge
        // when a human answers or presses Resume (`resume-step` and
        // `requeue-step` both publish here).
        stepAwaiting: boardStepParkedReason(event.payload.state),
        ...stallShellFields(event.payload.state),
        // A recovered conflict fix keeps its identity. An escalation lands on
        // `stalled`, which `isBoardConflictFixLive` excludes, so the pill
        // hands over to the "Stalled" chip.
        stepConflictFix: isBoardConflictFixLive(event.payload.state),
        ...checksFixShellField(event.payload.state),
        // Recovery lands on `running` or `stalled` — but a board-driven resume
        // (T3O-23) lands on `queued`, and this is the one delta that carries
        // both the parked chip it clears and the queue pill it raises.
        queued: event.payload.state.status === "queued",
      });

    case "board.card-step-selected":
      // A fresh stage run (first entry, or a human retry re-queuing a stalled
      // card through the governor, D4) starts from `pending` — never stalled —
      // so clear any lingering stalled badge as the new run begins.
      return Option.some({
        kind: "card-stalled",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        stalled: false,
        // A freshly-selected step is `pending` — admitted-and-running has not
        // happened yet — so the durable dot is off until `card-step-admitted`.
        stepRunning: false,
        // …and it is the card moving again, which is precisely what clears
        // `held`. This is also why `card-queued` needs no copy of the flag: a
        // step is always selected before it can be admitted.
        held: false,
        // A fresh run is not parked on anybody (t3o-34, D4).
        stepAwaiting: null,
        // The conflict pill is raised here: the reactor stamps the armed fix
        // with `BOARD_CONFLICT_STEP_LABEL`. Every other selection clears it.
        stepConflictFix: isBoardConflictFixLive(event.payload.state),
        ...checksFixShellField(event.payload.state),
        // A freshly-selected step is `pending`, not `queued` — it has not been
        // offered to the governor yet — so any badge from a previous run goes.
        queued: false,
      });

    case "board.card-step-settled":
      // A settled step is never stalled. This covers a human completing a
      // stalled step's thread directly; the clear is idempotent.
      return Option.some({
        kind: "card-stalled",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        stalled: false,
        // A settled step is terminal — not running — so the durable dot goes
        // dark here (a converged loop that stops running turns stops being lit).
        stepRunning: false,
        // And it is the moment `held` is RAISED: the stage is finished with the
        // card. If the stage auto-advances, the destination's own select-step
        // clears it a beat later; if nothing advances the card, the flag is the
        // whole point — it is the only trace a parked card leaves.
        held: true,
        // A settled step is not waiting on an answer (t3o-34, D4) — `held` is
        // the settled form of "needs a human" and carries it from here.
        stepAwaiting: null,
        // A settled step is terminal, so no fix is live any more (T3O-9) —
        // whichever way it went, the pill and the modal banner clear here.
        stepConflictFix: false,
        // A step held for a slot can settle straight out of the queue without
        // passing admission, so settling must lower the flag too.
        queued: false,
      });

    case "board.plans-proposed":
      // Only the plan count rides the shell. A dedicated delta because this
      // event carries the plans, never the card.
      return Option.some({
        kind: "card-plans",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        planCount: event.payload.plans.length,
      });

    case "board.card-step-completed":
      // A review phase completing changes the column card (pips, severity,
      // tally, convergence). Other completions carry no summary and fall
      // through below.
      if (event.payload.reviewSummary !== undefined) {
        return Option.some({
          kind: "card-review",
          sequence: event.sequence,
          cardId: event.payload.cardId,
          summary: event.payload.reviewSummary,
        });
      }
      return Option.none();

    // T3o (T3O-62): the worker summary mixes registry facts with runtime
    // connection status, so it is not a pure function of one event. The board
    // subscription re-sends the whole `workers` state instead.
    case "board.worker-registered":
    case "board.worker-removed":
    case "board.default-worker-set":
      return Option.none();

    case "board.project-stage-config-set":
      return Option.some({
        kind: "project-stage-config",
        sequence: event.sequence,
        projectId: event.payload.projectId,
        config: boardProjectStageConfigShell(event.payload.config),
        upserts: event.payload.upserts,
        deletedStageIds: event.payload.deletedStageIds,
      });

    case "board.card-step-paused":
      // A human stopped the step. It rides `card-stalled`, which already
      // carries every step-derived shell flag.
      return Option.some({
        kind: "card-stalled",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        // Paused is NOT stalled: recovery has not given up, nothing failed, and
        // the chip that renders is neutral rather than the loud red one.
        stalled: false,
        // Nobody is working — this is the half of the fix that makes the stop
        // visible at all.
        stepRunning: false,
        // Non-terminal, so the stage has not finished with the card.
        held: false,
        stepAwaiting: boardStepParkedReason(event.payload.state),
        ...stallShellFields(event.payload.state),
        // A paused conflict fix hands the card face to the louder Paused chip
        // (`isBoardConflictFixLive` excludes it), so this always clears.
        stepConflictFix: isBoardConflictFixLive(event.payload.state),
        ...checksFixShellField(event.payload.state),
        // A paused step held a slot and gave it back; it is parked, not waiting
        // in the queue. Pressing Resume is what makes it `queued`.
        queued: false,
      });

    case "board.card-step-awaiting-input":
      // A step can park for a question asked in prose or a human-in-the-loop
      // turn, leaving no pending question on the thread, so the card learns it
      // here. Rides `card-stalled` like the other step-derived flags.
      return Option.some({
        kind: "card-stalled",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        // Parked, not stalled: recovery has not given up on it, and (unlike a
        // stall) nothing released its slot.
        stalled: false,
        // The blue dot goes dark. This is the fix.
        stepRunning: false,
        // Non-terminal, so nothing is `held`.
        held: false,
        stepAwaiting: boardStepParkedReason(event.payload.state),
        ...stallShellFields(event.payload.state),
        // A conflict fix that asks a question is still the same live fix
        // (T3O-9): the merge is still held, so the flag rides through unchanged.
        stepConflictFix: isBoardConflictFixLive(event.payload.state),
        ...checksFixShellField(event.payload.state),
        // A step parked on a human is admitted and holding its slot, not queued.
        queued: false,
      });

    case "board.plan-written":
    case "board.card-stage-thread-requested":
    // The remaining step-lifecycle events are card detail. A force-start
    // changes nothing yet: the step stays queued until admission, whose own
    // delta clears the badge.
    case "board.card-step-force-start-requested":
    case "board.card-step-retuned":
    // A human steering a running step (T3O-17) changes no column-card field
    // either: the step is still running and still owned by the same thread.
    // Only the supervisor's private nudge bookkeeping moved.
    case "board.card-step-steered":
    // A background-wait check-in (T3O-20) leaves the step running on the same
    // thread; the card's "Waiting" label is thread-derived, not step-derived.
    case "board.card-step-checked-in":
    // Plan review (T3O-39) is card detail: the sidebar and the rail show it.
    case "board.plan-review-started":
    case "board.plan-review-stopped":
    case "board.plan-review-rounds-changed":
    // Branch cleanup is card DETAIL too: it lands on the activity rail, which
    // rides `board.subscribeCard`, and changes nothing a column card renders.
    case "board.card-note-recorded":
    case "board.card-decisions-recorded":
      // Agent write-path events change nothing a column card renders. None
      // moves a step in or out of `queued`, and a plan set change rides
      // `card-plans` above.
      return Option.none();

    default: {
      event satisfies never;
      return Option.none();
    }
  }
}
