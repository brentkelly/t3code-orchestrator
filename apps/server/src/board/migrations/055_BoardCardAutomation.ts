// NULL toggles inherit from the parent group. The backfill keeps each card's
// existing behaviour; a from-empty replay of older events does not reproduce it,
// as production hydrates from these tables. Guarded, so re-running is a no-op.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const COLUMNS = ["auto_plan_setting", "auto_build_setting", "auto_merge_setting"] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(board_cards)
  `;
  const missing = COLUMNS.filter((name) => !columns.some((column) => column.name === name));
  if (missing.length === 0) return;
  for (const name of missing) {
    yield* sql.unsafe(`ALTER TABLE board_cards ADD COLUMN ${name} INTEGER`);
  }

  yield* sql`UPDATE board_cards SET auto_build_setting = 1 WHERE auto_start <> 0`;
  yield* sql`UPDATE board_cards SET auto_merge_setting = 1 WHERE auto_merge <> 0`;
  yield* sql`
    UPDATE board_cards SET auto_plan_setting = 1, auto_build_setting = 1
    WHERE auto_plan IS NOT NULL
      AND json_extract(auto_plan, '$.endedAt') IS NULL
      AND json_extract(auto_plan, '$.mode') = 'build'
  `;
  yield* sql`
    UPDATE board_cards SET group_started = 1
    WHERE group_target IS NOT NULL
      AND group_started = 0
      AND EXISTS (
        SELECT 1 FROM board_cards AS child
        WHERE child.parent_card_id = board_cards.card_id
          AND child.archived_at IS NULL
          AND (SELECT order_key FROM board_stages WHERE stage_id = child.stage)
            >= (SELECT order_key FROM board_stages WHERE role = 'build' LIMIT 1)
      )
  `;

  const rows = yield* sql<{
    readonly cardId: string;
    readonly parentCardId: string | null;
    readonly groupTarget: string | null;
  }>`
    SELECT card_id AS "cardId", parent_card_id AS "parentCardId", group_target AS "groupTarget"
    FROM board_cards
  `;
  const byId = new Map(rows.map((row) => [row.cardId, row]));
  // Where a group's children land: its own branch, the nearest own (or legacy,
  // settings-less) ancestor's through inherit groups, or trunk.
  const childrenIntoIntegration = (group: (typeof rows)[number]) => {
    const seen = new Set<string>();
    let node: (typeof rows)[number] | undefined = group;
    while (node !== undefined && !seen.has(node.cardId)) {
      seen.add(node.cardId);
      if (node.groupTarget === null || node.groupTarget === "own") return true;
      node = node.parentCardId === null ? undefined : byId.get(node.parentCardId);
    }
    return false;
  };
  for (const row of rows) {
    if (row.groupTarget === null || !childrenIntoIntegration(row)) continue;
    yield* sql`
      UPDATE board_cards SET group_auto_merge = group_auto_build WHERE card_id = ${row.cardId}
    `;
  }
});
