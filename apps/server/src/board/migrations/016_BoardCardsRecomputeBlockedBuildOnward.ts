// T3o: recompute the stored `blocked` flag under the t3o-15 build-onward rule.
//
// Migration 012 recomputed `blocked` under the rule of its day — blocked from
// `ready` onward (a hardcoded stage list). t3o-15 moved the live rule to
// `deriveBoardCardBlocked` → `isBoardStageAtOrAfterBuild`: blocked only from
// the BUILD-ROLE stage onward, over the user-defined stage order. `blocked` is
// rehydrated straight from this table, so on a legacy database a `ready` card
// with an unfinished live dependency would boot wearing a blocked badge the
// decider contradicts at its next event. 012 is frozen history; this follow-up
// re-aligns the stored column with the shipped rule.
//
// The stage order and the build role come from `board_stages` (014), which is
// seeded before any user edit, so `order_key` comparison mirrors
// `isBoardStageAtOrAfterBuild` over whatever stages this database holds. With
// no build-role stage (never in practice — the role is undeletable) nothing is
// at-or-after build, so every card unblocks, matching the live derivation.
// The unmet test is 012's, unchanged: a dependency gates unless its row is
// archived or sits in the done-role stage; a missing row still gates.
//
// Idempotent by construction — running it twice writes the same values.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
