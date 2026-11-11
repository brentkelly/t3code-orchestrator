// Backfills the seeded Planning stage's role. Guarded on the seed id AND a
// still-null role so a hand-edited row is never trampled.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`UPDATE board_stages SET role = 'plan' WHERE stage_id = 'planning' AND role IS NULL`;
});
