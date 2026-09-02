import {
  // T3o: card + label + stage aggregate ids (D9 / t3o-06a / t3o-15).
  BoardCardId,
  BoardLabelId,
  BoardStageId,
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../Services/OrchestrationEventStore.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

/**
 * Every event type THIS build knows about.
 *
 * Read rows are checked against this set per row (in `readPage`) rather than by
 * typing the row schema's `type` column as `OrchestrationEventType`. A closed
 * literal union in the row schema makes a RETIRED event type fatal: the failure
 * takes down the whole 500-row page, and with it replay — and therefore boot —
 * for every event after it. The log is append-only and permanent, so a type that
 * is dropped from the union still has rows on disk forever.
 */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(OrchestrationEventType.literals);

/**
 * T3o: matched against the raw `event_type` column, so this tests the prefix
 * directly rather than reusing `isBoardEvent` from contracts — that predicate
 * narrows a discriminated union of literal types and collapses a plain-string
 * column to `never`.
 */
const BOARD_EVENT_TYPE_PREFIX = "board.";
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const EventMetadataFromJsonString = Schema.fromJsonString(OrchestrationEventMetadata);

const AppendEventRequestSchema = Schema.Struct({
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  // T3o: BoardCardId appended for card-aggregate event streams (D9);
  // BoardLabelId for the label aggregate (t3o-06a). Frozen widening.
  streamId: Schema.Union([ProjectId, ThreadId, BoardCardId, BoardLabelId, BoardStageId]),
  type: OrchestrationEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: EventMetadataFromJsonString,
});

const OrchestrationEventPersistedRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  // T3o: plain strings, NOT the closed literal unions — see KNOWN_EVENT_TYPES.
  // Rows are re-validated per row (via `decodeReadRow` -> `decodeEvent`, which
  // checks both against the full `OrchestrationEvent` union) so one retired value
  // cannot fail the whole page. `aggregateKind` gets the same treatment as
  // `type` because it carries the same risk: t3o added `card`, `label` and
  // `stage`, and retiring any of them would otherwise brick replay identically.
  // Append still validates strictly via `AppendEventRequestSchema`.
  type: Schema.String,
  aggregateKind: Schema.String,
  // T3o: BoardCardId appended for card-aggregate event rows (D9); BoardLabelId
  // for the label aggregate (t3o-06a). Frozen widening.
  aggregateId: Schema.Union([ProjectId, ThreadId, BoardCardId, BoardLabelId, BoardStageId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  // T3o: parsed to a raw value here (still fatal on malformed JSON = corruption),
  // validated against `OrchestrationEventMetadata` per row by `decodeEvent`. See
  // the `aggregateId` note above.
  metadata: UnknownFromJsonString,
});

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  limit: Schema.Number,
});
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000;
const READ_PAGE_SIZE = 500;

function inferActorKind(
  event: Omit<OrchestrationEvent, "sequence">,
): Schema.Schema.Type<typeof OrchestrationActorKind> {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) {
    return "provider";
  }
  if (event.commandId !== null && event.commandId.startsWith("server:")) {
    return "server";
  }
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  if (event.commandId === null) {
    return "server";
  }
  return "client";
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): OrchestrationEventStoreError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/**
 * Decode one read row, or skip it.
 *
 * A `board.*` type this build does not know is one t3o RETIRED: its rows are
 * still on disk (the log is append-only and permanent), nothing can interpret
 * them, and board state is a projection that rebuilds fine without them.
 * Skipping keeps replay alive; the warning keeps the skip visible.
 *
 * Every other unknown type stays fatal, deliberately. An unrecognised `thread.*`
 * means this build is reading a log written by a NEWER one, where dropping
 * events silently would advance the projection watermark past thread history
 * that cannot be recovered. A malformed payload on a KNOWN type stays fatal too:
 * that is corruption, not evolution.
 */
const decodeReadRow = (
  row: Schema.Schema.Type<typeof OrchestrationEventPersistedRowSchema>,
): Effect.Effect<OrchestrationEvent | undefined, OrchestrationEventStoreError> => {
  if (!KNOWN_EVENT_TYPES.has(row.type) && row.type.startsWith(BOARD_EVENT_TYPE_PREFIX)) {
    return Effect.as(
      Effect.logWarning("Skipping retired board event type during replay").pipe(
        Effect.annotateLogs({
          eventType: row.type,
          sequence: row.sequence,
          eventId: row.eventId,
        }),
      ),
      undefined,
    );
  }
  return decodeEvent(row).pipe(
    Effect.mapError(
      toPersistenceDecodeError("OrchestrationEventStore.readFromSequence:rowToEvent"),
    ),
  );
};

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEventRow = SqlSchema.findOne({
    Request: AppendEventRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${request.eventId},
          ${request.aggregateKind},
          ${request.streamId},
          COALESCE(
            (
              SELECT stream_version + 1
              FROM orchestration_events
              WHERE aggregate_kind = ${request.aggregateKind}
                AND stream_id = ${request.streamId}
              ORDER BY stream_version DESC
              LIMIT 1
            ),
            0
          ),
          ${request.type},
          ${request.occurredAt},
          ${request.commandId},
          ${request.causationEventId},
          ${request.correlationId},
          ${request.actorKind},
          ${request.payloadJson},
          ${request.metadataJson}
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
      `,
  });

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });

  const append: OrchestrationEventStoreShape["append"] = (event) =>
    appendEventRow({
      eventId: event.eventId,
      aggregateKind: event.aggregateKind,
      streamId: event.aggregateId,
      type: event.type,
      causationEventId: event.causationEventId,
      correlationId: event.correlationId,
      actorKind: inferActorKind(event),
      occurredAt: event.occurredAt,
      commandId: event.commandId,
      payloadJson: event.payload,
      metadataJson: event.metadata,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.append:insert",
          "OrchestrationEventStore.append:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        decodeEvent(row).pipe(
          Effect.mapError(toPersistenceDecodeError("OrchestrationEventStore.append:rowToEvent")),
        ),
      ),
    );

  const readFromSequence: OrchestrationEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
  ) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) {
      return Stream.empty;
    }
    const readPage = (
      cursor: number,
      remaining: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "OrchestrationEventStore.readFromSequence:query",
              "OrchestrationEventStore.readFromSequence:decodeRows",
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, decodeReadRow).pipe(
              Effect.map((decoded) => ({
                events: decoded.filter((event): event is OrchestrationEvent => event !== undefined),
                // T3o: paging is driven by the ROWS READ, never by the events
                // decoded from them. A page whose rows were all skipped still has
                // to advance the cursor — treating it as end-of-stream would
                // silently truncate replay at the first retired event.
                rowsRead: rows.length,
                lastSequence: rows[rows.length - 1]?.sequence ?? cursor,
              })),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap(({ events, rowsRead, lastSequence }) => {
          if (rowsRead === 0) {
            return Stream.empty;
          }
          // `limit` bounds the rows SCANNED, not the events yielded: a caller
          // that computed it from a sequence gap (the shell resume path does)
          // expects the read to stop at that head, and counting only decoded
          // events would let a page of skipped rows carry the scan past it.
          const nextRemaining = remaining - rowsRead;
          if (nextRemaining <= 0) {
            return Stream.fromIterable(events);
          }
          return Stream.concat(Stream.fromIterable(events), readPage(lastSequence, nextRemaining));
        }),
      );

    return readPage(sequenceExclusive, normalizedLimit);
  };

  return {
    append,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);
