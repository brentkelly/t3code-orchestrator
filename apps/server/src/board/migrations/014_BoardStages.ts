// The stage seed MUST match `BOARD_SEED_STAGES` field for field, so an unused
// board rehydrates to what a from-empty replay produces. Execution config is
// frozen on the step-state row at stage entry so a settings edit can't change a
// running card.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
  if (Arr.isArrayNonEmpty(seedRows)) {
    yield* sql`
      INSERT INTO board_stages ${sql.insert(seedRows)}
      ON CONFLICT (stage_id) DO NOTHING
    `;
  }

  // Frozen execution config on the step-state row. NOT NULL columns added
  // with defaults, as SQLite requires; every real row is written with resolved
  // values, so the defaults never surface in the read model.
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN prompt TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN provider_instance_id TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN model TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN mode TEXT NOT NULL DEFAULT 'plan'`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN human_in_loop INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE board_card_step_state ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 0`;

  // The card-level recipe snapshot is replaced by the frozen run row.
  yield* sql`ALTER TABLE board_cards DROP COLUMN recipe_snapshot`;

  // Per-card human-in-the-loop override on the Build stage. Nullable —
  // NULL means untouched (the effective value is computed from the build
  // stage's settings and whether the card has a plan).
  yield* sql`ALTER TABLE board_cards ADD COLUMN human_in_loop INTEGER`;
});
