// T3o: where a card runs, and the limit holding a queued step (T3O-65, D20/D11).
//
// `board_cards`:
//   pinned_worker_id — the worker a human pinned the card to; NULL follows the
//     board's default worker.
//   placed_worker_id — where the card's threads last spawned; NULL for a card
//     that has never run.
//   worker_move      — a move to another worker in flight or failed, as JSON;
//     NULL otherwise.
//
// `board_card_step_state.queued_by` — which limit holds a queued step (board,
// worker, provider, or a worker still cloning the project); NULL when not
// queued, read as plain "Queued".
//
// Every column defaults to NULL, matching the decoding defaults on `BoardCard`
// and `BoardCardStepState`, so a from-empty replay of a log written before the
// distributed board equals a table rehydration. Altered unqualified like 047:
// the columns join whichever copy of the table exists.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const cardColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const hasCardColumn = (name: string) => cardColumns.some((column) => column.name === name);
  if (!hasCardColumn("pinned_worker_id")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN pinned_worker_id TEXT`;
  }
  if (!hasCardColumn("placed_worker_id")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN placed_worker_id TEXT`;
  }
  if (!hasCardColumn("worker_move")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN worker_move TEXT`;
  }

  const stepColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_card_step_state)
  `;
  if (!stepColumns.some((column) => column.name === "queued_by")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN queued_by TEXT`;
  }
});
