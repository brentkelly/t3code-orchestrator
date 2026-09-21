import { describe, expect, it } from "@effect/vitest";

import { classifyBoardAutoMergeRefusal } from "../board/autoMergeClassification.ts";
import {
  forgejoMergeState,
  forgejoRefusalDetail,
  parseForgejoCommitStatuses,
  parseForgejoPullRequestMergeability,
  parseForgejoPullRequestMerged,
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

describe("parseForgejoCommitStatuses (T3O-38, D7)", () => {
  const combined = (statuses: ReadonlyArray<Record<string, unknown>> | null) =>
    JSON.stringify({ state: "pending", sha: "aaa", statuses });

  it("splits statuses into passed, running and failed, and names the first few", () => {
    expect(
      parseForgejoCommitStatuses(
        combined([
          { context: "build", status: "success" },
          { context: "e2e", status: "pending" },
          { context: "lint", status: "failure" },
          { context: "docs", status: "warning" },
          { context: "deploy", status: "error" },
        ]),
      ),
    ).toEqual({
      total: 5,
      passed: 2,
      pending: 1,
      failed: 2,
      failing: ["lint", "deploy"],
      running: ["e2e"],
    });
  });

  it("reads the GitHub-compatible `state` spelling too", () => {
    expect(
      parseForgejoCommitStatuses(combined([{ context: "build", state: "success" }])),
    ).toMatchObject({ total: 1, passed: 1 });
  });

  it("bounds the named checks, because the text is persisted on the card", () => {
    const failing = Array.from({ length: 9 }, (_, index) => ({
      context: `check-${index}`,
      status: "failure",
    }));
    const checks = parseForgejoCommitStatuses(combined(failing));
    expect(checks?.failed).toBe(9);
    expect(checks?.failing).toEqual(["check-0", "check-1", "check-2", "check-3"]);
  });

  it("reads a commit nobody reported on as READABLE and empty", () => {
    // Gitea writes `"statuses": null` there. That is an answer — "no checks" —
    // and must not be confused with a body that could not be read.
    expect(parseForgejoCommitStatuses(combined(null))).toEqual(NO_CHECKS);
    expect(parseForgejoCommitStatuses(combined([]))).toEqual(NO_CHECKS);
  });

  it("answers null — could not look — for anything that is not a combined status", () => {
    for (const raw of ["", "not json", "[]", "{}", JSON.stringify({ statuses: "nope" })]) {
      expect(parseForgejoCommitStatuses(raw)).toBeNull();
    }
  });
});

describe("parseForgejoPullRequestMerged", () => {
  it("is true only for an explicit `merged: true`", () => {
    expect(parseForgejoPullRequestMerged(JSON.stringify({ merged: true }))).toBe(true);
    expect(parseForgejoPullRequestMerged(JSON.stringify({ merged: false }))).toBe(false);
    expect(parseForgejoPullRequestMerged(JSON.stringify({ state: "closed" }))).toBe(false);
    expect(parseForgejoPullRequestMerged("not json")).toBe(false);
  });
});

describe("forgejoRefusalDetail", () => {
  it("lifts the forge's own message out of the API error envelope", () => {
    expect(
      forgejoRefusalDetail(
        'Forgejo API request failed (HTTP 405): {"message":"Please try again later","url":"https://codeberg.org/api/swagger"}',
      ),
    ).toBe("Please try again later");
  });

  it("renders a merge refusal from its status when no message came back", () => {
    // tea's branch of `ForgejoCli.api` reports the status and nothing else.
    expect(forgejoRefusalDetail("Forgejo API request failed (HTTP 405).", 405)).toContain(
      "refused to merge the pull request",
    );
    expect(forgejoRefusalDetail("Forgejo API request failed (HTTP 409).", 409)).toContain(
      "conflicts with its base branch",
    );
  });

  it("keeps the forge's message, and any non-refusal envelope, ahead of the status", () => {
    expect(
      forgejoRefusalDetail('Forgejo API request failed (HTTP 405): {"message":"Nope"}', 405),
    ).toBe("Nope");
    const server = "Forgejo API request failed (HTTP 500).";
    expect(forgejoRefusalDetail(server, 500)).toBe(server);
  });

  it("keeps the envelope when the forge sent nothing readable", () => {
    for (const detail of [
      "Forgejo API request failed (HTTP 405).",
      "Forgejo API request failed (HTTP 500): {not json",
      'Forgejo API request failed (HTTP 409): {"message":"  "}',
    ]) {
      expect(forgejoRefusalDetail(detail)).toBe(detail);
    }
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
  /** What the two API reads answer, run through the real parsers and the
      real classifier — the composition is what the board actually does, and
      testing the halves separately would not prove the whole. */
  const classify = (input: { readonly pr: string; readonly runs: string }) => {
    const { mergeable, headSha, behind } = parseForgejoPullRequestMergeability(input.pr);
    const checks = parseForgejoCommitStatuses(input.runs);
    return classifyBoardAutoMergeRefusal(
      forgejoMergeState({
        mergeable,
        headSha,
        behind,
        checks: checks ?? NO_CHECKS,
        checksReadable: checks !== null,
      }),
    );
  };

  const pullRequest = (mergeable: boolean) =>
    JSON.stringify({ mergeable, head: { ref: "board/t3o-1", sha: "aaa" } });

  it("reads a check that is still running as SOFT and retries", () => {
    const verdict = classify({
      pr: pullRequest(false),
      runs: JSON.stringify({
        statuses: [
          { context: "build", status: "success" },
          { context: "e2e", status: "pending" },
        ],
      }),
    });
    expect(verdict.classification).toBe("soft");
    expect(verdict.detail).toBe("1 of 2 checks green · e2e still running");
    expect(verdict.headSha).toBe("aaa");
  });

  it("reads a FAILED check as hard and stops the ladder", () => {
    const verdict = classify({
      pr: pullRequest(false),
      runs: JSON.stringify({
        statuses: [
          { context: "build", status: "success" },
          { context: "lint", status: "failure" },
        ],
      }),
    });
    expect(verdict.classification).toBe("checks-failed");
    expect(verdict.detail).toBe("1 of 2 checks green · lint failed");
  });

  it("reads every-check-green-and-still-refused as an approval", () => {
    const verdict = classify({
      pr: pullRequest(false),
      runs: JSON.stringify({ statuses: [{ context: "build", status: "success" }] }),
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
      runs: JSON.stringify({ statuses: [{ context: "build", status: "success" }] }),
    });
    expect(verdict.classification).toBe("behind");
  });

  it("stays SOFT when the statuses could not be read at all", () => {
    // A status read that failed, or a body this build cannot parse. Claiming
    // every check is green when we never saw one would stop the ladder on the
    // first refusal.
    expect(classify({ pr: pullRequest(false), runs: "not json" }).classification).toBe("soft");
  });
});
