/**
 * T3o board projector — `projectBoardEvent`.
 *
 * Applies board events to the in-memory orchestration read model, delegated
 * to from the upstream projector behind the `isBoardEvent` predicate. Also
 * maps board events to card shell deltas for the shell stream (delegated to
 * from ws.ts behind the same predicate), which needs no projection re-read:
 * every board event payload carries the whole post-change card (and the
 * created payload carries every field of it).
 *
 * Archived cards stay in the read model with `archivedAt` set — the shell
 * drops them (`card-removed`), but the model keeps them so unarchive can
 * restore the card on a from-empty replay. DELETED cards leave the model as
 * well, along with every slice keyed on them; the counter they allocated their
 * key from is the one thing that stays, so a deleted key is never re-issued.
 */
import {
  BOARD_CARD_BRIEF_BODY_KIND,
  BoardCardArchivedPayload,
  boardCardCreatedDependsOn,
  boardCardCreatedLabels,
  BoardCardCreatedPayload,
  BoardCardDeletedPayload,
  BoardCardMovedPayload,
  BoardCardReorderedPayload,
  BoardCardStepCompletedPayload,
  BoardCardThreadLinkedPayload,
  BoardCardThreadUnlinkedPayload,
  BoardCardUnarchivedPayload,
  BoardCardWorktreeFailedPayload,
  BoardCardWorktreeProvisioningPayload,
  BoardCardWorktreeReadyPayload,
  BoardCardWorktreeReclaimedPayload,
  BoardCardPullRequestRecordedPayload,
  BoardCardStepSelectedPayload,
  BoardCardStepAdmittedPayload,
  BoardCardStepAwaitingInputPayload,
  BoardCardStepRecoveredPayload,
  BoardCardStepSettledPayload,
  BoardCardStepRetunedPayload,
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
  BoardCardIntegrationBranchRecordedPayload,
  BoardPlanWrittenPayload,
  BoardStageCreatedPayload,
  BoardStageDeletedPayload,
  BoardStageRenamedPayload,
  BoardStageReorderedPayload,
  boardStages,
  compareBoardLabels,
  compareBoardStages,
  EMPTY_BOARD_STATE,
  isBoardEvent,
  type BoardCard,
  type BoardCardId,
  type BoardCardStepState,
  type BoardLabel,
  type BoardPlan,
  type BoardStageDefinition,
  type BoardStepCompletion,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  toProjectorDecodeError,
  type OrchestrationProjectorDecodeError,
} from "../orchestration/Errors.ts";

export type BoardEvent = Extract<OrchestrationEvent, { type: `board.${string}` }>;

// Re-exported so upstream seams import predicate + delegate on one line.
export { isBoardEvent };

const decodeBoardCardCreatedPayload = Schema.decodeUnknownEffect(BoardCardCreatedPayload);
const decodeBoardCardMovedPayload = Schema.decodeUnknownEffect(BoardCardMovedPayload);
const decodeBoardCardReorderedPayload = Schema.decodeUnknownEffect(BoardCardReorderedPayload);
const decodeBoardCardUpdatedPayload = Schema.decodeUnknownEffect(BoardCardUpdatedPayload);
const decodeBoardCardThreadLinkedPayload = Schema.decodeUnknownEffect(BoardCardThreadLinkedPayload);
const decodeBoardCardThreadUnlinkedPayload = Schema.decodeUnknownEffect(
  BoardCardThreadUnlinkedPayload,
);
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
const decodeBoardPlanWrittenPayload = Schema.decodeUnknownEffect(BoardPlanWrittenPayload);
const decodeBoardPlansApprovedPayload = Schema.decodeUnknownEffect(BoardPlansApprovedPayload);
const decodeBoardCardIntegrationBranchRecordedPayload = Schema.decodeUnknownEffect(
  BoardCardIntegrationBranchRecordedPayload,
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
const decodeBoardStageCreatedPayload = Schema.decodeUnknownEffect(BoardStageCreatedPayload);
const decodeBoardStageRenamedPayload = Schema.decodeUnknownEffect(BoardStageRenamedPayload);
const decodeBoardStageReorderedPayload = Schema.decodeUnknownEffect(BoardStageReorderedPayload);
const decodeBoardStageDeletedPayload = Schema.decodeUnknownEffect(BoardStageDeletedPayload);
const decodeBoardCardStageThreadRequestedPayload = Schema.decodeUnknownEffect(
  BoardCardStageThreadRequestedPayload,
);
const decodeBoardCardStepSelectedPayload = Schema.decodeUnknownEffect(BoardCardStepSelectedPayload);
const decodeBoardCardStepAdmittedPayload = Schema.decodeUnknownEffect(BoardCardStepAdmittedPayload);
const decodeBoardCardStepAwaitingInputPayload = Schema.decodeUnknownEffect(
  BoardCardStepAwaitingInputPayload,
);
const decodeBoardCardStepRecoveredPayload = Schema.decodeUnknownEffect(
  BoardCardStepRecoveredPayload,
);
const decodeBoardCardStepSettledPayload = Schema.decodeUnknownEffect(BoardCardStepSettledPayload);
const decodeBoardCardStepRetunedPayload = Schema.decodeUnknownEffect(BoardCardStepRetunedPayload);

// Canonical card order: (createdAt, id), needed because createdAt is
// client-supplied, so dispatch order ≠ createdAt order in general. Compared
// by code units (not localeCompare, which is locale-sensitive, and not SQL
// ORDER BY, whose collation can disagree with JS on non-ASCII ids) — the
// rehydration path in projection.ts applies this same comparator after
// reading rows, so replay and rehydration cannot diverge on ordering.
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
    // A brief captured at creation (t3o-06) sets the sentinel ref; the body
    // itself lives only in `board_card_bodies` (D8), written by the SQL
    // projector. `dependsOn` rides the payload. `blocked` is false at birth
    // for every creation path: the decider refuses creating a card into a
    // build-or-later stage with unmet dependencies, and approve-materialised
    // children (t3o-23) land in the pre-build floor stage, where the
    // build-onward blocking rule (D11) does not yet apply.
    briefRef:
      payload.brief === undefined && payload.briefFromPlanId === undefined
        ? null
        : BOARD_CARD_BRIEF_BODY_KIND,
    dependsOn: boardCardCreatedDependsOn(payload),
    // Sub-board materialisation (t3o-23): set only on the child creations the
    // approve decider emits; absent on every other create.
    parentCardId: payload.parentCardId ?? null,
    sourcePlanId: payload.sourcePlanId ?? null,
    threadLinks: [],
    externalRef: null,
    // Per-card human-in-the-loop override is untouched at birth (D6), and so
    // are the review-loop overrides (t3o-22, D2) and the per-stage model
    // overrides (t3o-29, D1) — a new card runs the board's configured loop on
    // the workspace's configured models until someone says otherwise. A split
    // child is created through this same path and so starts with no override of
    // its own, which is exactly what makes it resolve its parent's (t3o-29, D4).
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    // A created card never has a worktree: it is provisioned lazily on its
    // first `build`-mode stage entry (D5/D6), never at birth.
    worktree: null,
    // Nor a pull request: with no branch pushed there is nothing to look up,
    // no round has finished, and so nothing to floor.
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
}

function upsertCard(model: OrchestrationReadModel, card: BoardCard): OrchestrationReadModel {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const cards = (
    board.cards.some((existing) => existing.id === card.id)
      ? board.cards.map((existing) => (existing.id === card.id ? card : existing))
      : [...board.cards, card]
  ).toSorted(compareBoardCards);
  return { ...model, board: { ...board, cards } };
}

/**
 * Drop a card and every read-model slice keyed on it (t3o card delete).
 *
 * `nextCardNumberByProject` is pointedly NOT touched. It is a high-water mark,
 * not a count: rolling it back would re-issue the deleted card's key to the
 * next card created in that project, and two cards sharing a key breaks every
 * human reference to either. Deleting the newest card in a project therefore
 * leaves a gap in the key sequence, which is the correct trade.
 */
function removeCard(model: OrchestrationReadModel, cardId: BoardCardId): OrchestrationReadModel {
  const board = model.board ?? EMPTY_BOARD_STATE;
  // The three per-card slices are stripped from the base and RE-ADDED only when
  // non-empty, so the result matches `loadBoardState`'s absent-vs-empty rule
  // EXACTLY on both edges:
  //  - an absent slice stays absent (rehydration omits the key), and
  //  - a slice this delete empties is OMITTED, not left present as `[]`
  //    (rehydration omits an empty table too — `plans.length > 0 ? … : {}`).
  // Either mismatch is a replay-equals-rehydration divergence deepStrictEqual
  // catches: deleting the last card holding a plan/step would otherwise leave
  // replay with `plans: []` and rehydration with no key. Destructuring the keys
  // out of `rest` is load-bearing — spreading an empty `readd()` over a base
  // that still carried the key would NOT remove it.
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

/** Upsert a label into the read model's catalogue, kept in canonical
    `compareBoardLabels` order — the same comparator `loadBoardState` applies to
    rows, so replay and rehydration cannot diverge on catalogue order. Every
    label event (create/update/delete/undelete) carries the full post-change
    label, so this one path serves them all. */
function upsertLabel(model: OrchestrationReadModel, label: BoardLabel): OrchestrationReadModel {
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
function upsertStage(
  model: OrchestrationReadModel,
  stage: BoardStageDefinition,
): OrchestrationReadModel {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const current = boardStages(board);
  const stages = (
    current.some((existing) => existing.stageId === stage.stageId)
      ? current.map((existing) => (existing.stageId === stage.stageId ? stage : existing))
      : [...current, stage]
  ).toSorted(compareBoardStages);
  return { ...model, board: { ...board, stages } };
}

/** Remove a stage definition from the in-memory model (t3o-15). */
function removeStage(
  model: OrchestrationReadModel,
  stageId: BoardStageDefinition["stageId"],
): OrchestrationReadModel {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const stages = boardStages(board).filter((stage) => stage.stageId !== stageId);
  return { ...model, board: { ...board, stages } };
}

/** Counter bump on create: monotonic max, so replaying a legacy event
    (cardNumber 0) still lands the counter at 1, matching the
    `MAX(card_number) + 1` rehydration. */
function bumpNextCardNumber(
  model: OrchestrationReadModel,
  payload: BoardCardCreatedPayload,
): OrchestrationReadModel {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const current = board.nextCardNumberByProject[payload.projectId] ?? 1;
  return {
    ...model,
    board: {
      ...board,
      nextCardNumberByProject: {
        ...board.nextCardNumberByProject,
        [payload.projectId]: Math.max(current, payload.cardNumber + 1),
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
function upsertStepCompletion(
  model: OrchestrationReadModel,
  completion: BoardStepCompletion,
): OrchestrationReadModel {
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

/** Upsert a card's live step state by cardId (t3o-10). One record per card,
    so a new state for a card replaces its prior one — selecting the next step
    of a multi-step recipe overwrites the previous step's terminal record. */
function upsertStepState(
  model: OrchestrationReadModel,
  state: BoardCardStepState,
): OrchestrationReadModel {
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

/** Replace a card's whole plan set (board_propose_plans is a wholesale
    replace). Bodies are stripped — they live only in `board_plans`. */
function replaceCardPlans(
  model: OrchestrationReadModel,
  cardId: BoardPlan["cardId"],
  plans: ReadonlyArray<BoardPlan>,
): OrchestrationReadModel {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const others = (board.plans ?? []).filter((plan) => plan.cardId !== cardId);
  const next = [...others, ...plans].toSorted(compareBoardPlans);
  return { ...model, board: { ...board, plans: next } };
}

/** Upsert one plan's metadata (board_write_plan bumps `updatedAt`). */
function upsertPlan(model: OrchestrationReadModel, plan: BoardPlan): OrchestrationReadModel {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const current = board.plans ?? [];
  const plans = (
    current.some((existing) => existing.planId === plan.planId)
      ? current.map((existing) => (existing.planId === plan.planId ? plan : existing))
      : [...current, plan]
  ).toSorted(compareBoardPlans);
  return { ...model, board: { ...board, plans } };
}

export function projectBoardEvent(
  model: OrchestrationReadModel,
  event: BoardEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  switch (event.type) {
    case "board.card-created":
      return decodeBoardCardCreatedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) =>
          bumpNextCardNumber(upsertCard(model, boardCardFromCreatedPayload(payload)), payload),
        ),
      );

    case "board.card-moved":
      return decodeBoardCardMovedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-reordered":
      return decodeBoardCardReorderedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-updated":
      return decodeBoardCardUpdatedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-thread-linked":
      return decodeBoardCardThreadLinkedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-thread-unlinked":
      return decodeBoardCardThreadUnlinkedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-archived":
      // The card stays in the model (archivedAt set) so unarchive can
      // restore it on replay; only the shell drops it.
      return decodeBoardCardArchivedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-unarchived":
      return decodeBoardCardUnarchivedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-deleted":
      // The opposite of archive: the card leaves the model for good, so a
      // from-empty replay of a log containing this event reaches a state with
      // no trace of the card — matching the tables the projection just purged.
      return decodeBoardCardDeletedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => removeCard(model, payload.cardId)),
      );

    case "board.label-created":
      return decodeBoardLabelCreatedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertLabel(model, payload.label)),
      );

    case "board.label-updated":
      return decodeBoardLabelUpdatedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertLabel(model, payload.label)),
      );

    case "board.label-deleted":
      return decodeBoardLabelDeletedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertLabel(model, payload.label)),
      );

    case "board.label-undeleted":
      return decodeBoardLabelUndeletedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertLabel(model, payload.label)),
      );

    case "board.card-step-completed":
      return decodeBoardCardStepCompletedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepCompletion(model, payload.completion)),
      );

    case "board.plans-proposed":
      return decodeBoardPlansProposedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) =>
          replaceCardPlans(
            model,
            payload.cardId,
            // Strip the body — read model holds metadata only (D8).
            payload.plans.map(({ body: _body, ...plan }) => plan),
          ),
        ),
      );

    case "board.plan-written":
      return decodeBoardPlanWrittenPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertPlan(model, payload.plan)),
      );

    case "board.plans-approved":
      // The children rode their own card-created events and the parent's move
      // its card-moved (t3o-23, D2); this event re-asserts the post-approval
      // parent so replay is whole even if the move was skipped (parent
      // already sitting in Building).
      return decodeBoardPlansApprovedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-integration-branch-recorded":
      return decodeBoardCardIntegrationBranchRecordedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worktree-provisioning":
      return decodeBoardCardWorktreeProvisioningPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worktree-ready":
      return decodeBoardCardWorktreeReadyPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worktree-failed":
      return decodeBoardCardWorktreeFailedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-worktree-reclaimed":
      return decodeBoardCardWorktreeReclaimedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    case "board.card-pull-request-recorded":
      return decodeBoardCardPullRequestRecordedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertCard(model, payload.card)),
      );

    // Reporting only — it changes no card field, so the read model is
    // unchanged and a replay that includes it lands exactly where a replay
    // without it would.
    case "board.card-note-recorded":
      return Effect.succeed(model);

    case "board.stage-created":
      return decodeBoardStageCreatedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStage(model, payload.stage)),
      );

    case "board.stage-renamed":
      return decodeBoardStageRenamedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStage(model, payload.stage)),
      );

    case "board.stage-reordered":
      return decodeBoardStageReorderedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStage(model, payload.stage)),
      );

    case "board.stage-deleted":
      return decodeBoardStageDeletedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => removeStage(model, payload.stageId)),
      );

    case "board.card-stage-thread-requested":
      // A request signal only — the reactor reacts; the read model is unchanged.
      // Decoded to fail loudly on a malformed event.
      return decodeBoardCardStageThreadRequestedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.as(model),
      );

    case "board.card-step-selected":
      return decodeBoardCardStepSelectedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-admitted":
      return decodeBoardCardStepAdmittedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-awaiting-input":
      return decodeBoardCardStepAwaitingInputPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-recovered":
      return decodeBoardCardStepRecoveredPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-settled":
      return decodeBoardCardStepSettledPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    case "board.card-step-retuned":
      return decodeBoardCardStepRetunedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.map((payload) => upsertStepState(model, payload.state)),
      );

    default: {
      event satisfies never;
      // Runtime backstop for an undecoded event: leave the model unchanged.
      return Effect.succeed(model);
    }
  }
}

/**
 * Deltas carry the bounded `BoardCardShell` (t3o-04), built purely from the
 * event's own card. This mapping has no thread shells at hand, so the
 * shell's thread-derived fields leave here at their "none" resting state
 * and the client reducer re-derives them from `activeThreadId` against the
 * thread shells it already holds — see `boardCardShellFromCard`.
 */
export function boardShellStreamEvent(
  event: BoardEvent,
): Option.Option<OrchestrationShellStreamEvent> {
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
    case "board.card-reordered":
    case "board.card-thread-linked":
    case "board.card-thread-unlinked":
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
    // The PR link IS on the bounded shell (`hasPr` / `prNumber`), and it rides
    // the card aggregate — so this delta carries the real value like any other
    // card field, with no absent-means-preserve dance.
    case "board.card-pull-request-recorded":
      return Option.some({
        kind: "card-upserted",
        sequence: event.sequence,
        card: boardCardShellFromCard(event.payload.card),
      });

    case "board.stage-created":
    case "board.stage-renamed":
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
      // The one step transition that IS a column-card shell field (t3o-11,
      // D11): admission flips the card's `queued` badge — held for a slot
      // (`state.status === "queued"`) or admitted to running. Only this one
      // boolean rides the shell; the rest of the step state stays DETAIL on
      // board.subscribeCard. A dedicated `card-queued` delta rather than a
      // `card-upserted` because this event carries `state`, not the card, so
      // the full bounded shell cannot be rebuilt here (D7 keeps it one bit).
      return Option.some({
        kind: "card-queued",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        queued: event.payload.state.status === "queued",
        // Admission also settles the durable "being worked" dot: held for a slot
        // (`queued`) means not running; admitted to running lights `stepRunning`.
        stepRunning: event.payload.state.status === "running",
      });

    case "board.card-step-recovered":
      // The second step transition that IS a column-card shell field (t3o-17,
      // D3): recovery either gave up (→ `stalled`, the loud badge) or put the
      // step back to work on a retry (→ running, badge cleared). A dedicated
      // `card-stalled` delta, the exact analogue of `card-queued` above, because
      // this event carries `state`, not the card, so the full bounded shell
      // cannot be rebuilt here (D7 keeps it one bit).
      return Option.some({
        kind: "card-stalled",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        stalled: event.payload.state.status === "stalled",
        // Recovery either put the step back to running (dot re-lights) or landed
        // it stalled (dot dark) — carry the durable flag on the same delta.
        stepRunning: event.payload.state.status === "running",
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
      });

    case "board.card-step-settled":
      // A settled step is terminal — never stalled — so clear the badge. This
      // covers the one path a stalled step leaves without a fresh select-step:
      // a human takes over the stalled step's still-live thread and calls
      // board_complete_step, settling it to `succeeded`. The clear is idempotent
      // (already-false is a client no-op), so emitting it on the common
      // non-stalled completion is harmless.
      return Option.some({
        kind: "card-stalled",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        stalled: false,
        // A settled step is terminal — not running — so the durable dot goes
        // dark here (a converged loop that stops running turns stops being lit).
        stepRunning: false,
      });

    case "board.plans-proposed":
      // The card's plan set was replaced wholesale, which moves the column
      // card's plan indicator (t3o-08). Only the COUNT rides the shell; the
      // plans themselves stay on board.subscribeCard. A dedicated delta rather
      // than a `card-upserted` because this event carries the plans and the
      // card id, never the card, so the bounded shell cannot be rebuilt here.
      return Option.some({
        kind: "card-plans",
        sequence: event.sequence,
        cardId: event.payload.cardId,
        planCount: event.payload.plans.length,
      });

    case "board.card-step-completed":
      // A REVIEW phase completing changes the column card (t3o-22, D7): round
      // pips, the severity chip, the issue tally and the convergence flag. A
      // dedicated delta rather than a `card-upserted` because this event
      // carries the completion and the card id, never the card. Every other
      // step completion still changes nothing a column card renders, and the
      // decider omits the summary for those, so they fall through below.
      if (event.payload.reviewSummary !== undefined) {
        return Option.some({
          kind: "card-review",
          sequence: event.sequence,
          cardId: event.payload.cardId,
          summary: event.payload.reviewSummary,
        });
      }
      return Option.none();

    case "board.plan-written":
    case "board.card-stage-thread-requested":
    // Step-lifecycle events (t3o-10) are card DETAIL — the live step status
    // rides board.subscribeCard, not a column-card shell field (D7 payload
    // discipline). The column card's thread-derived indicators already reflect
    // the step's thread through the existing `threadState`/`awaitingInput`
    // fields, so a step transition needs no separate shell delta.
    case "board.card-step-awaiting-input":
    case "board.card-step-retuned":
    // Branch cleanup is card DETAIL too: it lands on the activity rail, which
    // rides `board.subscribeCard`, and changes nothing a column card renders.
    case "board.card-note-recorded":
      // Agent write-path events are card DETAIL, not column-card shell fields
      // (D7): an agent's progress note, a non-review step completion or a plan
      // BODY rewrite changes nothing a column card renders, so they emit no
      // shell delta.
      // They reach a client through board.subscribeCard / the MCP context tool.
      // (A step leaving `queued` always does so via `card-step-admitted` above,
      // so the badge clears there — never here; and a plan SET change rides
      // `card-plans` above, which `board.plan-written` never causes.)
      return Option.none();

    default: {
      event satisfies never;
      return Option.none();
    }
  }
}
