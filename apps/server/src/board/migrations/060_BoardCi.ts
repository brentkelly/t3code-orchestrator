// The CI seed stage is inserted only when missing and matches
// `BOARD_SEED_STAGES` field for field, so an untouched table stays seed-only.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO board_stages (stage_id, label, role, order_key, created_at, updated_at, project_id)
    SELECT 'ci', 'Continuous integration', NULL, 'm', '1970-01-01T00:00:00.008Z',
           '1970-01-01T00:00:00.008Z', NULL
    WHERE NOT EXISTS (SELECT 1 FROM board_stages WHERE stage_id = 'ci')
  `;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  if (!columns.some((column) => column.name === "ci")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN ci TEXT`;
  }
  if (!columns.some((column) => column.name === "ci_last_outcome")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN ci_last_outcome TEXT`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_ci_passes (
      run_id        TEXT PRIMARY KEY NOT NULL,
      card_id       TEXT NOT NULL,
      entry         INTEGER NOT NULL,
      ordinal       INTEGER NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      outcome       TEXT,
      steps         TEXT NOT NULL,
      log_dir       TEXT,
      fix_thread_id TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.board_ci_passes_card
    ON board_ci_passes (card_id, entry, ordinal)
  `;
});
