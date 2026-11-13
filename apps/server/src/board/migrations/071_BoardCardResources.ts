// T3O-86: a card's size, grant and setup ride one JSON column on `board_cards`, and a plan's
// suggested size one on `board_plans`. NULL matches each schema's decoding default. Guarded.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cards = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  if (!cards.some((column) => column.name === "resources")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN resources TEXT`;
  }
  const plans = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_plans)`;
  if (!plans.some((column) => column.name === "sizing")) {
    yield* sql`ALTER TABLE board_plans ADD COLUMN sizing TEXT`;
  }
});
