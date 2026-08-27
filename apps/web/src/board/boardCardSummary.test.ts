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

import { boardCardMeta, boardCardSummary } from "./boardCardSummary";

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

  it("settles the review outcome against stepRunning, not the wire value (t3o-22)", () => {
    // The shell carries the outcome UNRESOLVED so the snapshot and the
    // `card-review` delta say the same thing. `running` on the wire means "the
    // ledger's rounds are accounted for", not "the loop is still going".
    const held = {
      roundCurrent: 5,
      roundMax: 5,
      reviewOutcome: "running" as const,
      reviewHeldOutcome: "round-cap" as const,
      reviewRoundComplete: true,
    };
    const roundItem = (overrides: Record<string, unknown>) =>
      boardCardSummary(shell("review", { ...held, ...overrides })).items.find(
        (item) => item.kind === "round",
      );

    // Nothing running and no half-run round behind it: the loop stopped.
    expect(roundItem({ stepRunning: false })).toMatchObject({ outcome: "round-cap" });
    // The executor is driving it — still running, whatever the counts say.
    expect(roundItem({ stepRunning: true })).toMatchObject({ outcome: "running" });
    // Queued for a concurrency slot is a loop that is going, not one that
    // stopped — flagging it NO CONVERGENCE is a false alarm on a healthy card.
    expect(roundItem({ stepRunning: false, queued: true })).toMatchObject({ outcome: "running" });
    // A half-run round with nothing admitted yet is the gap between phases,
    // NOT a stopped loop. Reading it as one is the false NO CONVERGENCE this
    // guard exists to prevent.
    expect(roundItem({ stepRunning: false, reviewRoundComplete: false })).toMatchObject({
      outcome: "running",
    });
    // With no budget in hand the row reports the round reached and no total.
    const noBudget = boardCardSummary(
      shell("review", { ...held, roundMax: undefined, stepRunning: false }),
    ).items.find((item) => item.kind === "round");
    expect(noBudget).toMatchObject({ current: 5, max: undefined, outcome: "round-cap" });

    // A decided outcome is never second-guessed.
    expect(roundItem({ stepRunning: false, reviewOutcome: "converged" })).toMatchObject({
      outcome: "converged",
    });
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
    // No "pr": the PR reference is stage-independent now and rides the meta
    // row (`boardCardMeta`) rather than the review stage's summary.
    expect(summary.items.map((item) => item.kind)).toEqual(["round", "step", "severity", "issues"]);
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

  it("keeps the PR reference out of every stage summary", () => {
    // It belongs to the card, not to the column it happens to be sitting in.
    for (const stage of ["review", "merge", "done"] as const) {
      expect(boardCardSummary(shell(stage, { prNumber: 128 })).items).not.toContainEqual(
        expect.objectContaining({ kind: "pr" }),
      );
    }
  });
});

describe("boardCardMeta", () => {
  it("is empty on a card that is tied to nothing, so the row adds no height", () => {
    expect(boardCardMeta(shell("backlog"), 0).empty).toBe(true);
  });

  it("reads every indicator off the shell, plus the client-joined thread count", () => {
    const meta = boardCardMeta(
      shell("review", { dependencyCount: 2, planCount: 3, prNumber: 88, briefHasImage: true }),
      1,
    );
    expect(meta).toEqual({
      dependencyCount: 2,
      threadCount: 1,
      planCount: 3,
      prNumber: 88,
      briefHasImage: true,
      empty: false,
    });
  });

  it("is stage-independent — a Backlog card shows the same counts as a Review one", () => {
    const fields = { dependencyCount: 2, planCount: 3, prNumber: 88, briefHasImage: true };
    expect(boardCardMeta(shell("backlog", fields), 1)).toEqual(
      boardCardMeta(shell("review", fields), 1),
    );
  });

  it("prefers a sub-board's stacked plan cards over the card's own plan documents", () => {
    // `planTotal` is the parent's count of children (D12); `planCount` is the
    // card's own attached plans (t3o-08). A parent counts its children.
    expect(boardCardMeta(shell("building", { planCount: 1, planTotal: 6 }), 0).planCount).toBe(6);
    expect(boardCardMeta(shell("planning", { planCount: 1 }), 0).planCount).toBe(1);
  });

  it("treats an absent or zero field as nothing to show", () => {
    // The not-yet-sourced shell fields (`prNumber` until PR detection lands)
    // must not render a `#0` or an empty icon — no-speculative-inventory.
    const meta = boardCardMeta(shell("merge", { prNumber: 0 }), 0);
    expect(meta.prNumber).toBeUndefined();
    expect(meta.planCount).toBe(0);
    expect(meta.briefHasImage).toBe(false);
    expect(meta.empty).toBe(true);
  });
});
