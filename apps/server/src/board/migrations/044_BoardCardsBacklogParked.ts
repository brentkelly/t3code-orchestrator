// T3o: the per-card Backlog park on board_cards (t3o-35).
//
// One column, additive and guarded exactly like 039's `auto_start`,
// and defaulting to 0:
//
//   backlog_parked — whether a move into Backlog from another stage parked
//     this card so auto-promote will not bounce it (K3). 0 means "not parked"
//     — today's behaviour, every card that has never been dragged back, and
//     every card whose park has been cleared by Unpark or by gaining an unmet
//     dependency. It MUST match the decoding default on BoardCard.backlogParked
//     (contracts board.ts), so a from-empty replay of a log written before this
//     spec decodes each card to false and a pre-existing row rehydrates to
//     false: replay equals rehydration.
//
// NOT NULL with a default rather than nullable: unlike a scheduled instant there
// is no third state to represent. A card is parked or it is not, and a NULL
// would only invite a reader to invent a meaning for it.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("backlog_parked")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN backlog_parked INTEGER NOT NULL DEFAULT 0`;
  }
});
