/**
 * T3o (T3O-47): reading a refusal out of the host's own detail.
 *
 * This is the input to every auto-merge verdict, so the rules that matter are
 * the ones the classifier turns on: what counts as a failed check, what a
 * conflict outranks, and that "the host says it is fine and refused anyway"
 * is never read as a decision (T3O-67). The forge's own words explain it.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  SourceControlProviderKind,
  type PullRequestCheck,
  type PullRequestDetail,
} from "@t3tools/contracts";

import {
  BOARD_MERGE_FORGE_TEXT_MAX_LENGTH,
  BOARD_MERGE_STATE_MAX_NAMED_CHECKS,
  boardHostMergeRefusalReason,
  boardMergeRefusalReason,
  boardMergeStateOf,
} from "./boardMergeState.ts";

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: null,
});

function detail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    provider: SourceControlProviderKind.make("github"),
    capabilities: {} as PullRequestDetail["capabilities"],
    viewerPermissions: {} as PullRequestDetail["viewerPermissions"],
    projectId: "p" as PullRequestDetail["projectId"],
    projectTitle: "T3o",
    workspaceRoot: "/repo",
    repository: "owner/repo",
    number: 1,
    title: "A change",
    body: "",
    url: "https://github.com/owner/repo/pull/1",
    author: null,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headBranch: "board/t3o-47",
    baseBranch: "t3o",
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    baseComparison: "up-to-date",
    ...overrides,
  };
}

describe("boardMergeStateOf: checks", () => {
  it("counts a run that has not finished as pending, and names it", () => {
    const state = boardMergeStateOf(detail({ checks: [check("ci/build", "pending")] }));

    assert.deepStrictEqual(state.checks, {
      total: 1,
      passed: 0,
      pending: 1,
      failed: 0,
      failing: [],
      running: ["ci/build"],
    });
    assert.strictEqual(state.mergeable, "mergeable");
  });

  it("counts action-required and cancelled as failed: neither clears on its own", () => {
    const state = boardMergeStateOf(
      detail({
        checks: [check("ci/approve", "action-required"), check("ci/e2e", "cancelled")],
      }),
    );

    assert.strictEqual(state.checks.failed, 2);
    assert.deepStrictEqual(state.checks.failing, ["ci/approve", "ci/e2e"]);
  });

  it("counts neutral and skipped as passed, because the host does not block on them", () => {
    const state = boardMergeStateOf(
      detail({
        checks: [check("ci/optional", "neutral"), check("ci/skipped", "skipped")],
      }),
    );

    assert.strictEqual(state.checks.passed, 2);
    assert.strictEqual(state.checks.failed, 0);
  });

  it("bounds the named checks without losing the counts", () => {
    const failures = Array.from({ length: 9 }, (_, index) => check(`ci/${index}`, "failure"));
    const state = boardMergeStateOf(detail({ checks: failures }));

    assert.strictEqual(state.checks.failed, 9);
    assert.strictEqual(state.checks.failing.length, BOARD_MERGE_STATE_MAX_NAMED_CHECKS);
  });
});

describe("boardMergeStateOf: why the host is blocking", () => {
  it("reads a conflict ahead of everything else, because it has its own fix path", () => {
    const state = boardMergeStateOf(
      detail({
        mergeability: "conflicting",
        isDraft: true,
        baseComparison: "behind",
        checks: [check("ci/build", "failure")],
      }),
    );

    assert.strictEqual(state.mergeable, "blocked");
    assert.strictEqual(state.blockedReason, "conflict");
  });

  it("reads a draft", () => {
    const state = boardMergeStateOf(detail({ isDraft: true }));

    assert.strictEqual(state.blockedReason, "draft");
  });

  it("reads a branch behind its base", () => {
    const state = boardMergeStateOf(detail({ baseComparison: "behind", behindBy: 3 }));

    assert.strictEqual(state.blockedReason, "behind");
  });

  it("keeps 'still working it out' distinct from 'no'", () => {
    const state = boardMergeStateOf(detail({ mergeability: "unknown" }));

    assert.strictEqual(state.mergeable, "unknown");
    assert.strictEqual(state.blockedReason, null);
  });

  it("does not guess why a green, ready, up-to-date pull request was refused (T3O-67)", () => {
    // Read by elimination this was a missing approval, a hard stop. A merge
    // refused because the token could read the pull request but not merge it
    // looks exactly the same, and sat held behind a reason that was not true.
    const state = boardMergeStateOf(detail({ checks: [check("ci/build", "success")] }));

    assert.strictEqual(state.mergeable, "mergeable");
    assert.strictEqual(state.blockedReason, null);
  });

  it("does not call it a decision while checks are still running", () => {
    const state = boardMergeStateOf(detail({ checks: [check("ci/build", "pending")] }));

    assert.strictEqual(state.mergeable, "mergeable");
    assert.strictEqual(state.blockedReason, null);
  });

  it("does not call it a decision on a host that could not compare the branch", () => {
    // Every host but GitHub reports no comparison, and a branch that is merely
    // behind must not be read as a block only a human can clear.
    for (const baseComparison of ["unknown", undefined] as const) {
      const state = boardMergeStateOf(
        detail(
          baseComparison === undefined
            ? { ...detail(), baseComparison: undefined }
            : { baseComparison },
        ),
      );

      assert.strictEqual(state.mergeable, "mergeable", String(baseComparison));
      assert.strictEqual(state.blockedReason, null, String(baseComparison));
    }
  });

  it("carries the head commit through, and null where the host reported none", () => {
    assert.strictEqual(boardMergeStateOf(detail({ headSha: "abc123" })).headSha, "abc123");
    assert.strictEqual(boardMergeStateOf(detail()).headSha, null);
  });
});

describe("boardMergeRefusalReason", () => {
  it("says the checks are failing before anything the host is blocking on", () => {
    const state = boardMergeStateOf(
      detail({ isDraft: true, checks: [check("ci/build", "failure")] }),
    );

    assert.strictEqual(boardMergeRefusalReason(state), "Its checks are failing.");
  });

  it("names each block the board can act on", () => {
    assert.strictEqual(
      boardMergeRefusalReason(boardMergeStateOf(detail({ mergeability: "conflicting" }))),
      "Its pull request conflicts with its base branch.",
    );
    assert.strictEqual(
      boardMergeRefusalReason(boardMergeStateOf(detail({ isDraft: true }))),
      "Its pull request is still a draft.",
    );
    assert.strictEqual(
      boardMergeRefusalReason(boardMergeStateOf(detail({ baseComparison: "behind" }))),
      "Its branch is behind its base branch.",
    );
  });

  it("concludes nothing from checks the token could not read (T3O-8)", () => {
    // The unread checks may simply still be running.
    const state = boardMergeStateOf(detail({ baseComparison: "up-to-date", checksUnread: true }));
    assert.strictEqual(state.mergeable, "mergeable");
    assert.strictEqual(state.blockedReason, null);
    assert.include(boardMergeRefusalReason(state), "may not read the pull request's checks");
  });

  it("still names a conflict when the checks could not be read (T3O-8)", () => {
    const state = boardMergeStateOf(detail({ mergeability: "conflicting", checksUnread: true }));
    assert.strictEqual(state.blockedReason, "conflict");
  });

  it("says the read failed, not that the forge gave no reason, when the probe failed", () => {
    assert.strictEqual(
      boardMergeRefusalReason(null),
      "The forge refused the merge, and asking it why failed.",
    );
    assert.strictEqual(
      boardMergeRefusalReason(null, "GitHub API rate limit exceeded."),
      "The forge refused the merge, and asking it why failed: GitHub API rate limit exceeded.",
    );
  });
});

describe("boardHostMergeRefusalReason (T3O-67)", () => {
  const GITHUB_SAYS = "GitHub returned an error: Resource not accessible by personal access token";

  it("lets the forge explain a refusal the detail cannot", () => {
    const state = boardMergeStateOf(detail({ checks: [check("ci/build", "success")] }));

    assert.strictEqual(
      boardHostMergeRefusalReason(state, undefined, GITHUB_SAYS),
      `The forge refused the merge: ${GITHUB_SAYS}`,
    );
  });

  it("leads with the cause the detail names, then gives the forge's words", () => {
    const state = boardMergeStateOf(detail({ mergeability: "conflicting" }));

    assert.strictEqual(
      boardHostMergeRefusalReason(state, undefined, "GitHub returned an error: not mergeable"),
      "Its pull request conflicts with its base branch. The forge said: GitHub returned an error: not mergeable",
    );
    const failing = boardMergeStateOf(detail({ checks: [check("ci/test", "failure")] }));
    assert.strictEqual(
      boardHostMergeRefusalReason(failing, undefined, "GitHub returned HTTP 405."),
      "Its checks are failing. The forge said: GitHub returned HTTP 405.",
    );
  });

  it("keeps the failed-probe sentence and adds the forge's words", () => {
    assert.strictEqual(
      boardHostMergeRefusalReason(null, "GitHub API rate limit exceeded.", GITHUB_SAYS),
      `The forge refused the merge, and asking it why failed: GitHub API rate limit exceeded. The forge said: ${GITHUB_SAYS}`,
    );
  });

  it("falls back to the derived sentence when the forge said nothing", () => {
    const state = boardMergeStateOf(detail({ checks: [check("ci/build", "success")] }));

    assert.strictEqual(
      boardHostMergeRefusalReason(state, undefined, "   "),
      "The forge refused the merge and did not say why.",
    );
    assert.strictEqual(
      boardHostMergeRefusalReason(state, undefined, undefined),
      "The forge refused the merge and did not say why.",
    );
  });

  it("bounds the forge's text, because the card persists and renders it", () => {
    const state = boardMergeStateOf(detail());
    const reason = boardHostMergeRefusalReason(state, undefined, "x".repeat(2_000));
    const said = reason.slice("The forge refused the merge: ".length);

    assert.strictEqual(said.length, BOARD_MERGE_FORGE_TEXT_MAX_LENGTH);
    assert.isTrue(said.endsWith("…"));
  });
});
