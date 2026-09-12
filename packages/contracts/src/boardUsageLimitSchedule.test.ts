import { describe, expect, it } from "@effect/vitest";

import {
  applyBoardUsageLimitJitter,
  BOARD_AUTO_MERGE_MAX_ATTEMPTS,
  BOARD_AUTO_MERGE_RETRY_DELAYS_MS,
  boardAutoMergeRetryDelayMs,
  BOARD_RETRY_DELAYS_MS,
  BOARD_USAGE_LIMIT_JITTER_MS,
  BOARD_USAGE_LIMIT_MAX_HORIZON_MS,
  boardRetryDelayMs,
  boardUsageLimitPollDelayMs,
} from "./boardUsageLimitSchedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("boardRetryDelayMs", () => {
  it("climbs 2, 4, 8, 16, 32 minutes", () => {
    expect([0, 1, 2, 3, 4].map(boardRetryDelayMs)).toEqual([
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
      16 * MINUTE,
      32 * MINUTE,
    ]);
  });

  it("clamps past the last rung rather than falling back to zero", () => {
    // A ladder longer than the table (a stage given extra attempts) must keep
    // the ceiling, not silently resume instant re-nudging.
    expect(boardRetryDelayMs(9)).toBe(BOARD_RETRY_DELAYS_MS[BOARD_RETRY_DELAYS_MS.length - 1]);
    expect(boardRetryDelayMs(-3)).toBe(BOARD_RETRY_DELAYS_MS[0]);
  });
});

describe("boardUsageLimitPollDelayMs", () => {
  it("polls every 30 minutes for the first five hours", () => {
    expect(boardUsageLimitPollDelayMs(0)).toBe(30 * MINUTE);
    expect(boardUsageLimitPollDelayMs(4 * HOUR + 59 * MINUTE)).toBe(30 * MINUTE);
  });

  it("coarsens to two hours, then six", () => {
    expect(boardUsageLimitPollDelayMs(5 * HOUR)).toBe(2 * HOUR);
    expect(boardUsageLimitPollDelayMs(2 * DAY - MINUTE)).toBe(2 * HOUR);
    expect(boardUsageLimitPollDelayMs(2 * DAY)).toBe(6 * HOUR);
    expect(boardUsageLimitPollDelayMs(6 * DAY)).toBe(6 * HOUR);
  });

  it("gives up at the seven-day ceiling", () => {
    expect(boardUsageLimitPollDelayMs(BOARD_USAGE_LIMIT_MAX_HORIZON_MS)).toBeNull();
    expect(boardUsageLimitPollDelayMs(30 * DAY)).toBeNull();
  });

  it("reads a negative elapsed as zero rather than giving up", () => {
    expect(boardUsageLimitPollDelayMs(-1)).toBe(30 * MINUTE);
  });
});

describe("applyBoardUsageLimitJitter", () => {
  it("spreads a delay across ±60 seconds", () => {
    expect(applyBoardUsageLimitJitter(30 * MINUTE, 0)).toBe(
      30 * MINUTE - BOARD_USAGE_LIMIT_JITTER_MS,
    );
    expect(applyBoardUsageLimitJitter(30 * MINUTE, 0.5)).toBe(30 * MINUTE);
    expect(applyBoardUsageLimitJitter(30 * MINUTE, 0.999_999)).toBeCloseTo(
      30 * MINUTE + BOARD_USAGE_LIMIT_JITTER_MS,
      -1,
    );
  });

  it("never produces a delay in the past", () => {
    expect(applyBoardUsageLimitJitter(1_000, 0)).toBe(0);
  });
});

describe("boardAutoMergeRetryDelayMs (T3O-38, D5)", () => {
  it("walks 3/3/5/5/10/20/40 minutes and then stops", () => {
    expect(BOARD_AUTO_MERGE_RETRY_DELAYS_MS.map((ms) => ms / MINUTE)).toEqual([
      3, 3, 5, 5, 10, 20, 40,
    ]);
    expect(
      Array.from({ length: BOARD_AUTO_MERGE_MAX_ATTEMPTS }, (_, index) =>
        boardAutoMergeRetryDelayMs(index + 1),
      ),
    ).toEqual([
      3 * MINUTE,
      3 * MINUTE,
      5 * MINUTE,
      5 * MINUTE,
      10 * MINUTE,
      20 * MINUTE,
      40 * MINUTE,
      null,
    ]);
  });

  it("gives eight attempts inside ninety minutes", () => {
    // The ladder has to end well inside a night's sleep: if it were still
    // climbing in the morning the card would be sitting there unexplained,
    // which is exactly the state this feature removes.
    expect(BOARD_AUTO_MERGE_MAX_ATTEMPTS).toBe(8);
    const total = BOARD_AUTO_MERGE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(90 * MINUTE);
  });

  it("ENDS rather than clamping, so an over-count never waits forever", () => {
    // The difference from `boardRetryDelayMs`, which clamps: this ladder's
    // last rung is a state the card shows, not a wait it repeats.
    expect(boardAutoMergeRetryDelayMs(BOARD_AUTO_MERGE_MAX_ATTEMPTS)).toBeNull();
    expect(boardAutoMergeRetryDelayMs(99)).toBeNull();
  });

  it("treats a zero or negative attempt as the first rung", () => {
    expect(boardAutoMergeRetryDelayMs(0)).toBe(3 * MINUTE);
    expect(boardAutoMergeRetryDelayMs(-4)).toBe(3 * MINUTE);
  });
});
