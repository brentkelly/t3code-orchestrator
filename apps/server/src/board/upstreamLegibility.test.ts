/**
 * Calibrating the legibility instrument (t3o-26 P0).
 *
 * The end-to-end assertion this feeds — a board-exercised database that stock
 * t3code can still replay — cannot pass until the board's rows live in
 * `boards.sqlite` (P2). What CAN be established now, and must be, is that the
 * instrument would notice if they did not: a check that reports "clean" because
 * it is looking in the wrong place is worse than no check at all.
 *
 * So these tests seed exactly the contamination the separation is meant to
 * remove, and assert it is caught.
 */
import { BOARD_EVENT_TYPES, EventId, OrchestrationEventType } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  describeUpstreamLegibility,
  isUpstreamLegible,
  readUpstreamLegibility,
  UPSTREAM_AGGREGATE_KINDS,
  UPSTREAM_EVENT_TYPES,
} from "./upstreamLegibility.ts";

const layer = it.layer(SqlitePersistenceMemory);

const insertEvent = (
  sql: SqlClient.SqlClient,
  row: {
    readonly eventId: string;
    readonly aggregateKind: string;
    readonly streamId: string;
    readonly eventType: string;
  },
) => sql`
  INSERT INTO orchestration_events (
    event_id, aggregate_kind, stream_id, stream_version, event_type,
    occurred_at, command_id, causation_event_id, correlation_id,
    actor_kind, payload_json, metadata_json
  )
  VALUES (
    ${row.eventId}, ${row.aggregateKind}, ${row.streamId}, ${0}, ${row.eventType},
    ${"2026-01-01T00:00:00.000Z"}, ${null}, ${null}, ${null},
    ${"server"}, ${"{}"}, ${"{}"}
  )
`;

layer("upstream legibility", (it) => {
  // The upstream set is derived by subtraction, so this pins the derivation
  // rather than a hand-copied list: board types out, thread types in.
  it.effect("derives the upstream event-type set by excluding the board's", () =>
    Effect.sync(() => {
      for (const boardType of BOARD_EVENT_TYPES) {
        assert.ok(
          !UPSTREAM_EVENT_TYPES.has(boardType),
          `${boardType} must not count as upstream-legible`,
        );
      }
      assert.ok(UPSTREAM_EVENT_TYPES.has("thread.created"));
      assert.ok(UPSTREAM_EVENT_TYPES.has("project.created"));
      assert.equal(
        UPSTREAM_EVENT_TYPES.size,
        OrchestrationEventType.literals.length - BOARD_EVENT_TYPES.length,
      );
      assert.deepEqual([...UPSTREAM_AGGREGATE_KINDS].sort(), ["project", "thread"]);
    }),
  );

  // The verdict is a pure fold over the report, so it is pinned without a
  // database — the fully clean case cannot exist in a live one until P2 has
  // moved the board tables out.
  it.effect("summarises a clean report as legible and a dirty one specifically", () =>
    Effect.sync(() => {
      const clean = {
        illegibleEventRows: 0,
        illegibleEventTypes: [],
        illegibleAggregateKinds: [],
        illegibleReceiptRows: 0,
        t3oTables: [],
      };
      assert.ok(isUpstreamLegible(clean));
      assert.equal(describeUpstreamLegibility(clean), "legible to stock t3code");

      const dirty = {
        illegibleEventRows: 3,
        illegibleEventTypes: ["board.card-created"],
        illegibleAggregateKinds: ["card"],
        illegibleReceiptRows: 1,
        t3oTables: ["board_cards"],
      };
      assert.ok(!isUpstreamLegible(dirty));
      const described = describeUpstreamLegibility(dirty);
      assert.ok(described.includes("3 undecodable event row(s)"));
      assert.ok(described.includes("board.card-created"));
      assert.ok(described.includes("board_cards"));
    }),
  );

  it.effect("reports no illegible event rows when the log carries only upstream types", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;
      yield* insertEvent(sql, {
        eventId: EventId.make("evt-legible-thread"),
        aggregateKind: "thread",
        streamId: "thread-legible",
        eventType: "thread.created",
      });

      const report = yield* readUpstreamLegibility();

      assert.equal(report.illegibleEventRows, 0);
      assert.deepEqual(report.illegibleEventTypes, []);
      assert.equal(report.illegibleReceiptRows, 0);
    }),
  );

  // The failure this whole plan exists to remove: a board event row in
  // upstream's log. Stock t3code decodes `event_type` through a closed union, so
  // this is a hard replay failure for it, not a degraded read.
  it.effect("catches a board event row sitting in upstream's log", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;
      yield* insertEvent(sql, {
        eventId: EventId.make("evt-board-card"),
        aggregateKind: "card",
        streamId: "card-contaminant",
        eventType: "board.card-created",
      });

      const report = yield* readUpstreamLegibility();

      assert.equal(report.illegibleEventRows, 1);
      assert.deepEqual(report.illegibleEventTypes, ["board.card-created"]);
      assert.deepEqual(report.illegibleAggregateKinds, ["card"]);
      assert.ok(!isUpstreamLegible(report));
      assert.ok(describeUpstreamLegibility(report).includes("board.card-created"));
    }),
  );

  // A RETIRED board type is undecodable to upstream for the same reason, and is
  // not in `BOARD_EVENT_TYPES` either — so it must be caught by the membership
  // test, not by a `board.` prefix match that happens to agree.
  it.effect("catches a retired board event type too", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;
      yield* insertEvent(sql, {
        eventId: EventId.make("evt-retired"),
        aggregateKind: "card",
        streamId: "card-retired",
        eventType: "board.card-progress-reported",
      });

      const report = yield* readUpstreamLegibility();

      assert.equal(report.illegibleEventRows, 1);
      assert.deepEqual(report.illegibleEventTypes, ["board.card-progress-reported"]);
    }),
  );

  // AC3, and the first half of the promise actually delivered: after P1 the board
  // lineage builds its tables in boards.sqlite, so a migrated database leaves
  // none of them in the file stock t3code reads.
  it.effect("finds no t3o tables in the upstream file once the schema is separated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const report = yield* readUpstreamLegibility();
      assert.deepEqual(report.t3oTables, []);

      // ...because they are in the attached board database, not because the
      // migrations failed to run.
      const inBoards = yield* sql<{ readonly name: string }>`
        SELECT name FROM boards.sqlite_master WHERE type = 'table' AND name = 'board_cards'`;
      assert.strictEqual(inBoards.length, 1);
    }),
  );
});
