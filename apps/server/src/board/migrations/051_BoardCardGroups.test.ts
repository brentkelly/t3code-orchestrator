/**
 * Board migration 051: group settings on `board_cards`, every split
 * parent backfilled as an own-branch, auto-building group, and each split
 * child given its own copy of the plan it was cut from.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 51;
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

const insertCard = (input: {
  readonly id: string;
  readonly stage: string;
  readonly parent?: string;
  readonly sourcePlanId?: string;
  readonly archivedAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_cards
        (card_id, project_id, title, stage, parent_card_id, source_plan_id, archived_at,
         created_at, updated_at)
      VALUES (
        ${input.id}, 'proj', ${input.id}, ${input.stage}, ${input.parent ?? null},
        ${input.sourcePlanId ?? null}, ${input.archivedAt ?? null}, ${NOW}, ${NOW}
      )
    `;
  });

const insertPlan = (cardId: string, key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_plans
        (plan_id, card_id, title, summary, depends_on, ordinal, locked, body, created_at, updated_at)
      VALUES (
        ${`${cardId}::${key}`}, ${cardId}, ${`Plan ${key}`}, 'Summary', '[]', 0, 0,
        ${`# Body of ${key}`}, ${NOW}, ${NOW}
      )
    `;
  });

it.effect("backfills split parents as groups and copies each child's plan", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runBoardLineageThrough(MIGRATION_ID - 1);

    yield* insertCard({ id: "parent-planning", stage: "planning" });
    yield* insertPlan("parent-planning", "p1");
    yield* insertCard({
      id: "child-a",
      stage: "ready",
      parent: "parent-planning",
      sourcePlanId: "parent-planning::p1",
    });
    yield* insertCard({ id: "parent-building", stage: "building" });
    yield* insertCard({ id: "child-b", stage: "building", parent: "parent-building" });
    yield* insertCard({ id: "parent-done", stage: "done" });
    yield* insertCard({ id: "child-c", stage: "done", parent: "parent-done" });
    // Every child archived: the split is finished and gone, so a plain card.
    yield* insertCard({ id: "parent-wrapped", stage: "done" });
    yield* insertCard({ id: "child-d", stage: "done", parent: "parent-wrapped", archivedAt: NOW });
    yield* insertCard({ id: "plain", stage: "backlog" });

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 051 is registered in the lineage");
    yield* migration[2];

    const rows = yield* sql<{
      readonly cardId: string;
      readonly target: string | null;
      readonly autoBuild: number;
      readonly started: number;
      readonly placed: string | null;
      readonly integrated: number;
    }>`
      SELECT card_id AS "cardId", group_target AS "target", group_auto_build AS "autoBuild",
        group_started AS "started", group_placed AS "placed", group_integrated AS "integrated"
      FROM board_cards
      WHERE card_id NOT LIKE 'child-%'
      ORDER BY card_id
    `;
    assert.deepStrictEqual(rows, [
      {
        cardId: "parent-building",
        target: "own",
        autoBuild: 1,
        started: 1,
        placed: "ready",
        integrated: 0,
      },
      {
        cardId: "parent-done",
        target: "own",
        autoBuild: 1,
        started: 1,
        placed: "ready",
        integrated: 1,
      },
      {
        cardId: "parent-planning",
        target: "own",
        autoBuild: 1,
        started: 0,
        placed: "planning",
        integrated: 0,
      },
      {
        cardId: "parent-wrapped",
        target: null,
        autoBuild: 0,
        started: 0,
        placed: null,
        integrated: 0,
      },
      { cardId: "plain", target: null, autoBuild: 0, started: 0, placed: null, integrated: 0 },
    ]);

    const plans = yield* sql<{
      readonly planId: string;
      readonly cardId: string;
      readonly body: string;
    }>`
      SELECT plan_id AS "planId", card_id AS "cardId", body FROM board_plans
      WHERE card_id = 'child-a'
    `;
    assert.deepStrictEqual(plans, [
      { planId: "child-a::p1", cardId: "child-a", body: "# Body of p1" },
    ]);

    // Re-running is a no-op rather than an error.
    yield* migration[2];
    const count = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM board_plans`;
    assert.strictEqual(count[0]!.n, 2);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
