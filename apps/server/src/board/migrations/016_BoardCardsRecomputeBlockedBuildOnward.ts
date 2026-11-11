// Recomputes `blocked` under the build-onward rule, mirroring
// `isBoardStageAtOrAfterBuild` over this database's `board_stages` order. With no
// build-role stage nothing is at-or-after build, so every card unblocks. 012 is
// frozen, hence this follow-up. Idempotent.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE board_cards
    SET blocked = CASE
      WHEN (
        SELECT stage.order_key FROM board_stages AS stage
        WHERE stage.stage_id = board_cards.stage
      ) >= (
        SELECT build.order_key FROM board_stages AS build
        WHERE build.role = 'build'
        ORDER BY build.order_key ASC
        LIMIT 1
      )
      AND EXISTS (
        SELECT 1 FROM json_each(board_cards.depends_on) AS dependency
        WHERE NOT EXISTS (
          SELECT 1 FROM board_cards AS target
          WHERE target.card_id = dependency.value
            AND (
              target.archived_at IS NOT NULL
              OR target.stage IN (SELECT done.stage_id FROM board_stages AS done WHERE done.role = 'done')
            )
        )
      ) THEN 1
      ELSE 0
    END
  `;
});
