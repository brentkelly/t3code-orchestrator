// T3o: the per-card auto-start arm on board_cards (T3O-24).
//
// One column, additive and guarded exactly like 038's `scheduled_start_at`,
// and defaulting to 0:
//
//   auto_start — whether the card moves itself into the build-role stage the
//     moment its last dependency reaches Done (D1). 0 means "wait here until a
//     human presses Begin build" — today's behaviour, every card that has never
//     been armed, and every card whose arm has been SPENT, since the decider
//     clears the field inside the move that carries the card out of the
//     pre-build stage (D4). It MUST match the decoding default on
//     BoardCard.autoStart (contracts board.ts), so a from-empty replay of a log
//     written before this spec decodes each card to false and a pre-existing row
//     rehydrates to false: replay equals rehydration.
//
// NOT NULL with a default rather than nullable: unlike a scheduled instant there
// is no third state to represent. A card is armed or it is not, and a NULL
// would only invite a reader to invent a meaning for it.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("auto_start")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0`;
  }
});
