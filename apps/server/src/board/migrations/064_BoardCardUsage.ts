// T3o: per-card token usage and cost (T3O-77). One row per card, step, thread, provider
// and model; an unknown model is stored as '' so it can sit in the key.
// `board_usage_ingested` makes every turn count once, whichever path saw it. A card that
// already had worker-hosted threads is marked partial: their history stays on the worker.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_usage (
      card_id             TEXT NOT NULL,
      step_id             TEXT NOT NULL,
      thread_id           TEXT NOT NULL,
      provider            TEXT NOT NULL,
      model               TEXT NOT NULL,
      uncached_input      INTEGER NOT NULL DEFAULT 0,
      cached_input        INTEGER NOT NULL DEFAULT 0,
      cache_creation      INTEGER NOT NULL DEFAULT 0,
      output              INTEGER NOT NULL DEFAULT 0,
      reasoning           INTEGER NOT NULL DEFAULT 0,
      cost_micro_usd      INTEGER NOT NULL DEFAULT 0,
      turns_reported      INTEGER NOT NULL DEFAULT 0,
      turns_override      INTEGER NOT NULL DEFAULT 0,
      turns_list_priced   INTEGER NOT NULL DEFAULT 0,
      turns_unpriced      INTEGER NOT NULL DEFAULT 0,
      turns_no_usage      INTEGER NOT NULL DEFAULT 0,
      updated_at          TEXT NOT NULL,
      PRIMARY KEY (card_id, step_id, thread_id, provider, model)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_usage_ingested (
      thread_id        TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, provider_turn_id)
    )
  `;

  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  if (!columns.some((column) => column.name === "usage_history_partial")) {
    yield* sql`
      ALTER TABLE board_cards ADD COLUMN usage_history_partial INTEGER NOT NULL DEFAULT 0
    `;
    yield* sql`
      UPDATE board_cards SET usage_history_partial = 1
      WHERE card_id IN (
        SELECT card_id FROM board_card_thread_links
        WHERE worker_id IS NOT NULL AND worker_id <> 'local'
      )
    `;
  }
});
