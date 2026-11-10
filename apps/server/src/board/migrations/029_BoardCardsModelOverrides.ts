// The NULL default MUST match the decoding default on BoardCard.modelOverrides.
// Keyed by stage id, not role, so a UI choice of rows isn't baked into storage.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("model_overrides")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN model_overrides TEXT`;
  }
});
