/**
 * T3o board events (T3O-56).
 *
 * Board events are not orchestration events: they live in the board's own log
 * (`boards.board_events`) with their own sequence, and upstream's
 * `OrchestrationEvent` union knows nothing of them. Their envelope mirrors
 * upstream's event base fields, with the board's own aggregates.
 *
 * Its own file so `board.ts` (the members) stays free of the envelope.
 */
import * as Schema from "effect/Schema";

import { OrchestrationClientOrigin } from "./applicationEvent.ts";
import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  BOARD_EVENT_TYPES,
  BoardCardId,
  BoardLabelId,
  BoardStageId,
  makeBoardOrchestrationEvents,
} from "./board.ts";
import { BoardWorkerId } from "./boardWorkers.ts";

/**
 * A board event's metadata. The board itself writes only `origin`; the other
 * keys are the v1 orchestration event metadata's, kept so a row the board
 * inherited from upstream's log (migration 044) still decodes after v1 went.
 */
export const BoardEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(TrimmedNonEmptyString),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(TrimmedNonEmptyString),
  ingestedAt: Schema.optional(IsoDateTime),
  historyImport: Schema.optional(Schema.Boolean),
  deferredTurn: Schema.optional(Schema.Boolean),
  origin: Schema.optional(OrchestrationClientOrigin),
});
export type BoardEventMetadata = typeof BoardEventMetadata.Type;

/** The board's aggregates: a card, a label, a stage, and a worker. */
export const BoardAggregateKind = Schema.Literals([
  "card",
  "label",
  "stage",
  // T3O-62: a registered worker, and the board's default-worker choice.
  "worker",
]);
export type BoardAggregateKind = typeof BoardAggregateKind.Type;

export const BoardEventType = Schema.Literals(BOARD_EVENT_TYPES);
export type BoardEventType = typeof BoardEventType.Type;

const BoardEventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: BoardAggregateKind,
  aggregateId: Schema.Union([BoardCardId, BoardLabelId, BoardStageId, BoardWorkerId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: BoardEventMetadata,
} as const;

export const BoardEvent = Schema.Union(makeBoardOrchestrationEvents(BoardEventBaseFields));
export type BoardEvent = typeof BoardEvent.Type;
