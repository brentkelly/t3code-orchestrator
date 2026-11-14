/**
 * Board migration 074: placement is cleared on cards without a worktree, and kept on cards
 * with one, with an integration branch, or reclaimed or failed (T3O-87).
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 74;
const NOW = "2026-01-01T00:00:00.000Z";

const worktree = (status: string) =>
  JSON.stringify({
    branch: "board/x",
    baseRefName: "main",
    path: status === "ready" ? "/wt/x" : null,
    status,
    attempts: 1,
    lastError: null,
    reclaimBlockedReason: null,
  });

it.effect("clears placement on cards without a worktree, and keeps the rest", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , migration] of BOARD_MIGRATIONS) {
      if (id >= MIGRATION_ID) break;
      yield* migration;
    }
    const insert = (cardId: string, tree: string | null) =>
      sql`
        INSERT INTO board_cards (
          card_id, project_id, title, stage, created_at, updated_at, placed_worker_id, worktree
        ) VALUES (${cardId}, 'proj', 'Card', 'planning', ${NOW}, ${NOW}, 'env-w1', ${tree})
      `;
    yield* insert("no-worktree", null);
    yield* insert("reclaimed", worktree("reclaimed"));
    yield* insert("failed", worktree("failed"));
    yield* insert("ready", worktree("ready"));
    yield* insert("provisioning", worktree("provisioning"));
    yield* insert("integration", worktree("branch-only"));

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 074 is registered in the lineage");
    yield* migration[2];
    const rows = yield* sql<{ readonly cardId: string; readonly placed: string | null }>`
      SELECT card_id AS "cardId", placed_worker_id AS "placed" FROM board_cards ORDER BY card_id
    `;
    assert.deepStrictEqual(rows, [
      { cardId: "failed", placed: "env-w1" },
      { cardId: "integration", placed: "env-w1" },
      { cardId: "no-worktree", placed: null },
      { cardId: "provisioning", placed: "env-w1" },
      { cardId: "ready", placed: "env-w1" },
      { cardId: "reclaimed", placed: "env-w1" },
    ]);
    // Re-running is a no-op rather than an error.
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
