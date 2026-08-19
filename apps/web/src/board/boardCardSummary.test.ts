/**
 * T3o stage-specific card summary (t3o-06). Pure logic, no DOM: each stage
 * renders its documented variant from `BoardCardShell` fields ALONE (D7), and
 * a field with no data source yet contributes nothing (no-speculative-
 * inventory) — the variant degrades to the base card, never to empty slots.
 */
import {
  BoardCardId,
  BoardStageId,
  ProjectId,
  makeBoardCardShell,
  type BoardCardShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardCardSummary } from "./boardCardSummary";

/** A shell as `makeBoardCardShell` produces it: every not-yet-sourced review /
    plan field ABSENT, exactly what rides the wire today. Overrides let a test
    simulate the day a later spec populates one. */
function shell(stage: string, overrides?: Partial<BoardCardShell>): BoardCardShell {
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make("card-1"),
      key: "T3-1",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BoardStageId.make(stage),
      orderKey: "m",
      title: "A card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...overrides,
  };
}

describe("boardCardSummary", () => {
  it("adds nothing beyond the base card at Backlog, Sprint and Planning", () => {
    for (const stage of ["backlog", "sprint", "planning"] as const) {
      const summary = boardCardSummary(shell(stage));
      expect(summary.items).toEqual([]);
      expect(summary.muted).toBe(false);
    }
  });

  it("mutes a Done card and adds no summary items", () => {
    const summary = boardCardSummary(shell("done"));
    expect(summary.muted).toBe(true);
    expect(summary.items).toEqual([]);
  });

  it("degrades every data-bearing stage to the base card when the shell carries no data", () => {
    // This is the no-speculative-inventory contract: with the fields absent
    // (their state on the wire today), no stage renders a skeleton of empty
    // slots. Each stage's summary is empty.
    for (const stage of ["ready", "building", "review", "merge"] as const) {
      expect(boardCardSummary(shell(stage)).items).toEqual([]);
    }
  });

  it("shows an attachment count on a Ready card only when there is one", () => {
    expect(boardCardSummary(shell("ready", { attachmentCount: 0 })).items).toEqual([]);
    expect(boardCardSummary(shell("ready", { attachmentCount: 3 })).items).toEqual([
      { kind: "attachments", count: 3 },
    ]);
  });

  it("shows plan progress on a Building parent card", () => {
    expect(boardCardSummary(shell("building", { planTotal: 6, planDone: 2 })).items).toEqual([
      { kind: "plans", done: 2, total: 6 },
    ]);
    // Not a parent (no planTotal): degrade to base.
    expect(boardCardSummary(shell("building")).items).toEqual([]);
  });

  it("renders the full review summary in order when the pipeline populates it", () => {
    const summary = boardCardSummary(
      shell("review", {
        prNumber: 42,
        roundCurrent: 3,
        roundMax: 5,
        stepLabel: "TRIAGING",
        severityCritical: 1,
        severityImprovement: 2,
        severityNitpick: 1,
        issuesFixed: 7,
        issuesRejected: 4,
        issuesOpen: 1,
        issuesDisputed: 1,
      }),
    );
    expect(summary.items.map((item) => item.kind)).toEqual([
      "pr",
      "round",
      "step",
      "severity",
      "issues",
    ]);
    expect(summary.items).toContainEqual({
      kind: "severity",
      critical: 1,
      improvement: 2,
      nitpick: 1,
    });
  });

  it("shows a zeroed severity triple as soon as any severity field is present", () => {
    // A present-but-zero count is real data (0 criticals is meaningful); only
    // an ABSENT field is "no data". One present field surfaces the triple.
    const summary = boardCardSummary(shell("review", { severityCritical: 0 }));
    expect(summary.items).toContainEqual({
      kind: "severity",
      critical: 0,
      improvement: 0,
      nitpick: 0,
    });
  });

  it("shows a PR reference on a Ready-for-merge card when detection lands", () => {
    expect(boardCardSummary(shell("merge", { prNumber: 128 })).items).toEqual([
      { kind: "pr", number: 128 },
    ]);
  });
});
