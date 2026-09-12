import { describe, expect, it } from "@effect/vitest";

import { classifyBoardAutoMergeRefusal } from "../board/autoMergeClassification.ts";
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
    ).toEqual({ mergeable: true, headSha: "deadbeef", behind: null });
  });

  it("reads an ABSENT `mergeable` as unknown, never as false", () => {
    // Gitea omits it while it is still computing, and reading "we have not
    // worked it out" as "no" would stop a ladder that should keep waiting.
    expect(
      parseForgejoPullRequestMergeability(JSON.stringify({ head: { sha: "deadbeef" } })).mergeable,
    ).toBeNull();
  });

  it("reads BEHIND off `merge_base` versus the base tip, and null when either is absent", () => {
    // Gitea has no `BEHIND` field. `merge_base` is the common ancestor and
    // `base.sha` is the base branch's current tip, so the two differing IS the
    // head lacking base commits — evidence, not a guess at an unnamed block.
    const view = (body: Record<string, unknown>) =>
      parseForgejoPullRequestMergeability(
        JSON.stringify({ mergeable: false, head: { sha: "aaa" }, ...body }),
      ).behind;
    expect(view({ merge_base: "old", base: { sha: "new" } })).toBe(true);
    expect(view({ merge_base: "same", base: { sha: "same" } })).toBe(false);
    // Half the evidence is no evidence: an older Gitea that omits either field
    // must not be read as up to date OR as behind.
    expect(view({ base: { sha: "new" } })).toBeNull();
    expect(view({ merge_base: "old" })).toBeNull();
  });

  it("never throws on a body it cannot read", () => {
    for (const raw of ["", "not json", "[]"]) {
      expect(parseForgejoPullRequestMergeability(raw)).toEqual({
        mergeable: null,
        headSha: null,
        behind: null,
      });
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

  it("names BEHIND as the one block reason it can establish, and nothing else", () => {
    // A block with no evidence stays unnamed — the classifier then reads the
    // checks — but a head genuinely missing base commits is reported, because
    // the stored classification is what a remediation acts on.
    expect(
      forgejoMergeState({
        mergeable: false,
        headSha: "aaa",
        checks: NO_CHECKS,
        checksReadable: true,
        behind: true,
      }).blockedReason,
    ).toBe("behind");
    for (const behind of [false, null, undefined]) {
      expect(
        forgejoMergeState({
          mergeable: false,
          headSha: "aaa",
          checks: NO_CHECKS,
          checksReadable: true,
          behind,
        }).blockedReason,
      ).toBeNull();
    }
  });

  it("reports unknown when the pull request did not say", () => {
    expect(
      forgejoMergeState({ mergeable: null, headSha: null, checks: NO_CHECKS, checksReadable: true })
        .mergeable,
    ).toBe("unknown");
  });
});

describe("Forgejo, end to end: probe → classification (T3O-38, criterion 10)", () => {
  /** What the two `fgj` calls answer, run through the real parsers and the
      real classifier — the composition is what the board actually does, and
      testing the halves separately would not prove the whole. */
  const classify = (input: { readonly pr: string; readonly runs: string }) => {
    const { mergeable, headSha, behind } = parseForgejoPullRequestMergeability(input.pr);
    return classifyBoardAutoMergeRefusal(
      forgejoMergeState({
        mergeable,
        headSha,
        behind,
        checks: parseForgejoChecks(input.runs, headSha),
        checksReadable: true,
      }),
    );
  };

  const pullRequest = (mergeable: boolean) =>
    JSON.stringify({ mergeable, head: { ref: "board/t3o-1", sha: "aaa" } });

  it("reads a check that is still running as SOFT and retries", () => {
    const verdict = classify({
      pr: pullRequest(false),
      runs: JSON.stringify([
        { name: "build", head_sha: "aaa", status: "success" },
        { name: "e2e", head_sha: "aaa", status: "running" },
      ]),
    });
    expect(verdict.classification).toBe("soft");
    expect(verdict.detail).toBe("1 of 2 checks green · e2e still running");
    expect(verdict.headSha).toBe("aaa");
  });

  it("reads a FAILED check as hard and stops the ladder", () => {
    const verdict = classify({
      pr: pullRequest(false),
      runs: JSON.stringify([
        { name: "build", head_sha: "aaa", status: "success" },
        { name: "lint", head_sha: "aaa", status: "failure" },
      ]),
    });
    expect(verdict.classification).toBe("checks-failed");
    expect(verdict.detail).toBe("1 of 2 checks green · lint failed");
  });

  it("reads every-check-green-and-still-refused as an approval", () => {
    const verdict = classify({
      pr: pullRequest(false),
      runs: JSON.stringify([{ name: "build", head_sha: "aaa", status: "success" }]),
    });
    expect(verdict.classification).toBe("approval-required");
  });

  it("reads green-but-BEHIND as behind, not as an approval", () => {
    // Both stop the ladder, so nothing about the wait changes — but the stored
    // classification is what a remediation reads, and "go and approve this"
    // is the wrong instruction for a branch that just needs the base merged
    // into it. GitHub gets this from `mergeStateStatus: BEHIND`.
    const verdict = classify({
      pr: JSON.stringify({
        mergeable: false,
        head: { ref: "board/t3o-1", sha: "aaa" },
        base: { ref: "t3o", sha: "base-tip" },
        merge_base: "older-ancestor",
      }),
      runs: JSON.stringify([{ name: "build", head_sha: "aaa", status: "success" }]),
    });
    expect(verdict.classification).toBe("behind");
  });

  it("stays SOFT when the run listing could not be read at all", () => {
    // An instance without Actions, or an `fgj` whose output this build cannot
    // parse. Claiming every check is green when we never saw one would stop
    // the ladder on the first refusal.
    const { mergeable, headSha } = parseForgejoPullRequestMergeability(pullRequest(false));
    const verdict = classifyBoardAutoMergeRefusal(
      forgejoMergeState({ mergeable, headSha, checks: NO_CHECKS, checksReadable: false }),
    );
    expect(verdict.classification).toBe("soft");
  });
});
