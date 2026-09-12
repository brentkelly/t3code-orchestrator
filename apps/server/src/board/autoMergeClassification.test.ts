import { describe, expect, it } from "@effect/vitest";
import { BOARD_AUTO_MERGE_MAX_ATTEMPTS, type ChangeRequestMergeState } from "@t3tools/contracts";

import {
  boardAutoMergeLadderStep,
  classifyBoardAutoMergeRefusal,
} from "./autoMergeClassification.ts";

const MINUTE = 60_000;

const state = (overrides: Partial<ChangeRequestMergeState> = {}): ChangeRequestMergeState => ({
  mergeable: "blocked",
  blockedReason: null,
  checks: { total: 0, passed: 0, pending: 0, failed: 0, failing: [], running: [] },
  headSha: "abc123",
  ...overrides,
});

const checks = (input: {
  passed?: number;
  pending?: number;
  failed?: number;
  failing?: ReadonlyArray<string>;
  running?: ReadonlyArray<string>;
}) => {
  const passed = input.passed ?? 0;
  const pending = input.pending ?? 0;
  const failed = input.failed ?? 0;
  return {
    total: passed + pending + failed,
    passed,
    pending,
    failed,
    failing: input.failing ?? [],
    running: input.running ?? [],
  };
};

describe("classifyBoardAutoMergeRefusal (T3O-38, D6)", () => {
  it("stops the ladder on a FAILED required check", () => {
    // The point of classifying at all: more CI will not happen without a new
    // commit, so every remaining rung would be spent waiting for nothing.
    const verdict = classifyBoardAutoMergeRefusal(
      state({ checks: checks({ passed: 3, failed: 1, failing: ["ci/test"] }) }),
    );
    expect(verdict.classification).toBe("checks-failed");
    expect(verdict.detail).toBe("3 of 4 checks green · ci/test failed");
  });

  it("waits while checks are still running", () => {
    const verdict = classifyBoardAutoMergeRefusal(
      state({ checks: checks({ passed: 3, pending: 2, running: ["ci/build", "ci/e2e"] }) }),
    );
    expect(verdict.classification).toBe("soft");
    expect(verdict.detail).toBe("3 of 5 checks green · ci/build and ci/e2e still running");
  });

  it("prefers a failure over a pending check: a doomed run is not a wait", () => {
    expect(
      classifyBoardAutoMergeRefusal(state({ checks: checks({ pending: 2, failed: 1 }) }))
        .classification,
    ).toBe("checks-failed");
  });

  it("waits while the forge has not settled its merge state", () => {
    expect(classifyBoardAutoMergeRefusal(state({ mergeable: "unknown" })).classification).toBe(
      "soft",
    );
  });

  it("calls a block with everything green an approval, not a wait", () => {
    expect(
      classifyBoardAutoMergeRefusal(state({ checks: checks({ passed: 4 }) })).classification,
    ).toBe("approval-required");
  });

  it("names a branch that is behind its base, which needs a rebase not a retry", () => {
    expect(
      classifyBoardAutoMergeRefusal(
        state({ blockedReason: "behind", checks: checks({ passed: 2 }) }),
      ).classification,
    ).toBe("behind");
  });

  it("stops on a draft or a conflict the forge reported structurally", () => {
    expect(classifyBoardAutoMergeRefusal(state({ blockedReason: "draft" })).classification).toBe(
      "other",
    );
    expect(classifyBoardAutoMergeRefusal(state({ blockedReason: "conflict" })).classification).toBe(
      "other",
    );
  });

  it("waits when the forge claims mergeable and refused anyway", () => {
    // We do not understand that, so we wait — the safe direction.
    expect(classifyBoardAutoMergeRefusal(state({ mergeable: "mergeable" })).classification).toBe(
      "soft",
    );
  });

  it("says nothing about checks when there are none to describe", () => {
    expect(classifyBoardAutoMergeRefusal(state()).detail).toBeNull();
  });

  it("carries the head sha through, which is what resets the ladder", () => {
    expect(classifyBoardAutoMergeRefusal(state({ headSha: "feed01" })).headSha).toBe("feed01");
  });
});

describe("boardAutoMergeLadderStep (T3O-38, D5/D9)", () => {
  it("charges the first rung on the first soft refusal", () => {
    expect(
      boardAutoMergeLadderStep({
        classification: "soft",
        previousAttempt: 0,
        previousHeadSha: null,
        headSha: "aaa",
      }),
    ).toEqual({ attempt: 1, retryDelayMs: 3 * MINUTE });
  });

  it("walks the ladder and then stops with no next attempt", () => {
    const walk = Array.from({ length: BOARD_AUTO_MERGE_MAX_ATTEMPTS }, (_, index) =>
      boardAutoMergeLadderStep({
        classification: "soft",
        previousAttempt: index,
        previousHeadSha: "aaa",
        headSha: "aaa",
      }),
    );
    expect(walk.map((step) => step.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(walk.map((step) => step.retryDelayMs)).toEqual([
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

  it("stops a HARD refusal on the spot, whatever rungs remain", () => {
    // The entire value of classifying: a hard block is visible within minutes
    // rather than after an hour and a half of a pill that claimed to wait.
    expect(
      boardAutoMergeLadderStep({
        classification: "checks-failed",
        previousAttempt: 0,
        previousHeadSha: null,
        headSha: "aaa",
      }),
    ).toEqual({ attempt: 1, retryDelayMs: null });
  });

  it("resets the ladder when the head sha moves — new commits mean new CI", () => {
    expect(
      boardAutoMergeLadderStep({
        classification: "soft",
        previousAttempt: 6,
        previousHeadSha: "aaa",
        headSha: "bbb",
      }),
    ).toEqual({ attempt: 1, retryDelayMs: 3 * MINUTE });
  });

  it("resets once per DISTINCT sha, not once per refusal after a push", () => {
    // A push cannot spin the ladder without somebody actually pushing each
    // time: the second refusal on the new sha is rung two, not rung one again.
    expect(
      boardAutoMergeLadderStep({
        classification: "soft",
        previousAttempt: 1,
        previousHeadSha: "bbb",
        headSha: "bbb",
      }).attempt,
    ).toBe(2);
  });

  it("does not reset on a sha it could not read", () => {
    // An unreadable probe must not look like a push, or a provider without a
    // sha would retry for ever.
    expect(
      boardAutoMergeLadderStep({
        classification: "soft",
        previousAttempt: 5,
        previousHeadSha: "aaa",
        headSha: null,
      }).attempt,
    ).toBe(6);
  });

  it("never counts past the ladder's length", () => {
    expect(
      boardAutoMergeLadderStep({
        classification: "soft",
        previousAttempt: 99,
        previousHeadSha: "aaa",
        headSha: "aaa",
      }),
    ).toEqual({ attempt: BOARD_AUTO_MERGE_MAX_ATTEMPTS, retryDelayMs: null });
  });
});
