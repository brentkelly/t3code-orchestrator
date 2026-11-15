import { BoardPlanId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_SPLIT_DOCK_DEFAULT,
  boardSplitApprovalLostFromActivity,
  boardSplitDockApprovedBar,
  boardSplitDockChoice,
  boardSplitDockExpanded,
  boardSplitDockFooter,
  boardSplitDockHeight,
  boardSplitDockSummary,
  type BoardSplitDockInput,
} from "./boardSplitDock";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

const plan = (key: string, ordinal: number, revisedInRound?: number) => ({
  planId: BoardPlanId.make(`card::${key}`),
  title: `Plan ${key}`,
  dependsOn: [],
  ordinal,
  ...(revisedInRound === undefined ? {} : { revisedInRound }),
});

const input = (overrides: Partial<BoardSplitDockInput> = {}): BoardSplitDockInput => ({
  plans: [plan("a", 0, 1), plan("b", 1)],
  review: { startedAt: NOW, rounds: 3, round: 2 },
  stepStatus: "running",
  pendingApproval: null,
  approvalLost: null,
  ...overrides,
});

const done = input({ review: { startedAt: NOW, rounds: 3, round: 3, doneAt: LATER } });

describe("boardSplitDockExpanded", () => {
  it("collapses while a review runs and opens otherwise", () => {
    expect(boardSplitDockExpanded(input(), BOARD_SPLIT_DOCK_DEFAULT)).toBe(false);
    expect(boardSplitDockExpanded(done, BOARD_SPLIT_DOCK_DEFAULT)).toBe(true);
    expect(boardSplitDockExpanded(input({ review: null }), BOARD_SPLIT_DOCK_DEFAULT)).toBe(true);
  });

  it("keeps the viewer's choice through the end of the same review", () => {
    const opened = boardSplitDockChoice(input(), BOARD_SPLIT_DOCK_DEFAULT, true);
    expect(boardSplitDockExpanded(input(), opened)).toBe(true);
    const collapsed = boardSplitDockChoice(input(), BOARD_SPLIT_DOCK_DEFAULT, false);
    // Collapsed during the review: it stays collapsed when the review finishes.
    expect(boardSplitDockExpanded(done, collapsed)).toBe(false);
  });

  it("ignores a choice made under an older review or another split", () => {
    const opened = boardSplitDockChoice(input(), BOARD_SPLIT_DOCK_DEFAULT, true);
    expect(boardSplitDockExpanded(input({ review: { startedAt: LATER, rounds: 3 } }), opened)).toBe(
      false,
    );
    const collapsed = boardSplitDockChoice(done, BOARD_SPLIT_DOCK_DEFAULT, false);
    expect(
      boardSplitDockExpanded({ ...done, plans: [...done.plans, plan("c", 2)] }, collapsed),
    ).toBe(true);
  });

  it("reopens during a review when an approval was dropped", () => {
    const lost = input({ approvalLost: { change: "dropped", round: 2, detail: null } });
    expect(boardSplitDockExpanded(lost, BOARD_SPLIT_DOCK_DEFAULT)).toBe(true);
  });
});

describe("boardSplitDockHeight", () => {
  it("clamps a stored height to 120px and 45% of the column", () => {
    expect(boardSplitDockHeight({ stored: 50, columnHeight: 1000 })).toEqual({
      height: 120,
      max: 450,
    });
    expect(boardSplitDockHeight({ stored: 900, columnHeight: 1000 }).height).toBe(450);
    expect(boardSplitDockHeight({ stored: null, columnHeight: 1000 })).toEqual({
      height: null,
      max: 450,
    });
    // A short column never caps the dock below its minimum.
    expect(boardSplitDockHeight({ stored: null, columnHeight: 200 }).max).toBe(120);
  });
});

describe("boardSplitDockFooter", () => {
  it("offers only Approve after review while a review runs", () => {
    const footer = boardSplitDockFooter(input());
    expect(footer).toMatchObject({
      kind: "choice",
      lead: "Plan review · round 2 of 3. Later rounds can still change the cards.",
      afterReview: { label: "Approve after review" },
      now: null,
    });
    if (footer.kind === "choice") expect(footer.afterReview.note).toContain("target: 3 rounds");
  });

  it("offers both while planning is parked, and the direct approve otherwise", () => {
    expect(boardSplitDockFooter(input({ stepStatus: "awaiting-input" }))).toMatchObject({
      kind: "choice",
      now: { note: "Ends the review: the plans freeze now." },
    });
    expect(boardSplitDockFooter(done)).toEqual({ kind: "direct" });
    expect(boardSplitDockFooter(input({ stepStatus: null }))).toEqual({ kind: "direct" });
  });
});

describe("dock copy", () => {
  it("counts revised plans in the collapsed row", () => {
    expect(boardSplitDockSummary(input())).toBe(
      "Proposed split · 2 cards · 1 revised · Needs approval",
    );
  });

  it("words the approved bar for a running review and for none", () => {
    const pendingApproval = {
      autoBuild: true,
      mergeTarget: "own" as const,
      fingerprint: "[]",
      approvedAt: NOW,
    };
    expect(boardSplitDockApprovedBar(input({ pendingApproval }))).toBe(
      "Split approved · 2 cards created after review · round 2 now",
    );
    expect(boardSplitDockApprovedBar(input({ pendingApproval, stepStatus: null }))).toBe(
      "Split approved · cards are created when planning completes",
    );
  });

  it("reads a lost approval off the rail until a later approval or move", () => {
    const dropped = {
      kind: "split-approval",
      payload: { splitApproval: "dropped" as const, planReviewRound: 3 },
    };
    expect(boardSplitApprovalLostFromActivity([dropped])).toEqual({
      change: "dropped",
      round: 3,
      detail: null,
    });
    expect(
      boardSplitApprovalLostFromActivity([
        dropped,
        { kind: "split-approval", payload: { splitApproval: "approved" } },
      ]),
    ).toBeNull();
    expect(boardSplitApprovalLostFromActivity([dropped, { kind: "card-moved", payload: {} }])).toBe(
      null,
    );
  });
});
