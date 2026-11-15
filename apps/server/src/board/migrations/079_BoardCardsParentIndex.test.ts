/** Board migration 079: the child lookup by `parent_card_id` uses an index, not a scan. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

it.effect("indexes board_cards.parent_card_id so the child lookup does not scan", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [, , migration] of BOARD_MIGRATIONS) yield* migration;
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN SELECT card_id FROM board_cards WHERE parent_card_id = 'card-1'
    `;
    assert.ok(
      plan.some((row) => row.detail.includes("idx_board_cards_parent")),
      JSON.stringify(plan),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
