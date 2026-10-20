/**
 * T3o board events (T3O-56).
 *
 * Board events are not orchestration events: they live in the board's own log
 * (`boards.board_events`) with their own sequence, and upstream's
 * `OrchestrationEvent` union knows nothing of them. Their envelope mirrors
 * upstream's event base fields, with the board's own aggregates.
 *
 * Its own file because it needs both `orchestration.ts` (the event metadata) and
 * `board.ts` (the members), and `orchestration.ts` already imports `board.ts`.
 */
import * as Schema from "effect/Schema";

import { CommandId, EventId, IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import {
  BOARD_EVENT_TYPES,
  BoardCardId,
  BoardLabelId,
  BoardStageId,
  makeBoardOrchestrationEvents,
} from "./board.ts";
import { OrchestrationEventMetadata } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** The board's aggregates: a card, a label, a stage, and a provider instance's
    cooldown (T3O-22) — which belongs to an account, not to any card. */
export const BoardAggregateKind = Schema.Literals(["card", "label", "stage", "provider-limit"]);
export type BoardAggregateKind = typeof BoardAggregateKind.Type;

export const BoardEventType = Schema.Literals(BOARD_EVENT_TYPES);
export type BoardEventType = typeof BoardEventType.Type;

const BoardEventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: BoardAggregateKind,
  aggregateId: Schema.Union([BoardCardId, BoardLabelId, BoardStageId, ProviderInstanceId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const BoardEvent = Schema.Union(makeBoardOrchestrationEvents(BoardEventBaseFields));
export type BoardEvent = typeof BoardEvent.Type;
