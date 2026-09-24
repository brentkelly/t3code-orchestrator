import { BoardCardId, BoardStageId, ProjectId, type BoardCard } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardCardPublishIsRunning, boardCardPublishNeedsYou } from "@t3tools/contracts";

import {
  lastPublishedShaForProject,
  publishAttempt,
  publishSkipBecauseAlreadyLive,
  shouldPublishAfterRefresh,
} from "./publishOnDone.ts";

const PROJECT = ProjectId.make("project-1");
const OTHER = ProjectId.make("project-2");
const DONE = BoardStageId.make("done");
const MERGE = BoardStageId.make("merge");

const lifecycleOn = {
  reclaimWorktreeOnDone: true,
  publishOnDone: true,
  publishProjectIds: [PROJECT],
};

const mergedPr = {
  number: 12,
  url: "https://example.test/pr/12",
  state: "merged" as const,
  headBranch: "board/card-1",
  baseRef: "main",
  checkedAt: "2026-01-01T00:00:00.000Z",
};

const card = (overrides: Partial<BoardCard> = {}): BoardCard =>
  ({
    id: BoardCardId.make("card-1"),
    key: "EVE-1",
    cardNumber: 1,
    projectId: PROJECT,
    labels: [],
    stage: DONE,
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    worktree: null,
    pullRequest: mergedPr,
    pullRequestHistory: [],
    pullRequestFloor: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoStart: false,
    autoMerge: false,
    autoMergeHold: null,
    publish: null,
    blocked: false,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as BoardCard;

const gate = (overrides: Partial<Parameters<typeof shouldPublishAfterRefresh>[0]> = {}) =>
  shouldPublishAfterRefresh({
    lifecycle: lifecycleOn,
    card: card(),
    previousStage: MERGE,
    previousMerged: true,
    isDone: true,
    force: false,
    ...overrides,
  });

describe("shouldPublishAfterRefresh", () => {
  it("fires when a merged card arrives in Done", () => {
    expect(gate()).toBe(true);
  });

  it("is silent when the master switch is off", () => {
    expect(
      gate({
        lifecycle: { ...lifecycleOn, publishOnDone: false },
      }),
    ).toBe(false);
  });

  it("is silent when the project is not on the allow-list", () => {
    expect(
      gate({
        lifecycle: { ...lifecycleOn, publishProjectIds: [OTHER] },
      }),
    ).toBe(false);
  });

  it("is silent when opening an already-qualified Done card", () => {
    expect(
      gate({
        previousStage: DONE,
        previousMerged: true,
      }),
    ).toBe(false);
  });

  it("fires when a Done card's pull request newly becomes merged", () => {
    expect(
      gate({
        previousStage: DONE,
        previousMerged: false,
      }),
    ).toBe(true);
  });

  it("is silent without a merged pull request", () => {
    expect(gate({ card: card({ pullRequest: null }) })).toBe(false);
  });

  it("is silent for an archived card", () => {
    expect(gate({ card: card({ archivedAt: "2026-01-02T00:00:00.000Z" }) })).toBe(false);
  });

  it("is silent when this round already attempted", () => {
    expect(
      gate({
        card: card({
          publish: {
            round: 0,
            status: "failed",
            sha: null,
            detail: "build failed",
          },
        }),
      }),
    ).toBe(false);
  });

  it("force retries even when this round already attempted", () => {
    expect(
      gate({
        force: true,
        card: card({
          publish: {
            round: 0,
            status: "failed",
            sha: null,
            detail: "build failed",
          },
        }),
      }),
    ).toBe(true);
  });
});

describe("lastPublishedShaForProject", () => {
  it("returns the succeeded SHA for that project", () => {
    const cards = [
      card({
        publish: { round: 0, status: "succeeded", sha: "aaa", detail: null },
      }),
      card({
        id: BoardCardId.make("card-2"),
        projectId: OTHER,
        publish: { round: 0, status: "succeeded", sha: "bbb", detail: null },
      }),
    ];
    expect(lastPublishedShaForProject(cards, PROJECT)).toBe("aaa");
    expect(lastPublishedShaForProject(cards, OTHER)).toBe("bbb");
  });
});

describe("publishSkipBecauseAlreadyLive", () => {
  it("skips a SHA the project already published", () => {
    expect(publishSkipBecauseAlreadyLive("aaa", "aaa")).toBe(true);
    expect(publishSkipBecauseAlreadyLive("aaa", "bbb")).toBe(false);
    expect(publishSkipBecauseAlreadyLive("aaa", null)).toBe(false);
  });
});

describe("boardCardPublish pills", () => {
  it("Retry is failed only, Publishing is running only", () => {
    expect(boardCardPublishNeedsYou({ round: 0, status: "failed", sha: null, detail: "x" })).toBe(
      true,
    );
    expect(boardCardPublishNeedsYou({ round: 0, status: "running", sha: null, detail: "x" })).toBe(
      false,
    );
    expect(boardCardPublishIsRunning({ round: 0, status: "running", sha: null, detail: "x" })).toBe(
      true,
    );
    expect(boardCardPublishIsRunning({ round: 0, status: "failed", sha: null, detail: "x" })).toBe(
      false,
    );
  });
});

describe("publishAttempt", () => {
  it("stamps the current round", () => {
    expect(publishAttempt({ card: card(), status: "succeeded", sha: "abc", detail: null })).toEqual(
      {
        round: 0,
        status: "succeeded",
        sha: "abc",
        detail: null,
      },
    );
  });
});
