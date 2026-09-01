// T3o: card body storage (brief, plan text, …), following the
// checkpoint_diff_blobs precedent for large payloads — bodies never enter
// the read model (D8), they are written by the board projector and read on
// demand.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_bodies (
      card_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (card_id, kind)
    )
  `;
});
