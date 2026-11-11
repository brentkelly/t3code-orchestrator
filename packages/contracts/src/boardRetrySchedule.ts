/**
 * Retry cadences for stopped steps and refused merges. Safety numbers, not settings.
 * Pure: `nowMs` and a `[0, 1)` random arrive as arguments.
 */

const MINUTE = 60_000;

/**
 * Gap before each recovery nudge, indexed by nudges already sent. Without it a provider
 * refusing in under a second burns the whole nudge budget in seconds; the board must not
 * depend on recognising a refusal to avoid spamming it.
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

/** Floored at zero: a jittered delay that went negative would fire in the past. */
export function applyBoardRetryJitter(delayMs: number, random: number): number {
  const offset = Math.round((random * 2 - 1) * BOARD_RETRY_JITTER_MS);
  return Math.max(0, Math.round(delayMs) + offset);
}

/**
 * Auto-merge retries: one attempt plus seven, then the card waits for a human.
 * Front-loaded because the common refusal is CI that finishes in minutes. Charged at the
 * refusal and delivered by the supervisor sweep, jittered so cards do not hit a forge in lockstep.
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
 * Null once the ladder is spent rather than clamping to the last rung: the ladder ends,
 * and the card shows that end ("Merge needs you").
 */
export function boardAutoMergeRetryDelayMs(attempt: number): number | null {
  const index = Math.floor(attempt) - 1;
  if (index < 0) return BOARD_AUTO_MERGE_RETRY_DELAYS_MS[0] as number;
  return (BOARD_AUTO_MERGE_RETRY_DELAYS_MS[index] as number | undefined) ?? null;
}
