/**
 * The board's own event log and command receipts, in `boards.sqlite` (T3O-56).
 *
 * Same row shape as upstream's `orchestration_events`, its own `AUTOINCREMENT`
 * sequence. Every statement names a `boards.` table, so a transaction built from
 * these writes exactly one database file.
 *
 * Not a service: `BoardEngine` is the only writer, and it composes these inside
 * its own transaction.
 */
import {
  BoardEvent,
  BoardEventType,
  CommandId,
  commandIdOrigin,
  EventId,
  IsoDateTime,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";

import type { PlannedBoardEvent } from "./decider.ts";

/** One command receipt: proof a command id was handled, and how. */
export interface BoardCommandReceipt {
  readonly commandId: CommandId;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly acceptedAt: string;
  readonly resultSequence: number;
  readonly status: "accepted" | "rejected";
  readonly error: string | null;
}

const decodeEvent = Schema.decodeUnknownEffect(BoardEvent);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

/**
 * Board event types THIS build knows. A row of any other `board.*` type is one
 * the board retired: the log is permanent, nothing can interpret the row, and
 * board state is rebuilt from the board tables rather than from replay — so it
 * is skipped, loudly, instead of failing the page it sits in.
 */
const KNOWN_BOARD_EVENT_TYPES: ReadonlySet<string> = new Set<string>(BoardEventType.literals);

const BoardEventRow = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: Schema.String,
  aggregateKind: Schema.String,
  aggregateId: Schema.String,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: UnknownFromJsonString,
});
type BoardEventRow = typeof BoardEventRow.Type;

const AppendRequest = Schema.Struct({
  eventId: EventId,
  aggregateKind: Schema.String,
  streamId: Schema.String,
  type: Schema.String,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: Schema.String,
  payloadJson: UnknownFromJsonString,
  metadataJson: UnknownFromJsonString,
});

const ReceiptRow = Schema.Struct({
  commandId: CommandId,
  aggregateKind: Schema.String,
  aggregateId: Schema.String,
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: Schema.Literals(["accepted", "rejected"]),
  error: Schema.NullOr(Schema.String),
});

const READ_PAGE_SIZE = 500;

/** Who caused an event, by the same rule upstream's store applies. */
function inferActorKind(event: PlannedBoardEvent): string {
  const declared = commandIdOrigin(event.commandId);
  if (declared !== null) return declared;
  if (event.commandId === null) return "server";
  return "client";
}

const decodeRow = (
  row: BoardEventRow,
): Effect.Effect<BoardEvent | undefined, ProjectionRepositoryError> => {
  if (!KNOWN_BOARD_EVENT_TYPES.has(row.type)) {
    return Effect.as(
      Effect.logWarning("Skipping retired board event type during replay").pipe(
        Effect.annotateLogs({ eventType: row.type, sequence: row.sequence, eventId: row.eventId }),
      ),
      undefined,
    );
  }
  return decodeEvent(row).pipe(
    Effect.mapError(toPersistenceDecodeError("BoardEventStore.decodeRow")),
  );
};

export function makeBoardEventStore(sql: SqlClient.SqlClient) {
  const appendRow = SqlSchema.findOne({
    Request: AppendRequest,
    Result: BoardEventRow,
    execute: (request) => sql`
      INSERT INTO boards.board_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      )
      VALUES (
        ${request.eventId},
        ${request.aggregateKind},
        ${request.streamId},
        COALESCE(
          (
            SELECT stream_version + 1 FROM boards.board_events
            WHERE aggregate_kind = ${request.aggregateKind} AND stream_id = ${request.streamId}
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

  const readRows = SqlSchema.findAll({
    Request: Schema.Struct({ afterSequence: NonNegativeInt, limit: Schema.Number }),
    Result: BoardEventRow,
    execute: (request) => sql`
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
      FROM boards.board_events
      WHERE sequence > ${request.afterSequence}
      ORDER BY sequence ASC
      LIMIT ${request.limit}
    `,
  });

  const findReceipt = SqlSchema.findOneOption({
    Request: Schema.Struct({ commandId: CommandId }),
    Result: ReceiptRow,
    execute: ({ commandId }) => sql`
      SELECT
        command_id AS "commandId",
        aggregate_kind AS "aggregateKind",
        aggregate_id AS "aggregateId",
        accepted_at AS "acceptedAt",
        result_sequence AS "resultSequence",
        status,
        error
      FROM boards.board_command_receipts
      WHERE command_id = ${commandId}
    `,
  });

  const upsertReceiptRow = SqlSchema.void({
    Request: ReceiptRow,
    execute: (receipt) => sql`
      INSERT INTO boards.board_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
      )
      VALUES (
        ${receipt.commandId}, ${receipt.aggregateKind}, ${receipt.aggregateId},
        ${receipt.acceptedAt}, ${receipt.resultSequence}, ${receipt.status}, ${receipt.error}
      )
      ON CONFLICT (command_id) DO UPDATE SET
        aggregate_kind = excluded.aggregate_kind,
        aggregate_id = excluded.aggregate_id,
        accepted_at = excluded.accepted_at,
        result_sequence = excluded.result_sequence,
        status = excluded.status,
        error = excluded.error
    `,
  });

  const findWatermark = SqlSchema.findOneOption({
    Request: Schema.Struct({ projector: Schema.String }),
    Result: Schema.Struct({ lastAppliedSequence: NonNegativeInt }),
    execute: ({ projector }) => sql`
      SELECT last_applied_sequence AS "lastAppliedSequence"
      FROM boards.projection_state
      WHERE projector = ${projector}
    `,
  });

  const upsertWatermarkRow = SqlSchema.void({
    Request: Schema.Struct({
      projector: Schema.String,
      lastAppliedSequence: NonNegativeInt,
      updatedAt: IsoDateTime,
    }),
    execute: (row) => sql`
      INSERT INTO boards.projection_state (projector, last_applied_sequence, updated_at)
      VALUES (${row.projector}, ${row.lastAppliedSequence}, ${row.updatedAt})
      ON CONFLICT (projector) DO UPDATE SET
        last_applied_sequence = excluded.last_applied_sequence,
        updated_at = excluded.updated_at
    `,
  });

  const append = (event: PlannedBoardEvent): Effect.Effect<BoardEvent, ProjectionRepositoryError> =>
    appendRow({
      eventId: event.eventId,
      aggregateKind: event.aggregateKind,
      streamId: event.aggregateId,
      type: event.type,
      occurredAt: event.occurredAt,
      commandId: event.commandId,
      causationEventId: event.causationEventId,
      correlationId: event.correlationId,
      actorKind: inferActorKind(event),
      payloadJson: event.payload,
      metadataJson: event.metadata,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("BoardEventStore.append:insert")),
      Effect.flatMap(decodeRow),
      Effect.flatMap((saved) =>
        saved === undefined
          ? Effect.die(new Error(`Appended an unknown board event type '${event.type}'.`))
          : Effect.succeed(saved),
      ),
    );

  /** Every event after `afterSequence`, in order, paged. Paging advances on the
      rows READ, so a page of skipped retired rows never ends the stream early. */
  const readFrom = (afterSequence: number): Stream.Stream<BoardEvent, ProjectionRepositoryError> =>
    Stream.paginate(afterSequence, (cursor) =>
      readRows({ afterSequence: cursor, limit: READ_PAGE_SIZE }).pipe(
        Effect.mapError(toPersistenceSqlError("BoardEventStore.readFrom:query")),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, decodeRow).pipe(
            Effect.map((decoded) => {
              const events = decoded.filter((event): event is BoardEvent => event !== undefined);
              const last = rows.at(-1)?.sequence;
              return [
                events,
                rows.length < READ_PAGE_SIZE || last === undefined
                  ? Option.none<number>()
                  : Option.some(last),
              ] as const;
            }),
          ),
        ),
      ),
    );

  const latestSequence = sql<{ readonly sequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS sequence FROM boards.board_events
  `.pipe(
    Effect.map((rows) => rows[0]?.sequence ?? 0),
    Effect.mapError(toPersistenceSqlError("BoardEventStore.latestSequence:query")),
  );

  const getReceipt = (commandId: CommandId) =>
    findReceipt({ commandId }).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(toPersistenceSqlError("BoardEventStore.getReceipt:query")),
    );

  const upsertReceipt = (receipt: BoardCommandReceipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("BoardEventStore.upsertReceipt:query")),
    );

  const getWatermark = (projector: string) =>
    findWatermark({ projector }).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.lastAppliedSequence })),
      Effect.mapError(toPersistenceSqlError("BoardEventStore.getWatermark:query")),
    );

  const setWatermark = (projector: string, lastAppliedSequence: number, updatedAt: string) =>
    upsertWatermarkRow({ projector, lastAppliedSequence, updatedAt }).pipe(
      Effect.mapError(toPersistenceSqlError("BoardEventStore.setWatermark:query")),
    );

  return {
    append,
    readFrom,
    latestSequence,
    getReceipt,
    upsertReceipt,
    getWatermark,
    setWatermark,
  };
}

export type BoardEventStore = ReturnType<typeof makeBoardEventStore>;
