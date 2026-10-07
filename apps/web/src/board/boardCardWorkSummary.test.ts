/**
 * The Summary pane's derived recap (T3O-5). Pure over card detail + stages +
 * optional plan rows — empty copy, skip-review, a running loop, a split
 * parent, and a title-absent PR are the cases the pane must not invent.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BOARD_SEED_STAGES,
  BoardCardId,
  ProjectId,
  boardPlanId,
  makeBoardCardShell,
  type BoardCard,
  type BoardCardDetail,
  type BoardStepCompletion,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveBoardPlanRows } from "./boardPlanRows";
import { boardCardHasSummaryPane, deriveBoardCardWorkSummary } from "./boardCardWorkSummary";

const NOW = "2026-01-01T00:00:00.000Z";
const cardId = BoardCardId.make("card-1");

function card(overrides?: Partial<BoardCard>): BoardCard {
  return {
    id: cardId,
    key: "T3O-5",
    cardNumber: 5,
    projectId: ProjectId.make("project-1"),
    labels: [],
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    stage: BOARD_SEED_STAGE_IDS.review,
    orderKey: "m",
    title: "Summary Tab",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoStart: false,
    autoMerge: false,
    autoMergeHold: null,
    worktree: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function detail(
  overrides?: Partial<BoardCard>,
  edges?: Partial<Pick<BoardCardDetail, "stepCompletions" | "plans" | "children">>,
): BoardCardDetail {
  const plans = edges?.plans ?? [];
  return {
    card: card(overrides),
    brief: null,
    hasPlan: plans.length > 0,
    plans,
    children: edges?.children ?? [],
    dependencies: [],
    dependents: [],
    activity: [],
    parentModelOverrides: null,
    stepError: null,
    stepCompletions: edges?.stepCompletions ?? [],
  };
}

function completion(
  stepId: string,
  payload: unknown,
  summary = `did ${stepId}`,
): BoardStepCompletion {
  return {
    cardId,
    stepId,
    outcome: "succeeded",
    summary,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    threadId: null,
    completedAt: NOW,
  };
}

const openPr = {
  number: 110,
  url: "https://github.com/acme/repo/pull/110",
  state: "open" as const,
  title: "Summary tab",
  headBranch: "board/t3o-5",
  baseRef: "t3o",
  checkedAt: NOW,
};

describe("boardCardHasSummaryPane", () => {
  it("shows from Code review through Done", () => {
    expect(
      boardCardHasSummaryPane({
        stages: BOARD_SEED_STAGES,
        stage: BOARD_SEED_STAGE_IDS.review,
        stepCompletions: [],
        card: card(),
      }),
    ).toBe(true);
    expect(
      boardCardHasSummaryPane({
        stages: BOARD_SEED_STAGES,
        stage: BOARD_SEED_STAGE_IDS.merge,
        stepCompletions: [],
        card: card({ stage: BOARD_SEED_STAGE_IDS.merge }),
      }),
    ).toBe(true);
    expect(
      boardCardHasSummaryPane({
        stages: BOARD_SEED_STAGES,
        stage: BOARD_SEED_STAGE_IDS.done,
        stepCompletions: [],
        card: card({ stage: BOARD_SEED_STAGE_IDS.done }),
      }),
    ).toBe(true);
  });

  it("hides in Building unless a review already ran or a PR is linked", () => {
    const hidden = boardCardHasSummaryPane({
      stages: BOARD_SEED_STAGES,
      stage: BOARD_SEED_STAGE_IDS.building,
      stepCompletions: [],
      card: card({ stage: BOARD_SEED_STAGE_IDS.building }),
    });
    expect(hidden).toBe(false);

    expect(
      boardCardHasSummaryPane({
        stages: BOARD_SEED_STAGES,
        stage: BOARD_SEED_STAGE_IDS.building,
        stepCompletions: [completion("review@1", { reviewedSha: "sha", findings: [] })],
        card: card({ stage: BOARD_SEED_STAGE_IDS.building }),
      }),
    ).toBe(true);

    expect(
      boardCardHasSummaryPane({
        stages: BOARD_SEED_STAGES,
        stage: BOARD_SEED_STAGE_IDS.building,
        stepCompletions: [],
        card: card({ stage: BOARD_SEED_STAGE_IDS.building, pullRequest: openPr }),
      }),
    ).toBe(true);
  });
});

describe("deriveBoardCardWorkSummary", () => {
  it("uses the empty copy when nothing has run", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail({ stage: BOARD_SEED_STAGE_IDS.merge }),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.review.empty).toBe(true);
    expect(summary.build.empty).toBe(true);
    expect(summary.pullRequest.empty).toBe(true);
    expect(summary.verdict.label).toBe("No pull request");
    expect(summary.verdict.tone).toBe("warning");
  });

  it("recaps a skip-review merge with a build summary and a PR", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        { stage: BOARD_SEED_STAGE_IDS.merge, pullRequest: openPr },
        {
          stepCompletions: [
            completion(String(BOARD_SEED_STAGE_IDS.building), null, "Wired the summary pane"),
          ],
        },
      ),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.review.empty).toBe(true);
    expect(summary.build.empty).toBe(false);
    expect(summary.build.summary).toBe("Wired the summary pane");
    expect(summary.pullRequest.number).toBe(110);
    expect(summary.pullRequest.title).toBe("Summary tab");
    expect(summary.verdict.label).toBe("Ready for merge");
    expect(summary.verdict.tone).toBe("attention");
  });

  it("marks a mid-review loop as running and lists outstanding titles", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        { stage: BOARD_SEED_STAGE_IDS.review },
        {
          stepCompletions: [
            completion("review@1", {
              reviewedSha: "sha1",
              findings: [
                {
                  id: "f1",
                  severity: "critical",
                  file: "a.ts",
                  line: 1,
                  title: "Null deref",
                  detail: "",
                },
                {
                  id: "f2",
                  severity: "nitpick",
                  file: "b.ts",
                  line: 2,
                  title: "Naming",
                  detail: "",
                },
              ],
            }),
          ],
        },
      ),
      reviewLive: true,
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.verdict.label).toBe("Review running");
    expect(summary.verdict.tone).toBe("info");
    expect(summary.review.empty).toBe(false);
    expect(summary.review.currentRound).toBe(1);
    expect(summary.review.severities).toEqual({ critical: 1, improvement: 0, nitpick: 1 });
    expect(summary.review.outstanding.map((finding) => finding.title)).toEqual([
      "Null deref",
      "Naming",
    ]);
  });

  it("uses waiting-to-run violet when the review phase is due but no thread is live", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        { stage: BOARD_SEED_STAGE_IDS.review },
        {
          stepCompletions: [
            completion("review@1", {
              reviewedSha: "sha1",
              findings: [
                {
                  id: "f1",
                  severity: "critical",
                  file: "a.ts",
                  line: 1,
                  title: "Null deref",
                  detail: "",
                },
              ],
            }),
          ],
        },
      ),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.verdict.label).toBe("Waiting to run");
    expect(summary.verdict.tone).toBe("attention");
  });

  it("labels a stalled first review step Review stopped in amber", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail({ stage: BOARD_SEED_STAGE_IDS.review }),
      reviewStalled: true,
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.review.empty).toBe(true);
    expect(summary.verdict.label).toBe("Review stopped");
    expect(summary.verdict.tone).toBe("warning");
  });

  it("labels a stalled review step Review stopped in amber", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        { stage: BOARD_SEED_STAGE_IDS.review },
        {
          stepCompletions: [
            completion("review@1", {
              reviewedSha: "sha1",
              findings: [
                {
                  id: "f1",
                  severity: "critical",
                  file: "a.ts",
                  line: 1,
                  title: "Null deref",
                  detail: "",
                },
              ],
            }),
          ],
        },
      ),
      reviewStalled: true,
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.verdict.label).toBe("Review stopped");
    expect(summary.verdict.tone).toBe("warning");
  });

  it("labels a held loop Stopped in amber, matching the Review pane", () => {
    const findings = [
      {
        id: "f1",
        severity: "critical" as const,
        file: "a.ts",
        line: 1,
        title: "Still broken",
        detail: "",
      },
    ];
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        {
          stage: BOARD_SEED_STAGE_IDS.review,
          reviewOverrides: {
            rounds: null,
            stopAfterRound: 1,
            roundModels: {},
            runThroughRound: null,
          },
        },
        {
          stepCompletions: [
            completion("review@1", { reviewedSha: "sha1", findings }),
            completion("triage@1", {
              fixedSha: "sha2",
              dispositions: [{ findingId: "f1", action: "fixed", note: "" }],
            }),
            completion("adjudicate@1", {
              verdicts: [{ findingId: "f1", verdict: "fix-incomplete", note: "" }],
            }),
          ],
        },
      ),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.verdict.label).toBe("Stopped");
    expect(summary.verdict.tone).toBe("warning");
  });

  it("keeps Blocked when a stalled review is also warning", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail({ stage: BOARD_SEED_STAGE_IDS.review, blocked: true }),
      reviewStalled: true,
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.verdict.label).toBe("Blocked");
    expect(summary.verdict.tone).toBe("warning");
  });

  it("keeps No pull request at merge when a held loop is also warning", () => {
    const findings = [
      {
        id: "f1",
        severity: "critical" as const,
        file: "a.ts",
        line: 1,
        title: "Still broken",
        detail: "",
      },
    ];
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        {
          stage: BOARD_SEED_STAGE_IDS.merge,
          pullRequest: null,
          reviewOverrides: {
            rounds: null,
            stopAfterRound: 1,
            roundModels: {},
            runThroughRound: null,
          },
        },
        {
          stepCompletions: [
            completion("review@1", { reviewedSha: "sha1", findings }),
            completion("triage@1", {
              fixedSha: "sha2",
              dispositions: [{ findingId: "f1", action: "fixed", note: "" }],
            }),
            completion("adjudicate@1", {
              verdicts: [{ findingId: "f1", verdict: "fix-incomplete", note: "" }],
            }),
          ],
        },
      ),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.verdict.label).toBe("No pull request");
    expect(summary.verdict.tone).toBe("warning");
  });

  it("prefers Merged over Review settled on a done card", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        {
          stage: BOARD_SEED_STAGE_IDS.done,
          pullRequest: { ...openPr, state: "merged" },
        },
        {
          stepCompletions: [completion("review@1", { reviewedSha: "sha", findings: [] })],
        },
      ),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.verdict.label).toBe("Merged");
    expect(summary.verdict.tone).toBe("success");
  });

  it("labels a closed pull request at merge amber", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail({
        stage: BOARD_SEED_STAGE_IDS.merge,
        pullRequest: { ...openPr, state: "closed" },
      }),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.verdict.label).toBe("Pull request closed");
    expect(summary.verdict.tone).toBe("warning");
  });

  it("labels No pull request at merge when only a retired round remains", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail({
        stage: BOARD_SEED_STAGE_IDS.merge,
        pullRequest: null,
        pullRequestHistory: [{ ...openPr, state: "merged" }],
      }),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.verdict.label).toBe("No pull request");
    expect(summary.verdict.tone).toBe("warning");
    expect(summary.pullRequest.empty).toBe(false);
    expect(summary.pullRequest.number).toBe(110);
  });

  it("keeps the previous round's outstanding titles when the next review has not landed", () => {
    const findings = [
      {
        id: "f1",
        severity: "critical" as const,
        file: "a.ts",
        line: 1,
        title: "Null deref",
        detail: "",
      },
    ];
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        { stage: BOARD_SEED_STAGE_IDS.review },
        {
          stepCompletions: [
            completion("review@1", { reviewedSha: "sha1", findings }),
            completion("triage@1", {
              fixedSha: "sha2",
              dispositions: [{ findingId: "f1", action: "fixed", note: "" }],
            }),
            completion("adjudicate@1", {
              verdicts: [{ findingId: "f1", verdict: "fix-incomplete", note: "" }],
            }),
          ],
        },
      ),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.review.currentRound).toBe(2);
    expect(summary.review.counts.open + summary.review.counts.disputed).toBeGreaterThan(0);
    expect(summary.review.outstanding.map((finding) => finding.title)).toEqual(["Null deref"]);
  });

  it("does not list outstanding findings once a round closed clean", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        { stage: BOARD_SEED_STAGE_IDS.merge, pullRequest: { ...openPr, state: "open" } },
        {
          stepCompletions: [completion("review@1", { reviewedSha: "sha", findings: [] })],
        },
      ),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.review.outstanding).toEqual([]);
    expect(summary.verdict.tone).toBe("attention");
    expect(summary.review.counts.raised).toBe(0);
  });

  it("prefers amber no-convergence over a ready-for-merge waiting state", () => {
    const findings = [
      {
        id: "f1",
        severity: "critical" as const,
        file: "a.ts",
        line: 1,
        title: "Still broken",
        detail: "",
      },
    ];
    const summary = deriveBoardCardWorkSummary({
      detail: detail(
        { stage: BOARD_SEED_STAGE_IDS.merge, pullRequest: openPr },
        {
          stepCompletions: [
            completion("review@1", { reviewedSha: "sha1", findings }),
            completion("triage@1", {
              fixedSha: "sha2",
              dispositions: [{ findingId: "f1", action: "fixed", note: "" }],
            }),
            completion("adjudicate@1", {
              verdicts: [{ findingId: "f1", verdict: "fix-incomplete", note: "" }],
            }),
          ],
        },
      ),
      stages: BOARD_SEED_STAGES,
      maxRounds: 1,
    });
    expect(summary.verdict.label).toBe("No convergence");
    expect(summary.verdict.tone).toBe("warning");
  });

  it("shows a title-absent PR as #N with no title", () => {
    const summary = deriveBoardCardWorkSummary({
      detail: detail({
        stage: BOARD_SEED_STAGE_IDS.done,
        pullRequest: { ...openPr, title: null, state: "merged" },
      }),
      stages: BOARD_SEED_STAGES,
    });
    expect(summary.pullRequest.empty).toBe(false);
    expect(summary.pullRequest.number).toBe(110);
    expect(summary.pullRequest.title).toBeNull();
    expect(summary.verdict.label).toBe("Merged");
    expect(summary.verdict.tone).toBe("success");
  });

  it("uses child plan progress for a split parent's build recap", () => {
    const parent = detail(
      { stage: BOARD_SEED_STAGE_IDS.review },
      {
        plans: [
          {
            planId: boardPlanId(cardId, "a"),
            cardId,
            title: "Pane",
            summary: "Pane",
            dependsOn: [],
            ordinal: 0,
            locked: false,
            createdAt: NOW,
            updatedAt: NOW,
            body: "# Pane",
          },
          {
            planId: boardPlanId(cardId, "b"),
            cardId,
            title: "Title",
            summary: "Title",
            dependsOn: [],
            ordinal: 1,
            locked: false,
            createdAt: NOW,
            updatedAt: NOW,
            body: "# Title",
          },
        ],
        children: [
          {
            cardId: BoardCardId.make("child-a"),
            key: "T3O-51",
            title: "Pane",
            stage: BOARD_SEED_STAGE_IDS.done,
            archivedAt: null,
            sourcePlanId: boardPlanId(cardId, "a"),
          },
          {
            cardId: BoardCardId.make("child-b"),
            key: "T3O-52",
            title: "Title",
            stage: BOARD_SEED_STAGE_IDS.review,
            archivedAt: null,
            sourcePlanId: boardPlanId(cardId, "b"),
          },
        ],
        stepCompletions: [
          completion(String(BOARD_SEED_STAGE_IDS.building), null, "Integrated the children"),
        ],
      },
    );
    const planRows = deriveBoardPlanRows({
      plans: parent.plans,
      children: parent.children,
      cards: [
        makeBoardCardShell({
          cardId: BoardCardId.make("child-a"),
          key: "T3O-51",
          projectId: ProjectId.make("project-1"),
          labelIds: [],
          stage: BOARD_SEED_STAGE_IDS.done,
          orderKey: "m",
          title: "Pane",
          blocked: false,
          dependencyCount: 0,
          hasBrief: false,
          activeThreadId: null,
        }),
        makeBoardCardShell({
          cardId: BoardCardId.make("child-b"),
          key: "T3O-52",
          projectId: ProjectId.make("project-1"),
          labelIds: [],
          stage: BOARD_SEED_STAGE_IDS.review,
          orderKey: "n",
          title: "Title",
          blocked: false,
          dependencyCount: 0,
          hasBrief: false,
          activeThreadId: null,
        }),
      ],
      stages: BOARD_SEED_STAGES,
    });
    const summary = deriveBoardCardWorkSummary({
      detail: parent,
      stages: BOARD_SEED_STAGES,
      planRows,
    });
    expect(summary.build.empty).toBe(false);
    expect(summary.build.children?.done).toBe(1);
    expect(summary.build.children?.total).toBe(2);
    expect(summary.build.children?.rows.map((row) => row.key)).toEqual(["T3O-51", "T3O-52"]);
    expect(summary.build.summary).toBe("Integrated the children");
  });
});
