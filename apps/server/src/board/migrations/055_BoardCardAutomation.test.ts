/**
 * Board migration 055 (T3O-38): own Automation toggles on `board_cards`,
 * backfilled so every card keeps the behaviour it had.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 55;
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
  readonly autoStart?: number;
  readonly autoMerge?: number;
  readonly autoPlan?: string;
  readonly groupTarget?: string;
  readonly groupAutoBuild?: number;
  readonly archivedAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_cards
        (card_id, project_id, title, stage, parent_card_id, archived_at, auto_start, auto_merge,
         auto_plan, group_target, group_auto_build, created_at, updated_at)
      VALUES (
        ${input.id}, 'proj', ${input.id}, ${input.stage}, ${input.parent ?? null},
        ${input.archivedAt ?? null}, ${input.autoStart ?? 0}, ${input.autoMerge ?? 0},
        ${input.autoPlan ?? null}, ${input.groupTarget ?? null}, ${input.groupAutoBuild ?? 0},
        ${NOW}, ${NOW}
      )
    `;
  });

it.effect("backfills own toggles, group begun and integration-branch auto-merge", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runBoardLineageThrough(MIGRATION_ID - 1);

    yield* insertCard({ id: "armed", stage: "ready", autoStart: 1 });
    yield* insertCard({ id: "merging", stage: "review", autoMerge: 1 });
    yield* insertCard({
      id: "button",
      stage: "planning",
      autoPlan: JSON.stringify({ mode: "build", requestedAt: NOW, endedAt: null }),
    });
    yield* insertCard({
      id: "spent",
      stage: "building",
      autoPlan: JSON.stringify({ mode: "build", requestedAt: NOW, endedAt: NOW }),
    });
    yield* insertCard({
      id: "via-group",
      stage: "planning",
      parent: "trunk-group",
      autoPlan: JSON.stringify({ mode: "ready", requestedAt: NOW, endedAt: null }),
    });
    yield* insertCard({ id: "plain", stage: "backlog" });
    // An own-branch group with auto-build on, a child building: begun, and its
    // children keep auto-merging into the integration branch.
    yield* insertCard({
      id: "own-group",
      stage: "building",
      groupTarget: "own",
      groupAutoBuild: 1,
    });
    yield* insertCard({ id: "own-child", stage: "building", parent: "own-group" });
    // An inherit group nested under it lands on that branch too.
    yield* insertCard({
      id: "nested-group",
      stage: "ready",
      parent: "own-group",
      groupTarget: "inherit",
      groupAutoBuild: 1,
    });
    // A trunk group: auto-build does not become auto-merge; nothing started.
    yield* insertCard({
      id: "trunk-group",
      stage: "planning",
      groupTarget: "inherit",
      groupAutoBuild: 1,
    });
    // Only an archived child has built: not begun.
    yield* insertCard({ id: "quiet-group", stage: "ready", groupTarget: "own" });
    yield* insertCard({
      id: "gone-child",
      stage: "building",
      parent: "quiet-group",
      archivedAt: NOW,
    });

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 055 is registered in the lineage");
    yield* migration[2];

    const rows = yield* sql<{
      readonly cardId: string;
      readonly plan: number | null;
      readonly build: number | null;
      readonly merge: number | null;
      readonly started: number;
      readonly groupMerge: number;
    }>`
      SELECT card_id AS "cardId", auto_plan_setting AS "plan", auto_build_setting AS "build",
        auto_merge_setting AS "merge", group_started AS "started", group_auto_merge AS "groupMerge"
      FROM board_cards
      ORDER BY card_id
    `;
    const row = (cardId: string) => rows.find((candidate) => candidate.cardId === cardId);
    assert.deepInclude(row("armed"), { plan: null, build: 1, merge: null });
    assert.deepInclude(row("merging"), { plan: null, build: null, merge: 1 });
    assert.deepInclude(row("button"), { plan: 1, build: 1, merge: null });
    assert.deepInclude(row("spent"), { plan: null, build: null, merge: null });
    assert.deepInclude(row("via-group"), { plan: null, build: null, merge: null });
    assert.deepInclude(row("plain"), { plan: null, build: null, merge: null });
    assert.deepInclude(row("own-group"), { started: 1, groupMerge: 1 });
    assert.deepInclude(row("nested-group"), { started: 0, groupMerge: 1 });
    assert.deepInclude(row("trunk-group"), { started: 0, groupMerge: 0 });
    assert.deepInclude(row("quiet-group"), { started: 0, groupMerge: 0 });

    // Re-running is a no-op rather than an error.
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
