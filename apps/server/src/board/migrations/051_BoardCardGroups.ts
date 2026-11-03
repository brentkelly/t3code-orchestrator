// T3o: general grouping (T3O-27, D12).
//
// `board_cards.group_*` — a group's settings, NULL `group_target` on every
// leaf, matching the decoding default of `BoardCard.group`.
//
// Backfill: every existing split parent with a live child becomes a group exactly as approval
// now makes one — its own integration branch, auto-build on — started if it
// has reached the build stage, placed at its current pre-build stage (the
// stage before build when it is already past), and integrated once it is
// Done. Each sub-board child gets its own copy of the plan it was cut from,
// so "planned" no longer needs a parent special case. Both steps are guarded,
// so re-running is a no-op.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const COLUMNS = [
  ["group_target", "TEXT"],
  ["group_auto_build", "INTEGER NOT NULL DEFAULT 0"],
  ["group_auto_merge", "INTEGER NOT NULL DEFAULT 0"],
  ["group_auto_plan", "INTEGER NOT NULL DEFAULT 0"],
  ["group_started", "INTEGER NOT NULL DEFAULT 0"],
  ["group_placed", "TEXT"],
  ["group_prev_stage", "TEXT"],
  ["group_heading", "INTEGER NOT NULL DEFAULT 0"],
  ["group_integrated", "INTEGER NOT NULL DEFAULT 0"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  for (const [name, type] of COLUMNS) {
    if (!columns.some((column) => column.name === name)) {
      yield* sql.unsafe(`ALTER TABLE board_cards ADD COLUMN ${name} ${type}`);
    }
  }

  yield* sql`
    UPDATE board_cards
    SET
      group_target = 'own',
      group_auto_build = 1,
      group_started = CASE
        WHEN (SELECT order_key FROM board_stages WHERE stage_id = board_cards.stage)
          >= (SELECT order_key FROM board_stages WHERE role = 'build' LIMIT 1)
        THEN 1 ELSE 0 END,
      group_placed = CASE
        WHEN (SELECT order_key FROM board_stages WHERE stage_id = board_cards.stage)
          < (SELECT order_key FROM board_stages WHERE role = 'build' LIMIT 1)
        THEN board_cards.stage
        ELSE COALESCE(
          (
            SELECT stage_id FROM board_stages
            WHERE order_key < (SELECT order_key FROM board_stages WHERE role = 'build' LIMIT 1)
            ORDER BY order_key DESC, stage_id DESC
            LIMIT 1
          ),
          board_cards.stage
        ) END,
      group_integrated = CASE
        WHEN board_cards.stage IN (SELECT stage_id FROM board_stages WHERE role = 'done')
        THEN 1 ELSE 0 END
    WHERE group_target IS NULL
      AND EXISTS (
        SELECT 1 FROM board_cards AS child
        WHERE child.parent_card_id = board_cards.card_id AND child.archived_at IS NULL
      )
  `;
  yield* sql`
    UPDATE board_cards SET group_prev_stage = group_placed
    WHERE group_target IS NOT NULL AND group_prev_stage IS NULL
  `;

  yield* sql`
    INSERT INTO board_plans (
      plan_id, card_id, title, summary, depends_on, ordinal, locked, body, created_at, updated_at
    )
    SELECT
      child.card_id || '::' || substr(source.plan_id, length(source.card_id) + 3),
      child.card_id,
      source.title,
      source.summary,
      '[]',
      0,
      0,
      source.body,
      child.created_at,
      child.created_at
    FROM board_cards AS child
    JOIN board_plans AS source ON source.plan_id = child.source_plan_id
    WHERE NOT EXISTS (SELECT 1 FROM board_plans AS own WHERE own.card_id = child.card_id)
  `;
});
