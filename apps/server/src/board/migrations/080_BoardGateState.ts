// T3o: automation gate state (T3O-115). A card's stay began at its latest move or creation; its step
// row shares the stay only when selected since, else a sentinel no card matches, so a card dragged
// back into Planning is never signed off from its old step.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Earlier than any stay a card can have, so it never equals a card's `stage_entered_at`. */
export const BOARD_STALE_STAY_SENTINEL = "1970-01-01T00:00:00.000Z";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cardColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  const stepColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(board_card_step_state)`;
  const cardHas = (name: string) => cardColumns.some((column) => column.name === name);
  if (!cardHas("gate_block")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN gate_block TEXT`;
  }
  if (!stepColumns.some((column) => column.name === "stage_entered_at")) {
    yield* sql`ALTER TABLE board_card_step_state ADD COLUMN stage_entered_at TEXT`;
  }
  if (cardHas("stage_entered_at")) return;
  yield* sql`ALTER TABLE board_cards ADD COLUMN stage_entered_at TEXT`;
  yield* sql`
    UPDATE board_cards SET stage_entered_at = COALESCE(
      (
        SELECT MAX(activity.created_at) FROM board_card_activity AS activity
        WHERE activity.card_id = board_cards.card_id
          AND activity.kind IN ('card-moved', 'card-created')
      ),
      board_cards.updated_at
    )
  `;
  yield* sql`
    UPDATE board_card_step_state SET stage_entered_at = (
      SELECT CASE
        WHEN card.stage = board_card_step_state.step_id
          AND COALESCE(board_card_step_state.started_at, board_card_step_state.updated_at)
            >= card.stage_entered_at
        THEN card.stage_entered_at
        ELSE ${BOARD_STALE_STAY_SENTINEL}
      END
      FROM board_cards AS card WHERE card.card_id = board_card_step_state.card_id
    )
  `;
});
