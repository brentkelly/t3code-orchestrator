// T3o: the Automation section (T3O-38).
//
// `board_cards.auto_{plan,build,merge}_setting` — each card's own toggle,
// NULL to inherit from its parent group, matching `BoardCard`'s decoding
// default. Backfilled so every card keeps today's behaviour:
//
//   - `auto_start = 1` → own Auto-build on; `auto_merge = 1` → own Auto-merge
//     on (0 stays NULL: the old flag could only add, never override off).
//   - A pending auto-plan request (053's JSON) from the Auto-plan → Build
//     button (`mode: build`) → own Auto-plan and Auto-build on. A pending
//     `ready` request came from the group setting, which still applies.
//   - A group with a live child at or past the build stage has begun
//     (`group_started = 1`): begun is now that flag alone.
//   - A group whose children land on an integration branch merged them under
//     its auto-build; they now read its auto-merge, so it takes that value.
//
// The old `auto_start` / `auto_merge` columns are left in place, unused. Like
// 051, a from-empty replay of pre-054 events does not reproduce the backfill;
// production hydrates from these tables. Guarded, so re-running is a no-op.
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
