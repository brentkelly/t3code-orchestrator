// T3o: measured resource actuals (T3O-87). One row per card step a worker measured: an agent
// step, a CI pass or a setup run, with the worker it ran on and the profile granted then, so
// a re-placed card never mixes one worker's peak with another's grant. The reading is JSON.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_actuals (
      card_id         TEXT NOT NULL,
      step_key        TEXT NOT NULL,
      kind            TEXT NOT NULL,
      step_id         TEXT,
      label           TEXT NOT NULL,
      worker_id       TEXT NOT NULL,
      granted_profile TEXT,
      started_at      TEXT NOT NULL,
      ended_at        TEXT,
      reading         TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      PRIMARY KEY (card_id, step_key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.board_card_actuals_ended
    ON board_card_actuals (ended_at)
  `;
});
