import { describe, expect, it } from "@effect/vitest";

import { parseGitHubMergeState } from "./gitHubMergeState.ts";

const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    mergeStateStatus: "CLEAN",
    headRefOid: "abc123",
    statusCheckRollup: [],
    ...overrides,
  });

describe("parseGitHubMergeState (T3O-38, D7)", () => {
  it("reads a clean pull request as mergeable with its head sha", () => {
    expect(parseGitHubMergeState(body())).toEqual({
      mergeable: "mergeable",
      blockedReason: null,
      checks: { total: 0, passed: 0, pending: 0, failed: 0, failing: [], running: [] },
      headSha: "abc123",
    });
  });

  it("maps each mergeStateStatus onto the two facts the board acts on", () => {
    const state = (status: string) => parseGitHubMergeState(body({ mergeStateStatus: status }));
    // UNSTABLE means non-required checks are failing and GitHub will merge it
    // anyway, so calling it blocked would stop a ladder the forge is willing
    // to finish.
    expect(state("UNSTABLE").mergeable).toBe("mergeable");
    expect(state("HAS_HOOKS").mergeable).toBe("mergeable");
    expect(state("BEHIND")).toMatchObject({ mergeable: "blocked", blockedReason: "behind" });
    expect(state("DIRTY")).toMatchObject({ mergeable: "blocked", blockedReason: "conflict" });
    expect(state("DRAFT")).toMatchObject({ mergeable: "blocked", blockedReason: "draft" });
    expect(state("BLOCKED")).toMatchObject({ mergeable: "blocked", blockedReason: "other" });
  });

  it("reads a status GitHub has not settled as unknown, never as blocked", () => {
    expect(parseGitHubMergeState(body({ mergeStateStatus: "UNKNOWN" })).mergeable).toBe("unknown");
    // A status token this build has never seen degrades the same way — the
    // failure direction that retries.
    expect(parseGitHubMergeState(body({ mergeStateStatus: "SOMETHING_NEW" })).mergeable).toBe(
      "unknown",
    );
  });

  it("counts check runs by conclusion and names the failures", () => {
    const state = parseGitHubMergeState(
      body({
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "ci/test", status: "COMPLETED", conclusion: "FAILURE" },
          { __typename: "CheckRun", name: "ci/e2e", status: "IN_PROGRESS", conclusion: "" },
        ],
      }),
    );
    expect(state.checks).toEqual({
      total: 3,
      passed: 1,
      pending: 1,
      failed: 1,
      failing: ["ci/test"],
      running: ["ci/e2e"],
    });
  });

  it("counts commit statuses, which report `state` rather than a conclusion", () => {
    const state = parseGitHubMergeState(
      body({
        statusCheckRollup: [
          { __typename: "StatusContext", context: "buildkite", state: "PENDING" },
          { __typename: "StatusContext", context: "codecov", state: "ERROR" },
          { __typename: "StatusContext", context: "vercel", state: "SUCCESS" },
        ],
      }),
    );
    expect(state.checks).toMatchObject({
      passed: 1,
      pending: 1,
      failed: 1,
      failing: ["codecov"],
      running: ["buildkite"],
    });
  });

  it("treats NEUTRAL and SKIPPED as passes, because GitHub merges over them", () => {
    const state = parseGitHubMergeState(
      body({
        statusCheckRollup: [
          { name: "lint", status: "COMPLETED", conclusion: "NEUTRAL" },
          { name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
        ],
      }),
    );
    expect(state.checks).toMatchObject({ passed: 2, pending: 0, failed: 0 });
  });

  it("bounds the named checks, because the names are persisted and rendered", () => {
    const state = parseGitHubMergeState(
      body({
        statusCheckRollup: Array.from({ length: 12 }, (_, index) => ({
          name: `ci/${index}`,
          status: "COMPLETED",
          conclusion: "FAILURE",
        })),
      }),
    );
    expect(state.checks.failed).toBe(12);
    expect(state.checks.failing).toHaveLength(4);
  });

  it("never throws on a body it cannot read, and reports unknown instead", () => {
    for (const raw of ["", "not json", "null", "[]", '{"statusCheckRollup":"nope"}']) {
      const state = parseGitHubMergeState(raw);
      expect(state.mergeable).toBe("unknown");
      expect(state.checks.total).toBe(0);
      expect(state.headSha).toBeNull();
    }
  });
});
