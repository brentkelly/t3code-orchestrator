import { BoardCardId, CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

/** A minimal valid `project.created` event, for filling replay around the rows
    under test. */
const projectCreated = (key: string, now: string) => ({
  type: "project.created" as const,
  eventId: EventId.make(`evt-${key}`),
  aggregateKind: "project" as const,
  aggregateId: ProjectId.make(`project-${key}`),
  occurredAt: now,
  commandId: CommandId.make(`cmd-${key}`),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    projectId: ProjectId.make(`project-${key}`),
    title: `Project ${key}`,
    workspaceRoot: `/tmp/project-${key}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

/** Write a row the event store's own `append` would refuse — the only way to
    stage a type this build no longer knows. */
const insertRawEvent = (
  sql: SqlClient.SqlClient,
  row: {
    readonly eventId: string;
    readonly aggregateKind: string;
    readonly streamId: string;
    readonly eventType: string;
    readonly occurredAt: string;
    readonly metadataJson?: string;
  },
) => sql`
  INSERT INTO orchestration_events (
    event_id, aggregate_kind, stream_id, stream_version, event_type,
    occurred_at, command_id, causation_event_id, correlation_id,
    actor_kind, payload_json, metadata_json
  )
  VALUES (
    ${row.eventId}, ${row.aggregateKind}, ${row.streamId}, ${0}, ${row.eventType},
    ${row.occurredAt}, ${null}, ${null}, ${null},
    ${"server"}, ${"{}"}, ${row.metadataJson ?? "{}"}
  )
`;

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* sql`
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
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );
  // T3o: the log is append-only and permanent, so an event type t3o has since
  // RETIRED still has rows on disk. Replay must survive them — a decode failure
  // here fails the whole page, which takes down boot for every event after it.
  it.effect("skips a retired board event type and keeps replaying past it", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`DELETE FROM orchestration_events`;

      const before = yield* eventStore.append(projectCreated("retired-before", now));
      yield* insertRawEvent(sql, {
        eventId: "evt-retired-board-type",
        aggregateKind: "card",
        streamId: BoardCardId.make("card-retired"),
        eventType: "board.card-progress-reported",
        occurredAt: now,
      });
      const after = yield* eventStore.append(projectCreated("retired-after", now));

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );

      // The retired row is dropped; both real events survive, in order.
      assert.deepEqual(
        replayed.map((event) => event.sequence),
        [before.sequence, after.sequence],
      );
    }),
  );

  // The narrowness of the skip is the point: losing an upstream event silently
  // would advance the projection watermark past thread history that cannot be
  // recovered. Only the board lineage — t3o-owned, and a rebuildable projection
  // — is allowed to go quiet.
  it.effect("still fails on an unknown non-board event type", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;

      yield* insertRawEvent(sql, {
        eventId: "evt-unknown-thread-type",
        aggregateKind: "thread",
        streamId: "thread-from-a-newer-build",
        eventType: "thread.some-future-type",
        occurredAt: "2026-01-01T00:00:00.000Z",
      });

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
      }
    }),
  );

  // The same guarantee on the aggregateId axis. Every id brand is a non-empty
  // string, so the only value the (former) union rejected is an empty one — which
  // is exactly what a future dropped id type looks like to this schema. Under the
  // old closed union an empty stream_id failed the batch decode; the skip must now
  // reach it. Seeding it directly pins that the row schema no longer gates on the
  // union.
  it.effect("skips a retired board row whose aggregate id is outside the id union", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`DELETE FROM orchestration_events`;

      const before = yield* eventStore.append(projectCreated("id-before", now));
      yield* insertRawEvent(sql, {
        eventId: "evt-retired-bad-id",
        aggregateKind: "card",
        streamId: "",
        eventType: "board.card-progress-reported",
        occurredAt: now,
      });
      const after = yield* eventStore.append(projectCreated("id-after", now));

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.deepEqual(
        replayed.map((event) => event.sequence),
        [before.sequence, after.sequence],
      );
    }),
  );

  // The retired-board skip must run BEFORE the structural row decode, not just
  // before the event-union decode: a retired row is skipped even when its own
  // metadata no longer satisfies `OrchestrationEventMetadata` (here a numeric
  // `providerTurnId`, valid JSON but wrong type). Before the row schema loosened
  // `metadata`/`aggregateId`, this failed the whole page inside `findAll`.
  it.effect("skips a retired board row whose metadata no longer fits the schema", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`DELETE FROM orchestration_events`;

      const before = yield* eventStore.append(projectCreated("meta-before", now));
      yield* insertRawEvent(sql, {
        eventId: "evt-retired-bad-metadata",
        aggregateKind: "card",
        streamId: BoardCardId.make("card-retired-meta"),
        eventType: "board.card-progress-reported",
        occurredAt: now,
        // Valid JSON, invalid metadata: providerTurnId must be a string.
        metadataJson: '{"providerTurnId":123}',
      });
      const after = yield* eventStore.append(projectCreated("meta-after", now));

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.deepEqual(
        replayed.map((event) => event.sequence),
        [before.sequence, after.sequence],
      );
    }),
  );
});
