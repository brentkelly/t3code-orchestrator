/**
 * Board migration 076: Auto sign-off, backfilled from what Auto-plan and Auto-build
 * resolve to today, so cards that run hands-off keep doing so.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 76;
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
  readonly parent?: string;
  readonly plan?: number;
  readonly build?: number;
  readonly group?: { readonly plan: number; readonly build: number; readonly started: number };
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_cards
        (card_id, project_id, title, stage, parent_card_id, auto_plan_setting,
         auto_build_setting, group_target, group_auto_plan, group_auto_build, group_started,
         created_at, updated_at)
      VALUES (
        ${input.id}, 'proj', ${input.id}, 'planning', ${input.parent ?? null},
        ${input.plan ?? null}, ${input.build ?? null},
        ${input.group === undefined ? null : "inherit"}, ${input.group?.plan ?? 0},
        ${input.group?.build ?? 0}, ${input.group?.started ?? 0}, ${NOW}, ${NOW}
      )
    `;
  });

it.effect("backfills Auto sign-off where Auto-plan and Auto-build both resolve on", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runBoardLineageThrough(MIGRATION_ID - 1);

    yield* insertCard({ id: "started", group: { plan: 1, build: 1, started: 1 } });
    yield* insertCard({ id: "unstarted", group: { plan: 1, build: 1, started: 0 } });
    yield* insertCard({ id: "plan-only-group", group: { plan: 1, build: 0, started: 1 } });
    yield* insertCard({ id: "own-own", plan: 1, build: 1 });
    yield* insertCard({ id: "own-plan-started-build", parent: "started", plan: 1 });
    yield* insertCard({ id: "own-plan-unstarted-build", parent: "unstarted", plan: 1 });
    yield* insertCard({ id: "inherited-plan-own-build", parent: "plan-only-group", build: 1 });
    yield* insertCard({ id: "build-only", build: 1 });
    yield* insertCard({ id: "plan-only", plan: 1 });
    yield* insertCard({ id: "own-off", parent: "started", plan: 0 });
    yield* insertCard({ id: "inheriting", parent: "started" });

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 076 is registered in the lineage");
    yield* migration[2];

    const rows = yield* sql<{
      readonly cardId: string;
      readonly signOff: number | null;
      readonly groupSignOff: number;
    }>`
      SELECT card_id AS "cardId", auto_sign_off_setting AS "signOff",
        group_auto_sign_off AS "groupSignOff"
      FROM board_cards
    `;
    const row = (cardId: string) => rows.find((candidate) => candidate.cardId === cardId);
    assert.deepInclude(row("own-own"), { signOff: 1 });
    assert.deepInclude(row("own-plan-started-build"), { signOff: 1 });
    assert.deepInclude(row("own-plan-unstarted-build"), { signOff: null });
    assert.deepInclude(row("inherited-plan-own-build"), { signOff: 1 });
    assert.deepInclude(row("build-only"), { signOff: null });
    assert.deepInclude(row("plan-only"), { signOff: null });
    assert.deepInclude(row("own-off"), { signOff: null });
    // Inherits the started group's backfilled sign-off instead of taking its own.
    assert.deepInclude(row("inheriting"), { signOff: null });
    assert.deepInclude(row("started"), { signOff: null, groupSignOff: 1 });
    assert.deepInclude(row("unstarted"), { signOff: null, groupSignOff: 1 });
    assert.deepInclude(row("plan-only-group"), { signOff: null, groupSignOff: 0 });

    // Re-running is a no-op rather than an error.
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
