/**
 * T3o board projector — `projectBoardEvent`.
 *
 * Applies board events to the in-memory orchestration read model, delegated
 * to from the upstream projector's switch. Also maps board events to card
 * shell deltas for the shell stream (delegated to from ws.ts), which needs no
 * projection re-read: the created payload already carries the whole card.
 */
import {
  BoardCardCreatedPayload,
  EMPTY_BOARD_STATE,
  type BoardCard,
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

const decodeBoardCardCreatedPayload = Schema.decodeUnknownEffect(BoardCardCreatedPayload);

// Canonical card order — MUST match the `ORDER BY created_at ASC, card_id ASC`
// of `listBoardCards`, or the from-empty replay read model would diverge from
// the table-rehydrated one whenever cards are created out of timestamp order
// (createdAt is client-supplied, so dispatch order ≠ createdAt order in
// general). Mirrors the upstream projector's `localeCompare` sort idiom, which
// agrees with SQLite's ordering for the ASCII ISO timestamps and ids used here.
function compareBoardCards(left: BoardCard, right: BoardCard): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function upsertCard(model: OrchestrationReadModel, card: BoardCard): OrchestrationReadModel {
  const board = model.board ?? EMPTY_BOARD_STATE;
  const cards = (
    board.cards.some((existing) => existing.id === card.id)
      ? board.cards.map((existing) => (existing.id === card.id ? card : existing))
      : [...board.cards, card]
  ).toSorted(compareBoardCards);
  return { ...model, board: { cards } };
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
          upsertCard(model, {
            id: payload.cardId,
            projectId: payload.projectId,
            title: payload.title,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          }),
        ),
      );

    default:
      // Explicit terminal default: an unrecognized board event leaves the
      // read model unchanged rather than throwing. (Becomes a compile-time
      // exhaustiveness guard once BoardEvent has a second member.)
      return Effect.succeed(model);
  }
}

export function boardCardShellStreamEvent(
  event: BoardEvent,
): Option.Option<OrchestrationShellStreamEvent> {
  switch (event.type) {
    case "board.card-created":
      return Option.some({
        kind: "card-upserted",
        sequence: event.sequence,
        card: {
          id: event.payload.cardId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        },
      });

    default:
      // Explicit terminal default: an event with no shell projection yields
      // no delta. (Becomes a compile-time exhaustiveness guard once BoardEvent
      // has a second member.)
      return Option.none();
  }
}
