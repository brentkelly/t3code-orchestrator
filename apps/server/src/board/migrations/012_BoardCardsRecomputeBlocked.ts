// Recomputes the derived `blocked` flag from `depends_on`, mirroring
// `deriveBoardCardBlocked`: an archived dependency no longer gates, and a
// dependency id with no row still counts as unmet. Idempotent.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Stages at Ready or beyond, where unmet dependencies block. Inlined
    rather than imported: a migration must keep behaving the way it did the day
    it ran, even if the stage list later changes. */
const READY_OR_BEYOND = ["ready", "building", "review", "merge", "done"] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE board_cards
    SET blocked = CASE
      WHEN stage NOT IN ${sql.in(READY_OR_BEYOND)} THEN 0
      WHEN EXISTS (
        SELECT 1 FROM json_each(board_cards.depends_on) AS dependency
        WHERE NOT EXISTS (
          SELECT 1 FROM board_cards AS target
          WHERE target.card_id = dependency.value
            AND (target.archived_at IS NOT NULL OR target.stage = 'done')
        )
      ) THEN 1
      ELSE 0
    END
  `;
});
