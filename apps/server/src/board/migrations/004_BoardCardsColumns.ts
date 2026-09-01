// T3o: grow board_cards from its walking-skeleton (t3o-02) shape to the full
// t3o-03 card aggregate. 900_BoardCards has been applied to real databases,
// so it must never be edited — a machine that already ran it would silently
// skip the change; the full shape arrives here as guarded ALTERs instead.
//
// The column defaults are what pre-t3o-03 rows rehydrate with and MUST match
// the decoding defaults on BoardCardCreatedPayload (the LEGACY_BOARD_CARD_*
// constants in contracts board.ts), or a from-empty replay of an old event
// log would diverge from table rehydration.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("key")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN key TEXT NOT NULL DEFAULT 'CARD-0'`;
  }
  if (!has("card_number")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN card_number INTEGER NOT NULL DEFAULT 0`;
  }
  if (!has("card_type")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN card_type TEXT NOT NULL DEFAULT 'feature'`;
  }
  if (!has("stage")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN stage TEXT NOT NULL DEFAULT 'backlog'`;
  }
  if (!has("order_key")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN order_key TEXT NOT NULL DEFAULT 'm'`;
  }
  if (!has("brief_ref")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN brief_ref TEXT`;
  }
  if (!has("depends_on")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'`;
  }
  if (!has("parent_card_id")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN parent_card_id TEXT`;
  }
  if (!has("external_ref")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN external_ref TEXT`;
  }
  if (!has("recipe_snapshot")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN recipe_snapshot TEXT`;
  }
  if (!has("blocked")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`;
  }
  if (!has("archived_at")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN archived_at TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_cards_project_stage_order
    ON board_cards(project_id, stage, order_key)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_cards_key
    ON board_cards(key)
  `;
});
