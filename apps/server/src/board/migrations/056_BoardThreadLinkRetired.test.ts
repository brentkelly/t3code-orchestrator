/**
 * Board migration 056: retired thread links, backfilled for the
 * threads the board unlinked while they were still alive.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 56;
const NOW = "2026-01-01T00:00:00.000Z";

const runBoardLineageThrough = (lastId: number) =>
  Effect.gen(function* () {
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , migration] of BOARD_MIGRATIONS) {
      if (id > lastId) break;
      yield* migration;
    }
  });

const insertCard = (id: string, key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_cards (card_id, project_id, title, stage, key, created_at, updated_at)
      VALUES (${id}, 'proj', ${id}, 'merge', ${key}, ${NOW}, ${NOW})
    `;
  });

const insertThread = (input: {
  readonly id: string;
  readonly title: string;
  readonly projectId?: string;
  readonly deletedAt?: string;
  readonly settledAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, deleted_at, payload_json)
      VALUES (
        ${input.id}, ${input.projectId ?? "proj"}, ${input.title}, 'codex', 'full-access',
        'default', ${NOW}, '2026-01-03T00:00:00.000Z', ${input.deletedAt ?? null},
        ${JSON.stringify({ settledAt: input.settledAt ?? null })}
      )
    `;
  });

let sequence = 0;
const insertEvent = (input: {
  readonly type: "board.card-thread-linked" | "board.card-thread-unlinked";
  readonly cardId: string;
  readonly threadId: string;
  readonly actor: "server" | "client";
  readonly occurredAt: string;
  readonly role?: string;
  readonly workerId?: string;
  readonly tombstonedAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    sequence += 1;
    const link = {
      threadId: input.threadId,
      role: input.role ?? "merge",
      linkedAt: input.occurredAt,
      tombstonedAt: null,
      ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
    };
    const payload =
      input.type === "board.card-thread-linked"
        ? {
            cardId: input.cardId,
            threadId: input.threadId,
            role: link.role,
            card: { id: input.cardId, threadLinks: [link] },
          }
        : {
            cardId: input.cardId,
            threadId: input.threadId,
            tombstonedAt: input.tombstonedAt ?? null,
            card: { id: input.cardId, threadLinks: [] },
          };
    yield* sql`
      INSERT INTO board_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
         actor_kind, payload_json, metadata_json)
      VALUES (
        ${`event-${sequence}`}, 'board', ${input.cardId}, ${sequence}, ${input.type},
        ${input.occurredAt}, ${input.actor}, ${JSON.stringify(payload)}, '{}'
      )
    `;
  });

it.effect("retires board-unlinked live threads onto their card, from events then titles", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runBoardLineageThrough(MIGRATION_ID - 1);
    yield* insertCard("card-a", "T3O-38");
    yield* insertCard("card-b", "T3O-37");

    // (a) A conflict fix the server unlinked, on a worker.
    yield* insertThread({ id: "fix", title: "T3O-38 · Conflicts" });
    yield* insertEvent({
      type: "board.card-thread-linked",
      cardId: "card-a",
      threadId: "fix",
      actor: "server",
      occurredAt: "2026-01-01T01:00:00.000Z",
      workerId: "env-worker",
    });
    yield* insertEvent({
      type: "board.card-thread-unlinked",
      cardId: "card-a",
      threadId: "fix",
      actor: "server",
      occurredAt: "2026-01-01T02:00:00.000Z",
    });
    // A human removed this one: left alone, even though its title matches.
    yield* insertThread({ id: "human", title: "T3O-38 · Building" });
    yield* insertEvent({
      type: "board.card-thread-linked",
      cardId: "card-a",
      threadId: "human",
      actor: "server",
      occurredAt: "2026-01-01T01:00:00.000Z",
      role: "building",
    });
    yield* insertEvent({
      type: "board.card-thread-unlinked",
      cardId: "card-a",
      threadId: "human",
      actor: "client",
      occurredAt: "2026-01-01T03:00:00.000Z",
    });
    // Its card was deleted (no row): skipped.
    yield* insertThread({ id: "orphan", title: "T3O-99 · Conflicts" });
    yield* insertEvent({
      type: "board.card-thread-linked",
      cardId: "card-gone",
      threadId: "orphan",
      actor: "server",
      occurredAt: "2026-01-01T01:00:00.000Z",
    });
    yield* insertEvent({
      type: "board.card-thread-unlinked",
      cardId: "card-gone",
      threadId: "orphan",
      actor: "server",
      occurredAt: "2026-01-01T02:00:00.000Z",
    });
    // The thread was deleted: skipped.
    yield* insertThread({ id: "deleted", title: "x", deletedAt: NOW });
    yield* insertEvent({
      type: "board.card-thread-linked",
      cardId: "card-a",
      threadId: "deleted",
      actor: "server",
      occurredAt: "2026-01-01T01:00:00.000Z",
    });
    yield* insertEvent({
      type: "board.card-thread-unlinked",
      cardId: "card-a",
      threadId: "deleted",
      actor: "server",
      occurredAt: "2026-01-01T02:00:00.000Z",
    });
    // Already linked elsewhere: untouched.
    yield* insertThread({ id: "owned", title: "T3O-38 · Planning" });
    yield* sql`
      INSERT INTO board_card_thread_links (thread_id, card_id, role, linked_at, tombstoned_at)
      VALUES ('owned', 'card-b', 'linked', ${NOW}, NULL)
    `;

    // (b) Titles, when no event accounts for the thread.
    yield* insertThread({
      id: "review",
      title: "T3O-37 · Review · round 2",
      settledAt: "2026-01-02T00:00:00.000Z",
    });
    yield* insertThread({ id: "planning", title: "T3O-37 · Planning" });
    yield* insertThread({ id: "chat", title: "T3O-37 · a question about it" });
    yield* insertThread({ id: "elsewhere", title: "T3O-37 · Planning", projectId: "other" });

    yield* BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID)![2];

    const rows = yield* sql<{
      readonly threadId: string;
      readonly cardId: string;
      readonly role: string;
      readonly linkedAt: string;
      readonly workerId: string | null;
      readonly retiredAt: string | null;
    }>`
      SELECT thread_id AS "threadId", card_id AS "cardId", role, linked_at AS "linkedAt",
        worker_id AS "workerId", retired_at AS "retiredAt"
      FROM board_card_thread_links
      ORDER BY thread_id
    `;
    assert.deepEqual(rows, [
      {
        threadId: "fix",
        cardId: "card-a",
        role: "merge",
        linkedAt: "2026-01-01T01:00:00.000Z",
        workerId: "env-worker",
        retiredAt: "2026-01-01T02:00:00.000Z",
      },
      {
        threadId: "owned",
        cardId: "card-b",
        role: "linked",
        linkedAt: NOW,
        workerId: null,
        retiredAt: null,
      },
      {
        threadId: "planning",
        cardId: "card-b",
        role: "planning",
        linkedAt: NOW,
        workerId: null,
        retiredAt: "2026-01-03T00:00:00.000Z",
      },
      {
        threadId: "review",
        cardId: "card-b",
        role: "linked",
        linkedAt: NOW,
        workerId: null,
        retiredAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    // Re-running is a no-op rather than an error.
    yield* BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID)![2];
    const [count] = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM board_card_thread_links
    `;
    assert.equal(count?.n, 4);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
