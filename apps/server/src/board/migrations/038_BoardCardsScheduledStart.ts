// T3o: the per-card scheduled start on board_cards (T3O-19).
//
// One column, additive and guarded exactly like 036's `base_branch`, and
// defaulting to NULL:
//
//   scheduled_start_at — the ISO instant until which nothing moves this card
//     (D1). NULL means "move it as soon as the pipeline reaches it" — today's
//     behaviour, every card that has never been scheduled, and every card whose
//     schedule has already fired, since the supervisor CLEARS the field in the
//     pass that acts on it (D4). It MUST match the decoding default on
//     BoardCard.scheduledStartAt (contracts board.ts), so a from-empty replay of
//     a log written before this spec decodes each card to null and a
//     pre-existing row rehydrates to null: replay equals rehydration.
//
// One nullable instant rather than a per-stage map: the field is cleared the
// moment it lets a step through, so it never needs to say WHICH stage it was
// for, and a map would need its own editor, its own reverse states and a
// decision about what a stale entry on an already-passed stage means.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("scheduled_start_at")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN scheduled_start_at TEXT`;
  }
});
