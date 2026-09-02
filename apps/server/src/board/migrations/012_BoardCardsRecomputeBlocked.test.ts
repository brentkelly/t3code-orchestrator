/**
 * T3o migration 012 (t3o-13, D6): recompute the stored `blocked` flag under
 * the new dependency rule. Databases written before t3o-13 flagged a card
 * blocked because of an archived dependency, which now no longer gates — the
 * flag those rows hold is simply wrong, and it is wrong at exactly the moment
 * a user is trying to work out why a card looked stuck.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { BOARD_MIGRATIONS, runBoardMigrations } from "./index.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";

const NOW = "2026-01-01T00:00:00.000Z";

/** The `depends_on` column holds a JSON array. Written literally here rather
    than through a codec: these rows stand in for what a pre-012 database
    already contains, so the fixture should not depend on today's schema. */
const dependsOnColumn = (ids: ReadonlyArray<string>) => `[${ids.map((id) => `"${id}"`).join(",")}]`;

/** Everything up to (but not including) 012 — the schema as the rows below
    were written under. */
const migrateToPrevious = Effect.gen(function* () {
  // T3o-26: board tables live in the attached board database now, so the
  // attach has to happen before any board migration, exactly as at boot.
  yield* attachBoardDatabase();
  yield* runMigrations();
  for (const [id, , migration] of BOARD_MIGRATIONS) {
    if (id >= 12) break;
    yield* migration;
  }
});

const insertCard = (input: {
  readonly id: string;
  readonly stage: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly blocked: number;
  readonly archivedAt?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_cards
        (card_id, project_id, title, stage, depends_on, blocked, archived_at, created_at, updated_at)
      VALUES (
        ${input.id}, 'proj', ${input.id}, ${input.stage}, ${dependsOnColumn(input.dependsOn)},
        ${input.blocked}, ${input.archivedAt ?? null}, ${NOW}, ${NOW}
      )
    `;
  });

const blockedById = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly card_id: string; readonly blocked: number }>`
    SELECT card_id, blocked FROM board_cards ORDER BY card_id
  `;
  return Object.fromEntries(rows.map((row) => [row.card_id, row.blocked]));
});

describe("migration 012: recompute blocked", () => {
  it.effect("clears a flag left by an archived dependency and keeps every honest one", () =>
    Effect.gen(function* () {
      yield* migrateToPrevious;

      yield* insertCard({ id: "dep-open", stage: "building", dependsOn: [], blocked: 0 });
      yield* insertCard({ id: "dep-done", stage: "done", dependsOn: [], blocked: 0 });
      yield* insertCard({
        id: "dep-archived",
        stage: "building",
        dependsOn: [],
        blocked: 0,
        archivedAt: NOW,
      });

      // The bug this migration cleans up after: blocked forever by work that
      // was archived rather than finished.
      yield* insertCard({
        id: "stale-blocked",
        stage: "ready",
        dependsOn: ["dep-archived"],
        blocked: 1,
      });
      // Unfinished live dependency at Ready: blocked under 012's ready-onward
      // rule, then UNBLOCKED by 016 (t3o-15 moved the gate to build-onward).
      yield* insertCard({
        id: "ready-open-dep",
        stage: "ready",
        dependsOn: ["dep-open"],
        blocked: 1,
      });
      // Genuinely blocked at head — unfinished, live dependency in Building.
      yield* insertCard({
        id: "really-blocked",
        stage: "building",
        dependsOn: ["dep-open"],
        blocked: 1,
      });
      // Blocked flag set below the gate, where it does not apply at all.
      yield* insertCard({ id: "too-early", stage: "sprint", dependsOn: ["dep-open"], blocked: 1 });
      // Dependency satisfied the ordinary way.
      yield* insertCard({ id: "unblocked", stage: "ready", dependsOn: ["dep-done"], blocked: 1 });
      // A dependency id whose card is gone still counts as unmet — but only
      // gates from the build role onward at head (016).
      yield* insertCard({ id: "dangling", stage: "building", dependsOn: ["nothing"], blocked: 0 });

      // Runs 012 and everything after it, so the assertions below are the
      // TERMINAL state of the lineage — 016's build-onward recompute included.
      yield* runBoardMigrations();

      assert.deepStrictEqual(yield* blockedById, {
        "dep-open": 0,
        "dep-done": 0,
        "dep-archived": 0,
        "stale-blocked": 0,
        "ready-open-dep": 0,
        "really-blocked": 1,
        "too-early": 0,
        unblocked: 0,
        dangling: 1,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
