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
  BoardCardArchivedPayload,
  boardCardCreatedLabels,
  BoardCardCreatedPayload,
  BoardCardMovedPayload,
  BoardCardReorderedPayload,
  BoardCardThreadLinkedPayload,
  BoardCardThreadUnlinkedPayload,
  BoardCardUnarchivedPayload,
  BoardCardUpdatedPayload,
  boardCardShellFromCard,
  boardLabelCatalogue,
  BoardLabelCreatedPayload,
  BoardLabelDeletedPayload,
  BoardLabelUndeletedPayload,
  BoardLabelUpdatedPayload,
  compareBoardLabels,
  EMPTY_BOARD_STATE,
  isBoardEvent,
  type BoardCard,
  type BoardLabel,
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
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    threadLinks: [],
    externalRef: null,
    recipeSnapshot: null,
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

    default: {
      event satisfies never;
      return Option.none();
    }
  }
}
