// T3o: the decision log and auto-planning (T3O-32).
//
//   board_card_decisions — one row per planning decision: what was asked, what
//     was decided, why, who decided and a flag (normal | important | unclear).
//     Keyed by `decision_id`, which the decider derives from the event id, so a
//     re-projected event is an idempotent insert. A fresh table, schema-qualified
//     like every board CREATE (see 042).
//   board_cards.auto_plan — JSON `{ mode, requestedAt, endedAt }`, the card's
//     auto-plan request. NULL for every older row, matching `BoardCard.autoPlan`
//     decoding to null. Altered unqualified like 052.
//
// Both guarded, so re-running is a no-op.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS boards.board_card_decisions (
      decision_id TEXT PRIMARY KEY NOT NULL,
      card_id     TEXT NOT NULL,
      step_id     TEXT,
      thread_id   TEXT,
      question    TEXT NOT NULL,
      decision    TEXT NOT NULL,
      reason      TEXT NOT NULL,
      flag        TEXT NOT NULL,
      decided_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS boards.idx_board_card_decisions_card
    ON board_card_decisions (card_id, created_at, decision_id)
  `;
  const cardColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  if (!cardColumns.some((column) => column.name === "auto_plan")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN auto_plan TEXT`;
  }
});
