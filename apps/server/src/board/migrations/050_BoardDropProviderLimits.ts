// T3o: retire the board's own usage-limit cooldowns (T3O-72).
//
// Orchestration-v2 detects usage limits and resumes a limited thread itself;
// the board now only parks the step and arms that recovery. The provider-wide
// cooldown table (042) has no reader left, so it goes.
//
// `quota-exhausted` was a stalled reason only the retired classifier wrote. Any
// step still parked on it was waiting for a human, which is exactly `gave-up`,
// so it is rewritten to that rather than left to fail the row's schema. The
// step-state table is updated unqualified, like 048: it resolves to whichever
// copy of the table exists.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS boards.board_provider_limits`;
  yield* sql`
    UPDATE board_card_step_state
    SET stalled_reason = 'gave-up', retry_at = NULL
    WHERE stalled_reason = 'quota-exhausted'
  `;
});
