/**
 * T3o usage-limit cadences (T3O-22, D7/D8/D15) — every number the board waits
 * on when a step stops, in one place, as pure functions of scalars.
 *
 * None of these is a setting (D15). They are safety numbers, not preferences:
 * the human override this feature genuinely needs is the top bar's
 * "Resume now" / "Set resume time", which is a click on the thing being
 * waited for rather than a field in a settings pane nobody will find.
 *
 * Pure and total throughout — no clock, no randomness. `nowMs` and a `[0, 1)`
 * random arrive as arguments, the same "the reactor resolves, the function
 * stays pure" split `recoveryDecision` established.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long past a parsed reset time the board waits before probing (D5).
 *
 * A provider that says "resets 2:50am" is describing its own clock, not ours,
 * and waking at 2:50:00 exactly is the one moment it is most likely to still
 * say no — which costs the probe and re-parks every card behind it for a whole
 * poll rung. A minute buys that away for nothing.
 */
export const BOARD_USAGE_LIMIT_RESUME_MARGIN_MS = MINUTE;

/**
 * The longest window this feature will ever wait out (D5/D8).
 *
 * ONE ceiling, used twice: a parsed time further out than this is not believed
 * (a misread year, a provider quoting a support SLA), and a blind poll that has
 * learned nothing in seven days gives up and hands its cards to a human. Seven
 * days because a weekly quota is the longest real window any supported provider
 * has; anything past it is a billing problem wearing a window's clothes, and
 * D16 is what handles those.
 */
export const BOARD_USAGE_LIMIT_MAX_HORIZON_MS = 7 * DAY;

/**
 * The line between "a window is exhausted" and "slow down" (D4, rule 3).
 *
 * A retry interval shorter than this is a per-second/per-minute throttle, not a
 * quota window: it clears on its own well inside the FIRST retry rung below, so
 * parking the card and gating the whole provider behind a prober would trade
 * seconds of waiting for half an hour of it.
 */
export const BOARD_USAGE_LIMIT_SHORT_RETRY_MS = 5 * MINUTE;

/**
 * The gap before each recovery nudge (D7), indexed by how many nudges this step
 * has already had: 2, 4, 8, 16, 32 minutes.
 *
 * Today there is no gap at all — the next nudge goes the instant the previous
 * reply lands — which is how two cards on the live board spent their entire
 * five-nudge budget in TWELVE SECONDS against a provider that was out of quota
 * and answering in 0.7s. This is the safety net that makes a MISSED detection
 * harmless rather than fatal: the catalogue will never catch every wording, and
 * providers rewrite theirs, so the board must not depend on recognising the
 * sentence to avoid spamming the provider.
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

/**
 * The blind-poll cadence (D8), by how long we have been polling blind: every 30
 * minutes for the first 5 hours, every 2 hours to 2 days, every 6 hours to 7
 * days — then `null`, meaning give up and hand the cards to a human.
 *
 * Coarsening rather than a flat 30 minutes because the two cases have opposite
 * costs. A limit that resets in an hour wants to be found promptly; one that has
 * not cleared in three days is a weekly window or a billing wall, and asking it
 * every half hour for four more days is 200 pointless requests to a provider
 * that is already refusing us.
 */
export const BOARD_USAGE_LIMIT_POLL_RUNGS = [
  { throughMs: 5 * HOUR, everyMs: 30 * MINUTE },
  { throughMs: 2 * DAY, everyMs: 2 * HOUR },
  { throughMs: BOARD_USAGE_LIMIT_MAX_HORIZON_MS, everyMs: 6 * HOUR },
] as const;

/**
 * The next blind probe delay, or `null` once the 7-day ceiling is past.
 *
 * `blindElapsedMs` is measured from when blind polling STARTED, not from the
 * last probe: the rung is a property of how long this limit has gone unexplained,
 * and measuring from the last probe would let a restart quietly reset the ladder
 * to its finest cadence forever.
 */
export function boardUsageLimitPollDelayMs(blindElapsedMs: number): number | null {
  const elapsed = Math.max(0, blindElapsedMs);
  for (const rung of BOARD_USAGE_LIMIT_POLL_RUNGS) {
    if (elapsed < rung.throughMs) return rung.everyMs;
  }
  return null;
}

/** The jitter envelope (D8): every wait is spread ±60s so a fleet of parked
    cards never hits one provider on a precise cadence. */
export const BOARD_USAGE_LIMIT_JITTER_MS = MINUTE;

/**
 * `delayMs` spread by ±`BOARD_USAGE_LIMIT_JITTER_MS`.
 *
 * `random` is a `[0, 1)` value the caller supplies, so this stays pure and a
 * test can pin the jitter to either edge instead of asserting a range. Floored
 * at zero: a jittered delay that went negative would fire in the past, which is
 * the one outcome the jitter must never produce.
 */
export function applyBoardUsageLimitJitter(delayMs: number, random: number): number {
  const offset = Math.round((random * 2 - 1) * BOARD_USAGE_LIMIT_JITTER_MS);
  return Math.max(0, Math.round(delayMs) + offset);
}

/**
 * The auto-merge retry ladder (T3O-38, D5): 3, 3, 5, 5, 10, 20, 40 minutes.
 *
 * One initial attempt plus seven retries — 8 attempts over ~86 minutes — then
 * the ladder stops and the card says so and waits for a human. Shaped exactly
 * like `BOARD_RETRY_DELAYS_MS`: charged at the refusal, delivered later by the
 * existing 30s supervisor sweep, and jittered through
 * `applyBoardUsageLimitJitter` so ten cards arriving together do not hammer
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
