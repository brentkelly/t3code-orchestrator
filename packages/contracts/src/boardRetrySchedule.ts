/**
 * T3o retry cadences — every number the board waits on between attempts at a
 * stopped step or a refused merge, in one place, as pure functions of scalars.
 *
 * None of these is a setting. They are safety numbers, not preferences.
 *
 * Pure and total throughout — no clock, no randomness. `nowMs` and a `[0, 1)`
 * random arrive as arguments, the same "the reactor resolves, the function
 * stays pure" split `recoveryDecision` established.
 */

const MINUTE = 60_000;

/**
 * The gap before each recovery nudge (D7), indexed by how many nudges this step
 * has already had: 2, 4, 8, 16, 32 minutes.
 *
 * Today there is no gap at all — the next nudge goes the instant the previous
 * reply lands — which is how two cards on the live board spent their entire
 * five-nudge budget in TWELVE SECONDS against a provider that was out of quota
 * and answering in 0.7s. This is the safety net that makes a MISSED detection
 * harmless rather than fatal: the board must not depend on recognising a
 * provider's refusal to avoid spamming it.
 *
 * It barely bites in healthy use. A real agent takes minutes to answer a nudge
 * anyway, so the floor is invisible except in exactly the pathological case it
 * exists for.
 */
export const BOARD_RETRY_DELAYS_MS = [
  2 * MINUTE,
  4 * MINUTE,
  8 * MINUTE,
  16 * MINUTE,
  32 * MINUTE,
] as const;

/** How long to wait before the `nudgeIndex`-th nudge (0-based), clamped to the
    last rung so a ladder longer than the table never falls back to zero. */
export function boardRetryDelayMs(nudgeIndex: number): number {
  const index = Math.max(0, Math.min(BOARD_RETRY_DELAYS_MS.length - 1, Math.floor(nudgeIndex)));
  return BOARD_RETRY_DELAYS_MS[index] as number;
}

/** The jitter envelope: every wait is spread ±60s so a fleet of parked
    cards never hits one provider on a precise cadence. */
export const BOARD_RETRY_JITTER_MS = MINUTE;

/**
 * `delayMs` spread by ±`BOARD_RETRY_JITTER_MS`.
 *
 * `random` is a `[0, 1)` value the caller supplies, so this stays pure and a
 * test can pin the jitter to either edge instead of asserting a range. Floored
 * at zero: a jittered delay that went negative would fire in the past, which is
 * the one outcome the jitter must never produce.
 */
export function applyBoardRetryJitter(delayMs: number, random: number): number {
  const offset = Math.round((random * 2 - 1) * BOARD_RETRY_JITTER_MS);
  return Math.max(0, Math.round(delayMs) + offset);
}

/**
 * The auto-merge retry ladder (T3O-38, D5): 3, 3, 5, 5, 10, 20, 40 minutes.
 *
 * One initial attempt plus seven retries — 8 attempts over ~86 minutes — then
 * the ladder stops and the card says so and waits for a human. Shaped exactly
 * like `BOARD_RETRY_DELAYS_MS`: charged at the refusal, delivered later by the
 * existing 30s supervisor sweep, and jittered through
 * `applyBoardRetryJitter` so ten cards arriving together do not hammer
 * one forge in lockstep.
 *
 * Front-loaded because the common refusal is "required checks have not passed"
 * on a CI run that finishes in single-digit minutes, and stretched at the tail
 * because a merge still refused after half an hour is usually waiting on
 * something slower than a build.
 */
export const BOARD_AUTO_MERGE_RETRY_DELAYS_MS = [
  3 * MINUTE,
  3 * MINUTE,
  5 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  20 * MINUTE,
  40 * MINUTE,
] as const;

/** How many merge attempts an armed card gets before the ladder stops: the
    first attempt plus one per rung above. */
export const BOARD_AUTO_MERGE_MAX_ATTEMPTS = BOARD_AUTO_MERGE_RETRY_DELAYS_MS.length + 1;

/**
 * How long to wait after the `attempt`-th refusal (1-based), or `null` once
 * the ladder is spent.
 *
 * Returning null rather than clamping to the last rung is the whole point:
 * this ladder ENDS, and the end is a state the card shows ("Merge needs you")
 * rather than a wait that never resolves.
 */
export function boardAutoMergeRetryDelayMs(attempt: number): number | null {
  const index = Math.floor(attempt) - 1;
  if (index < 0) return BOARD_AUTO_MERGE_RETRY_DELAYS_MS[0] as number;
  return (BOARD_AUTO_MERGE_RETRY_DELAYS_MS[index] as number | undefined) ?? null;
}
