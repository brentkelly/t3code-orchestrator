// T3o: one global stage list with per-project switches (T3O-49).
//
// - `board_stages.default_for_projects`: whether a project with no switch of
//   its own uses the stage. NULL on every existing row, read through
//   `boardStageDefaultForProjects` (on for a global stage, off for CI and for
//   a stage a T3O-43 `t3o.json` added), so no row needs rewriting.
// - Stage rows that share an order key (two projects' files added a stage
//   after the same anchor) are re-keyed, so the one list has one order.
// - A role-less stage between CI and the merge stage could change code after
//   CI passed: it moves to just before CI.
// - `board_ci_passes.snapshot`: the CI steps a pass froze at its start.
// - `board_cards.ci_round_trips`: CI failure round trips without a human.
import { boardOrderKeyBetween } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

interface StageRow {
  readonly stageId: string;
  readonly role: string | null;
  readonly orderKey: string;
}

const order = (a: StageRow, b: StageRow) =>
  a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.stageId < b.stageId ? -1 : 1;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const stageColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_stages)`;
  if (!stageColumns.some((column) => column.name === "default_for_projects")) {
    yield* sql`ALTER TABLE board_stages ADD COLUMN default_for_projects INTEGER`;
  }
  const cardColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_cards)`;
  if (!cardColumns.some((column) => column.name === "ci_round_trips")) {
    yield* sql`ALTER TABLE board_cards ADD COLUMN ci_round_trips INTEGER NOT NULL DEFAULT 0`;
  }
  const passColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(board_ci_passes)`;
  if (!passColumns.some((column) => column.name === "snapshot")) {
    yield* sql`ALTER TABLE board_ci_passes ADD COLUMN snapshot TEXT`;
  }
  if (!passColumns.some((column) => column.name === "config_version")) {
    yield* sql`ALTER TABLE board_ci_passes ADD COLUMN config_version TEXT`;
  }

  const rows = [
    ...(yield* sql<StageRow>`
      SELECT stage_id AS "stageId", role, order_key AS "orderKey" FROM board_stages
    `),
  ].sort(order);
  const rekey = (stageId: string, orderKey: string) =>
    sql`UPDATE board_stages SET order_key = ${orderKey} WHERE stage_id = ${stageId}`;

  // Duplicate keys: every row after the first takes a key just above the one
  // before it (already re-keyed in a run of three or more), below the next
  // distinct key.
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]!;
    const row = rows[index]!;
    if (row.orderKey > previous.orderKey) continue;
    const upper = rows.slice(index + 1).find((next) => next.orderKey > previous.orderKey);
    const key = boardOrderKeyBetween(previous.orderKey, upper?.orderKey ?? null);
    if (key === null) continue;
    yield* rekey(row.stageId, key);
    rows[index] = { ...row, orderKey: key };
  }

  const ciIndex = rows.findIndex((row) => row.stageId === "ci");
  const mergeIndex = rows.findIndex(
    (row) => row.role === "merge" || (row.stageId === "merge" && row.role === null),
  );
  if (ciIndex < 0 || mergeIndex <= ciIndex) return;
  const offenders = rows.slice(ciIndex + 1, mergeIndex).filter((row) => row.role === null);
  let low = rows[ciIndex - 1]?.orderKey ?? "";
  const ciKey = rows[ciIndex]!.orderKey;
  for (const offender of offenders) {
    const key = boardOrderKeyBetween(low, ciKey);
    if (key === null) break;
    yield* rekey(offender.stageId, key);
    low = key;
  }
});
