/**
 * T3o migration 016 (t3o-15 follow-up): recompute the stored `blocked` flag
 * under the build-onward rule. 012 recomputed under its day's ready-onward
 * rule; t3o-15 moved the live gate to the build role, and `blocked` is
 * rehydrated straight from `board_cards` — so a legacy database boots wearing
 * badges the decider contradicts at the card's next event until this runs.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { BOARD_MIGRATIONS } from "./index.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import Migration016 from "./016_BoardCardsRecomputeBlockedBuildOnward.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const dependsOnColumn = (ids: ReadonlyArray<string>) => `[${ids.map((id) => `"${id}"`).join(",")}]`;

/** Everything up to (but not including) 016, applied directly — the schema
    and stage seed the rows below were written under, including 012's
    ready-onward recompute. 016 itself then runs directly too: 014's ALTERs
    are not idempotent, so re-running the lineage through the Migrator on top
    of a directly-applied schema would double-apply them. */
const migrateToPrevious = Effect.gen(function* () {
  // T3o-26: board tables live in the attached board database now, so the
  // attach has to happen before any board migration, exactly as at boot.
  yield* attachBoardDatabase();
  yield* runMigrations();
  for (const [id, , migration] of BOARD_MIGRATIONS) {
    if (id >= 16) break;
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

describe("migration 016: recompute blocked build-onward", () => {
  it.effect("moves the gate from ready-onward to the build role onward", () =>
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

      // The lie 016 exists to fix: 012 flagged Ready cards, the live rule
      // (build-onward) does not — the stored badge contradicts the decider.
      yield* insertCard({
        id: "ready-stale",
        stage: "ready",
        dependsOn: ["dep-open"],
        blocked: 1,
      });
      // Genuinely blocked: unfinished live dependency at the build role.
      yield* insertCard({
        id: "building-open",
        stage: "building",
        dependsOn: ["dep-open"],
        blocked: 0,
      });
      // Archived and done dependencies stop gating, wherever the card sits.
      yield* insertCard({
        id: "building-archived",
        stage: "building",
        dependsOn: ["dep-archived"],
        blocked: 1,
      });
      yield* insertCard({
        id: "review-done",
        stage: "review",
        dependsOn: ["dep-done"],
        blocked: 1,
      });
      // A dependency id whose card is gone still counts as unmet at build+.
      yield* insertCard({ id: "dangling", stage: "review", dependsOn: ["nothing"], blocked: 0 });
      // Below the build role the gate does not apply at all.
      yield* insertCard({
        id: "sprint-open",
        stage: "sprint",
        dependsOn: ["dep-open"],
        blocked: 1,
      });

      yield* Migration016;

      assert.deepStrictEqual(yield* blockedById, {
        "dep-open": 0,
        "dep-done": 0,
        "dep-archived": 0,
        "ready-stale": 0,
        "building-open": 1,
        "building-archived": 0,
        "review-done": 0,
        dangling: 1,
        "sprint-open": 0,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
