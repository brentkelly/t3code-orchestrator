// T3o: user-defined stages (t3o-15, D2). Stages become a board read-model
// aggregate — created, renamed, reordered and deleted through decider-gated
// commands — so their definitions need a table. `board_stages` is seeded with
// the eight compiled stages (ids, labels, roles, order keys and staggered
// genesis timestamps identical to `BOARD_SEED_STAGES`), so a migrated-but-
// unused board rehydrates to exactly the stage list a from-empty replay
// produces (`boardStagesAreSeedOnly` then reports the slice absent, AC18).
//
// This migration also completes the step-state row with the frozen execution
// config (D12) — prompt, provider instance, model, mode, human-in-the-loop and
// timeout — resolved once at stage entry so a mid-flight settings edit cannot
// corrupt a running card; and drops `board_cards.recipe_snapshot`, the
// card-level snapshot the frozen run row replaces (D1). Greenfield (D14): no
// backfill, the dev database may be recreated.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_stages (
      stage_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      role TEXT,
      order_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Seed the eight compiled stages, matching `BOARD_SEED_STAGES` field-for-field
  // so `boardStagesAreSeedOnly` recognises an untouched table.
  const seeds: ReadonlyArray<{
    readonly stageId: string;
    readonly label: string;
    readonly role: string | null;
    readonly orderKey: string;
    readonly at: string;
  }> = [
    {
      stageId: "backlog",
      label: "Backlog",
      role: null,
      orderKey: "b",
      at: "1970-01-01T00:00:00.000Z",
    },
    {
      stageId: "sprint",
      label: "Sprint",
      role: null,
      orderKey: "d",
      at: "1970-01-01T00:00:00.001Z",
    },
    {
      stageId: "planning",
      label: "Planning",
      role: null,
      orderKey: "f",
      at: "1970-01-01T00:00:00.002Z",
    },
    { stageId: "ready", label: "Ready", role: null, orderKey: "h", at: "1970-01-01T00:00:00.003Z" },
    {
      stageId: "building",
      label: "Building",
      role: "build",
      orderKey: "j",
      at: "1970-01-01T00:00:00.004Z",
    },
    {
      stageId: "review",
      label: "Code review",
      role: "review",
      orderKey: "l",
      at: "1970-01-01T00:00:00.005Z",
    },
    {
      stageId: "merge",
      label: "Ready for merge",
      role: null,
      orderKey: "n",
      at: "1970-01-01T00:00:00.006Z",
    },
    { stageId: "done", label: "Done", role: "done", orderKey: "p", at: "1970-01-01T00:00:00.007Z" },
  ];
  const seedRows = seeds.map((seed) => ({
    stage_id: seed.stageId,
    label: seed.label,
    role: seed.role,
    order_key: seed.orderKey,
    created_at: seed.at,
    updated_at: seed.at,
  }));
  yield* sql`
    INSERT INTO board_stages ${sql.insert(seedRows)}
    ON CONFLICT (stage_id) DO NOTHING
  `;

  // Frozen execution config on the step-state row (D12). NOT NULL columns added
  // with defaults, as SQLite requires; every real row is written with resolved
  // values, so the defaults never surface in the read model.
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN prompt TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN provider_instance_id TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN model TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN mode TEXT NOT NULL DEFAULT 'plan'`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN human_in_loop INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 0`;

  // The card-level recipe snapshot is replaced by the frozen run row (D1).
  yield* sql`ALTER TABLE board_cards DROP COLUMN recipe_snapshot`;

  // Per-card human-in-the-loop override on the Build stage (D6). Nullable —
  // NULL means untouched (the effective value is computed from the build
  // stage's settings and whether the card has a plan).
  yield* sql`ALTER TABLE board_cards ADD COLUMN human_in_loop INTEGER`;
});
