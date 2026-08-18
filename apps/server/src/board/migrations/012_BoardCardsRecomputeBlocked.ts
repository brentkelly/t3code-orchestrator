// T3o: recompute the stored `blocked` flag under the t3o-13 dependency rule.
//
// An archived dependency used to count as unmet forever, so cards that had one
// were flagged blocked with no way back. D1 makes an archived dependency stop
// gating; the flag those databases hold is now simply wrong. The gate itself is
// derived live at move time, so nothing is stuck once D1 ships — but the badge
// lies until the card's next move or dependency edit, which is exactly the
// moment a user is trying to understand why it looked stuck.
//
// Pure recomputation of a derived column from `depends_on`, the dependency's
// stage and its `archived_at`, mirroring `deriveBoardCardBlocked`: blocked only
// at Ready or beyond, and only for a dependency that is live and not done. A
// dependency id with no row left still counts as unmet, matching the contract.
//
// Idempotent by construction — running it twice writes the same values.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Stages at Ready or beyond, where unmet dependencies block (D18). Inlined
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
