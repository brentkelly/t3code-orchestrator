/**
 * Migration 044 (T3O-56): the board's history moves from upstream's log into
 * its own, in order, with receipts and watermarks renumbered into the board's
 * sequence space — and running it twice changes nothing.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import Migration044 from "./044_BoardEventLog.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const T = "2026-01-01T00:00:00.000Z";

/** Upstream's schema, and the board lineage up to (not including) 044. */
const schemaBefore044 = Effect.gen(function* () {
  yield* attachBoardDatabase();
  yield* runMigrations();
  for (const [id, , migration] of BOARD_MIGRATIONS) {
    if (id < 44) yield* migration;
  }
});

/** A v1 log: board events interleaved with thread events, as a t3o database
    written before T3O-56 holds them. */
const LOG = [
  { type: "thread.created", kind: "thread", stream: "thread-1" },
  { type: "board.card-created", kind: "card", stream: "card-1" },
  { type: "thread.message-sent", kind: "thread", stream: "thread-1" },
  { type: "board.card-moved", kind: "card", stream: "card-1" },
  { type: "board.label-created", kind: "label", stream: "label-1" },
  { type: "thread.activity-appended", kind: "thread", stream: "thread-1" },
  { type: "board.card-moved", kind: "card", stream: "card-1" },
] as const;

const seedV1Log = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const versions = new Map<string, number>();
  for (const [index, row] of LOG.entries()) {
    const version = versions.get(row.stream) ?? 0;
    versions.set(row.stream, version + 1);
    yield* sql`
      INSERT INTO main.orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      )
      VALUES (
        ${`evt-${index + 1}`}, ${row.kind}, ${row.stream}, ${version}, ${row.type}, ${T},
        ${`cmd-${index + 1}`}, ${null}, ${null}, ${"client"}, ${`{"n":${index + 1}}`}, ${"{}"}
      )
    `;
  }
  // An accepted board receipt points at its own (main) sequence 4; a rejected
  // one at main head 6 when it was refused; a thread receipt stays upstream's.
  for (const receipt of [
    { id: "cmd-4", kind: "card", aggregate: "card-1", sequence: 4, status: "accepted" },
    { id: "cmd-refused", kind: "card", aggregate: "card-1", sequence: 6, status: "rejected" },
    { id: "cmd-1", kind: "thread", aggregate: "thread-1", sequence: 1, status: "accepted" },
  ]) {
    yield* sql`
      INSERT INTO main.orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
      )
      VALUES (
        ${receipt.id}, ${receipt.kind}, ${receipt.aggregate}, ${T}, ${receipt.sequence},
        ${receipt.status}, ${receipt.status === "rejected" ? "No." : null}
      )
    `;
  }
  // The old board projector had applied through main sequence 5.
  yield* sql`
    INSERT INTO boards.projection_state (projector, last_applied_sequence, updated_at)
    VALUES ('projection.board-cards', 5, ${T})
  `;
});

const boardLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly sequence: number;
    readonly eventId: string;
    readonly type: string;
    readonly streamVersion: number;
    readonly payload: string;
  }>`
    SELECT sequence, event_id AS "eventId", event_type AS "type",
      stream_version AS "streamVersion", payload_json AS "payload"
    FROM boards.board_events ORDER BY sequence
  `;
});

const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    log: yield* boardLog,
    receipts: yield* sql`SELECT * FROM boards.board_command_receipts ORDER BY command_id`,
    watermarks: yield* sql`
      SELECT projector, last_applied_sequence AS "sequence"
      FROM boards.projection_state ORDER BY projector
    `,
  };
});

it.effect("copies board history into the board log in order, renumbered from 1", () =>
  Effect.gen(function* () {
    yield* schemaBefore044;
    yield* seedV1Log;
    yield* Migration044;

    assert.deepStrictEqual(yield* boardLog, [
      { sequence: 1, eventId: "evt-2", type: "board.card-created", streamVersion: 0, payload: '{"n":2}' },
      { sequence: 2, eventId: "evt-4", type: "board.card-moved", streamVersion: 1, payload: '{"n":4}' },
      { sequence: 3, eventId: "evt-5", type: "board.label-created", streamVersion: 0, payload: '{"n":5}' },
      { sequence: 4, eventId: "evt-7", type: "board.card-moved", streamVersion: 2, payload: '{"n":7}' },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("renumbers board receipts into the board's sequence space, and only those", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* schemaBefore044;
    yield* seedV1Log;
    yield* Migration044;

    const receipts = yield* sql<{
      readonly commandId: string;
      readonly resultSequence: number;
      readonly status: string;
    }>`
      SELECT command_id AS "commandId", result_sequence AS "resultSequence", status
      FROM boards.board_command_receipts ORDER BY command_id
    `;
    assert.deepStrictEqual(receipts, [
      // Main sequence 4 is the second board event.
      { commandId: "cmd-4", resultSequence: 2, status: "accepted" },
      // Refused at main head 6: the board head then was its third event.
      { commandId: "cmd-refused", resultSequence: 3, status: "rejected" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("splits the old watermark into the board log's and the upstream tail's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* schemaBefore044;
    yield* seedV1Log;
    yield* Migration044;

    const watermarks = yield* sql<{ readonly projector: string; readonly sequence: number }>`
      SELECT projector, last_applied_sequence AS "sequence"
      FROM boards.projection_state ORDER BY projector
    `;
    assert.deepStrictEqual(watermarks, [
      // Main sequence 5 is the third board event.
      { projector: "projection.board-events", sequence: 3 },
      // The tail of upstream's log resumes exactly where the old projector was.
      { projector: "projection.board-thread-tail", sequence: 5 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("leaves upstream's log and receipts exactly as they were", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* schemaBefore044;
    yield* seedV1Log;
    const before = yield* sql`SELECT * FROM main.orchestration_events ORDER BY sequence`;
    const receiptsBefore = yield* sql`SELECT * FROM main.orchestration_command_receipts`;
    yield* Migration044;
    assert.deepStrictEqual(yield* sql`SELECT * FROM main.orchestration_events ORDER BY sequence`, before);
    assert.deepStrictEqual(yield* sql`SELECT * FROM main.orchestration_command_receipts`, receiptsBefore);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("is a no-op when run again", () =>
  Effect.gen(function* () {
    yield* schemaBefore044;
    yield* seedV1Log;
    yield* Migration044;
    const first = yield* snapshot;
    yield* Migration044;
    assert.deepStrictEqual(yield* snapshot, first);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("creates an empty log and no watermarks on a database with no board history", () =>
  Effect.gen(function* () {
    yield* schemaBefore044;
    yield* Migration044;
    const after = yield* snapshot;
    assert.deepStrictEqual(after.log, []);
    assert.deepStrictEqual(after.receipts, []);
    assert.deepStrictEqual(after.watermarks, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
