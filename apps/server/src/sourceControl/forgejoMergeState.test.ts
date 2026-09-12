import { describe, expect, it } from "@effect/vitest";

import {
  forgejoMergeState,
  parseForgejoChecks,
  parseForgejoPullRequestMergeability,
} from "./forgejoMergeState.ts";

const NO_CHECKS = {
  total: 0,
  passed: 0,
  pending: 0,
  failed: 0,
  failing: [],
  running: [],
} as const;

describe("parseForgejoPullRequestMergeability (T3O-38, D7)", () => {
  it("reads `mergeable` and the head sha off Gitea's pull request struct", () => {
    expect(
      parseForgejoPullRequestMergeability(
        JSON.stringify({ mergeable: true, head: { ref: "board/t3o-1", sha: "deadbeef" } }),
      ),
    ).toEqual({ mergeable: true, headSha: "deadbeef" });
  });

  it("reads an ABSENT `mergeable` as unknown, never as false", () => {
    // Gitea omits it while it is still computing, and reading "we have not
    // worked it out" as "no" would stop a ladder that should keep waiting.
    expect(
      parseForgejoPullRequestMergeability(JSON.stringify({ head: { sha: "deadbeef" } })).mergeable,
    ).toBeNull();
  });

  it("never throws on a body it cannot read", () => {
    for (const raw of ["", "not json", "[]"]) {
      expect(parseForgejoPullRequestMergeability(raw)).toEqual({ mergeable: null, headSha: null });
    }
  });
});

describe("parseForgejoChecks (T3O-38, D7)", () => {
  const runs = (entries: ReadonlyArray<Record<string, unknown>>) => JSON.stringify(entries);

  it("counts only the runs for the head sha being merged", () => {
    // The listing is repository-wide, so without the filter a card would be
    // classified against somebody else's branch.
    const checks = parseForgejoChecks(
      runs([
        { name: "build", head_sha: "aaa", status: "success" },
        { name: "test", head_sha: "bbb", status: "failure" },
      ]),
      "aaa",
    );
    expect(checks).toMatchObject({ total: 1, passed: 1, failed: 0 });
  });

  it("splits runs into passed, running and failed, and names the first few", () => {
    const checks = parseForgejoChecks(
      runs([
        { name: "build", head_sha: "aaa", status: "success" },
        { name: "e2e", head_sha: "aaa", status: "running" },
        { name: "lint", head_sha: "aaa", status: "failure" },
        { name: "docs", head_sha: "aaa", status: "skipped" },
      ]),
      "aaa",
    );
    expect(checks).toEqual({
      total: 4,
      passed: 2,
      pending: 1,
      failed: 1,
      failing: ["lint"],
      running: ["e2e"],
    });
  });

  it("prefers `conclusion` where a version reports both", () => {
    const checks = parseForgejoChecks(
      runs([{ name: "build", head_sha: "aaa", status: "completed", conclusion: "failure" }]),
      "aaa",
    );
    expect(checks).toMatchObject({ failed: 1, failing: ["build"] });
  });

  it("accepts the wrapped listing shapes Gitea has used", () => {
    const entry = { name: "build", head_sha: "aaa", status: "success" };
    expect(parseForgejoChecks(JSON.stringify({ workflow_runs: [entry] }), "aaa").passed).toBe(1);
    expect(parseForgejoChecks(JSON.stringify({ runs: [entry] }), "aaa").passed).toBe(1);
  });

  it("counts nothing when there is no head sha to filter by, or no readable body", () => {
    expect(parseForgejoChecks(runs([{ name: "build", head_sha: "aaa" }]), null)).toEqual(NO_CHECKS);
    expect(parseForgejoChecks("not json", "aaa")).toEqual(NO_CHECKS);
  });
});

describe("forgejoMergeState (T3O-38, D7)", () => {
  it("reports mergeable when the pull request says so", () => {
    expect(
      forgejoMergeState({
        mergeable: true,
        headSha: "aaa",
        checks: NO_CHECKS,
        checksReadable: true,
      }),
    ).toMatchObject({ mergeable: "mergeable", blockedReason: null, headSha: "aaa" });
  });

  it("reports blocked only when the checks were actually readable", () => {
    // Without check evidence, "not mergeable" is indistinguishable from
    // "CI has not finished", and claiming the former is a HARD stop.
    expect(
      forgejoMergeState({
        mergeable: false,
        headSha: "aaa",
        checks: NO_CHECKS,
        checksReadable: true,
      }).mergeable,
    ).toBe("blocked");
    expect(
      forgejoMergeState({
        mergeable: false,
        headSha: "aaa",
        checks: NO_CHECKS,
        checksReadable: false,
      }).mergeable,
    ).toBe("unknown");
  });

  it("reports unknown when the pull request did not say", () => {
    expect(
      forgejoMergeState({ mergeable: null, headSha: null, checks: NO_CHECKS, checksReadable: true })
        .mergeable,
    ).toBe("unknown");
  });
});
