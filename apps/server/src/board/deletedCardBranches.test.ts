/** Deleted cards' leftover branches are read back from the event log (T3O-123). */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { attachBoardDatabase } from "./boardDatabase.ts";
import { leftoverDeletedCardBranches, readDeletedCardBranches } from "./deletedCardBranches.ts";
import { BOARD_MIGRATIONS } from "./migrations/index.ts";

const insertEvent = (sequence: number, type: string, occurredAt: string, payload: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO boards.board_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json
      ) VALUES (
        ${`event-${sequence}`}, 'board', 'board', ${sequence}, ${type}, ${occurredAt},
        'system', ${JSON.stringify(payload)}, '{}'
      )
    `;
  });

const deleted = (id: string, worktree: { branch: string } | null, extra: object = {}) => ({
  cardId: id,
  deletedAt: "2026-11-01T00:00:00.000Z",
  card: { id, projectId: "project-1", worktree, ...extra },
  threadIds: [],
});

describe("readDeletedCardBranches", () => {
  it.effect("reads recent deleted cards' board branches, by type and time, with an index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* attachBoardDatabase();
      yield* runMigrations();
      for (const [, , migration] of BOARD_MIGRATIONS) yield* migration;

      yield* insertEvent(
        1,
        "board.card-deleted",
        "2026-07-01T00:00:00.000Z",
        deleted("old", { branch: "board/old" }),
      );
      yield* insertEvent(2, "board.card-deleted", "2026-11-01T00:00:00.000Z", {
        ...deleted(
          "remote",
          { branch: "board/remote" },
          { placedWorkerId: "env-worker", unknownField: 1 },
        ),
      });
      yield* insertEvent(
        3,
        "board.card-deleted",
        "2026-11-02T00:00:00.000Z",
        deleted("no-worktree", null),
      );
      yield* insertEvent(
        4,
        "board.card-deleted",
        "2026-11-03T00:00:00.000Z",
        deleted("user", { branch: "feature/x" }),
      );
      yield* insertEvent(
        5,
        "board.card-archived",
        "2026-11-04T00:00:00.000Z",
        deleted("archived", { branch: "board/archived" }),
      );
      yield* insertEvent(
        6,
        "board.card-deleted",
        "2026-11-05T00:00:00.000Z",
        deleted("local", { branch: "board/local" }),
      );
      yield* insertEvent(7, "board.card-deleted", "2026-11-06T00:00:00.000Z", { garbage: true });

      const branches = yield* readDeletedCardBranches(sql, "2026-08-20T00:00:00.000Z");
      assert.deepStrictEqual(branches, [
        {
          cardId: "remote",
          projectId: "project-1",
          workerId: "env-worker",
          branch: "board/remote",
        },
        { cardId: "local", projectId: "project-1", workerId: null, branch: "board/local" },
      ]);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN SELECT payload_json FROM boards.board_events
        WHERE event_type = 'board.card-deleted' AND occurred_at >= '2026-01-01'
      `;
      assert.ok(
        plan.some((row) => row.detail.includes("idx_board_events_type_occurred")),
        JSON.stringify(plan),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("leftoverDeletedCardBranches", () => {
  it.effect("skips a branch a live card reuses, and repeats", () =>
    Effect.sync(() => {
      const leftover = (cardId: string, branch: string) => ({
        cardId,
        projectId: "project-1",
        workerId: null,
        branch,
      });
      const result = leftoverDeletedCardBranches(
        [leftover("a", "board/t3o-1"), leftover("b", "board/t3o-2"), leftover("c", "board/t3o-2")],
        [{ worktree: { branch: "board/t3o-1" } }, { worktree: null }],
      );
      assert.deepStrictEqual(result, [leftover("b", "board/t3o-2")]);
    }),
  );
});
