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
 * restore the card on a from-empty replay.
 */
import {
  BOARD_CARD_BRIEF_BODY_KIND,
  BoardCardArchivedPayload,
  boardCardCreatedDependsOn,
  boardCardCreatedLabels,
  BoardCardCreatedPayload,
  BoardCardInputRequestedPayload,
  BoardCardMovedPayload,
  BoardCardProgressReportedPayload,
  BoardCardReorderedPayload,
  BoardCardStepCompletedPayload,
  BoardCardThreadLinkedPayload,
  BoardCardThreadUnlinkedPayload,
  BoardCardUnarchivedPayload,
  BoardCardWorktreeFailedPayload,
  BoardCardWorktreeProvisioningPayload,
  BoardCardWorktreeReadyPayload,
  BoardCardWorktreeReclaimedPayload,
  BoardCardUpdatedPayload,
  boardCardShellFromCard,
  boardLabelCatalogue,
  BoardLabelCreatedPayload,
  BoardLabelDeletedPayload,
  BoardLabelUndeletedPayload,
  BoardLabelUpdatedPayload,
  BoardPlansProposedPayload,
  BoardPlanWrittenPayload,
  compareBoardLabels,
  EMPTY_BOARD_STATE,
  isBoardEvent,
  type BoardCard,
  type BoardLabel,
  type BoardPlan,
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
const decodeBoardCardUnarchivedPayload = Schema.decodeUnknownEffect(BoardCardUnarchivedPayload);
const decodeBoardLabelCreatedPayload = Schema.decodeUnknownEffect(BoardLabelCreatedPayload);
const decodeBoardLabelUpdatedPayload = Schema.decodeUnknownEffect(BoardLabelUpdatedPayload);
const decodeBoardLabelDeletedPayload = Schema.decodeUnknownEffect(BoardLabelDeletedPayload);
const decodeBoardLabelUndeletedPayload = Schema.decodeUnknownEffect(BoardLabelUndeletedPayload);
const decodeBoardCardProgressReportedPayload = Schema.decodeUnknownEffect(
  BoardCardProgressReportedPayload,
);
const decodeBoardCardInputRequestedPayload = Schema.decodeUnknownEffect(
  BoardCardInputRequestedPayload,
);
const decodeBoardCardStepCompletedPayload = Schema.decodeUnknownEffect(
  BoardCardStepCompletedPayload,
);
const decodeBoardPlansProposedPayload = Schema.decodeUnknownEffect(BoardPlansProposedPayload);
const decodeBoardPlanWrittenPayload = Schema.decodeUnknownEffect(BoardPlanWrittenPayload);
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
    // projector. `dependsOn` rides the payload; a creation-stage card is
    // always before Ready, so it is never blocked at birth (D18).
    briefRef: payload.brief === undefined ? null : BOARD_CARD_BRIEF_BODY_KIND,
    dependsOn: boardCardCreatedDependsOn(payload),
    parentCardId: null,
    threadLinks: [],
    externalRef: null,
    recipeSnapshot: null,
    // A created card never has a worktree: it is provisioned lazily on entry
    // to Building (D6, t3o-09), never at birth.
    worktree: null,
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

    case "board.card-progress-reported":
      // Activity bodies never enter the read model (D8) — the SQL projector
      // writes them to `board_card_activity`; the read model is unchanged. The
      // payload is still decoded to fail loudly on a malformed event.
      return decodeBoardCardProgressReportedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.as(model),
      );

    case "board.card-input-requested":
      return decodeBoardCardInputRequestedPayload(event.payload).pipe(
        Effect.mapError(toProjectorDecodeError(`${event.type}:payload`)),
        Effect.as(model),
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
        card: boardCardShellFromCard(boardCardFromCreatedPayload(event.payload)),
      });

    case "board.card-moved":
    case "board.card-reordered":
    case "board.card-updated":
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
      return Option.some({
        kind: "card-upserted",
        sequence: event.sequence,
        card: boardCardShellFromCard(event.payload.card),
      });

    case "board.card-archived":
      // Archiving removes the card from the live board every client renders.
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

    case "board.card-progress-reported":
    case "board.card-input-requested":
    case "board.card-step-completed":
    case "board.plans-proposed":
    case "board.plan-written":
      // Agent write-path events are card DETAIL, not column-card shell fields
      // (D7): an agent's progress note, step completion or plan set changes
      // nothing a column card renders, so they emit no shell delta. They reach
      // a client through board.subscribeCard / the MCP context tool.
      return Option.none();

    default: {
      event satisfies never;
      return Option.none();
    }
  }
}
