// Auto sign-off takes plan approval over from Auto-build: on where Auto-plan and
// Auto-build both resolve on today, off where a card's own Auto-plan or Auto-build
// off would otherwise inherit its group's backfilled on. Re-running is a no-op.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

interface CardRow {
  readonly cardId: string;
  readonly parentCardId: string | null;
  readonly autoPlanSetting: number | null;
  readonly autoBuildSetting: number | null;
  readonly groupTarget: string | null;
  readonly groupAutoPlan: number;
  readonly groupAutoBuild: number;
  readonly groupStarted: number;
}

const own = (value: number | null) => (value === null ? null : value !== 0);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (has("auto_sign_off_setting") && has("group_auto_sign_off")) return;
  if (!has("auto_sign_off_setting")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN auto_sign_off_setting INTEGER`;
  }
  if (!has("group_auto_sign_off")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN group_auto_sign_off INTEGER NOT NULL DEFAULT 0`;
  }

  const rows = yield* sql<CardRow>`
    SELECT
      card_id AS "cardId",
      parent_card_id AS "parentCardId",
      auto_plan_setting AS "autoPlanSetting",
      auto_build_setting AS "autoBuildSetting",
      group_target AS "groupTarget",
      group_auto_plan AS "groupAutoPlan",
      group_auto_build AS "groupAutoBuild",
      group_started AS "groupStarted"
    FROM board_cards
  `;
  const byId = new Map(rows.map((row) => [row.cardId, row]));
  for (const row of rows) {
    // A card inheriting both picks up its group's backfilled sign-off instead.
    if (row.groupTarget !== null) continue;
    if (row.autoPlanSetting === null && row.autoBuildSetting === null) continue;
    const parent = row.parentCardId === null ? undefined : byId.get(row.parentCardId);
    const group = parent !== undefined && parent.groupTarget !== null ? parent : null;
    const autoPlan = own(row.autoPlanSetting) ?? (group !== null && group.groupAutoPlan !== 0);
    const autoBuild =
      own(row.autoBuildSetting) ??
      (group !== null && group.groupAutoBuild !== 0 && group.groupStarted !== 0);
    if (autoPlan && autoBuild) {
      yield* sql`UPDATE board_cards SET auto_sign_off_setting = 1 WHERE card_id = ${row.cardId}`;
      continue;
    }
    const ownOff = row.autoPlanSetting === 0 || row.autoBuildSetting === 0;
    const groupSignsOff = group !== null && group.groupAutoPlan !== 0 && group.groupAutoBuild !== 0;
    if (ownOff && groupSignsOff) {
      yield* sql`UPDATE board_cards SET auto_sign_off_setting = 0 WHERE card_id = ${row.cardId}`;
    }
  }
  yield* sql`
    UPDATE board_cards SET group_auto_sign_off = 1
    WHERE group_target IS NOT NULL AND group_auto_plan <> 0 AND group_auto_build <> 0
  `;
});
