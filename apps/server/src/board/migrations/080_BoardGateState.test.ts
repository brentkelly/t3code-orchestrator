/**
 * Board migration 080: the stay marker is backfilled so a pre-migration board fires nothing new,
 * and a card dragged back into Planning never reads its old step as this stay's (T3O-115).
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_STALE_STAY_SENTINEL } from "./080_BoardGateState.ts";
import { BOARD_MIGRATIONS } from "./index.ts";

const MIGRATION_ID = 80;
const CREATED = "2026-01-01T00:00:00.000Z";
const MOVED = "2026-01-02T00:00:00.000Z";
const AFTER = "2026-01-02T00:05:00.000Z";
const BEFORE = "2026-01-01T12:00:00.000Z";
const SKEWED = "2026-01-01T23:59:55.000Z";

const runBoardLineageThrough = (lastId: number) =>
  Effect.gen(function* () {
    yield* attachBoardDatabase();
    yield* runMigrations();
    for (const [id, , migration] of BOARD_MIGRATIONS) {
      if (id > lastId) break;
      yield* migration;
    }
  });

const insertCard = (id: string, stage: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_cards (card_id, project_id, title, stage, created_at, updated_at)
      VALUES (${id}, 'proj', ${id}, ${stage}, ${CREATED}, ${CREATED})
    `;
  });

const insertActivity = (cardId: string, kind: string, at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_card_activity
        (activity_id, card_id, kind, payload, actor_kind, created_at)
      VALUES (${`${cardId}-${kind}-${at}`}, ${cardId}, ${kind}, '{}', 'human', ${at})
    `;
  });

const insertStep = (cardId: string, stepId: string, startedAt: string, status = "succeeded") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO board_card_step_state
        (card_id, step_id, step_label, attempt, max_attempts, status, slot_held, started_at,
         updated_at)
      VALUES (${cardId}, ${stepId}, 'Planning', 1, 3, ${status}, 0, ${startedAt}, ${startedAt})
    `;
  });

it.effect("backfills each card's stay and keeps a step only when it ran during that stay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runBoardLineageThrough(MIGRATION_ID - 1);

    // Moved into Planning, then planned: the step is this stay's.
    yield* insertCard("planned", "planning");
    yield* insertActivity("planned", "card-created", CREATED);
    yield* insertActivity("planned", "card-moved", MOVED);
    yield* insertStep("planned", "planning", AFTER);
    // Planned, then dragged out and back into Planning: the step is a stale stay's.
    yield* insertCard("dragged", "planning");
    yield* insertActivity("dragged", "card-moved", MOVED);
    yield* insertStep("dragged", "planning", BEFORE);
    // A client clock seconds ahead stamps the move after the step's server-clock start.
    yield* insertCard("skewed", "planning");
    yield* insertActivity("skewed", "card-moved", MOVED);
    yield* insertStep("skewed", "planning", SKEWED);
    // A live step on the card's stage is this stay's, whatever the clocks say.
    yield* insertCard("running", "planning");
    yield* insertActivity("running", "card-moved", MOVED);
    yield* insertStep("running", "planning", BEFORE, "running");
    // No activity at all: the stay falls back to the card's last update.
    yield* insertCard("quiet", "ready");

    const migration = BOARD_MIGRATIONS.find(([id]) => id === MIGRATION_ID);
    assert.ok(migration, "migration 080 is registered in the lineage");
    yield* migration[2];

    const cards = yield* sql<{ readonly cardId: string; readonly entered: string | null }>`
      SELECT card_id AS "cardId", stage_entered_at AS "entered" FROM board_cards
    `;
    const steps = yield* sql<{ readonly cardId: string; readonly entered: string | null }>`
      SELECT card_id AS "cardId", stage_entered_at AS "entered" FROM board_card_step_state
    `;
    const enteredOf = (rows: typeof cards, cardId: string) =>
      rows.find((row) => row.cardId === cardId)?.entered;
    assert.strictEqual(enteredOf(cards, "planned"), MOVED);
    assert.strictEqual(enteredOf(steps, "planned"), MOVED);
    assert.strictEqual(enteredOf(cards, "dragged"), MOVED);
    assert.strictEqual(enteredOf(steps, "dragged"), BOARD_STALE_STAY_SENTINEL);
    assert.strictEqual(enteredOf(steps, "skewed"), MOVED);
    assert.strictEqual(enteredOf(steps, "running"), MOVED);
    assert.strictEqual(enteredOf(cards, "quiet"), CREATED);

    // Re-running is a no-op rather than an error.
    yield* migration[2];
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
