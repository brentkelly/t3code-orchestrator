import type { BoardBuildSummaryPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { BoardCardWorkSummary, BoardCardWorkSummaryVerdict } from "./boardCardWorkSummary";
import type { BoardDecisionLogView } from "./boardDecisionLog";
import { deriveBoardSummaryOverview } from "./boardSummaryOverview";
import { deriveBoardUsageBreakdown } from "./usage/boardUsageBreakdown";
import { usageRow } from "./usage/boardUsageFixtures";

const emptySummary: BoardCardWorkSummary = {
  verdict: { label: "In progress", tone: "muted" },
  review: {
    empty: true,
    currentRound: 0,
    maxRounds: 5,
    counts: { raised: 0, fixed: 0, rejected: 0, open: 0, disputed: 0, escalated: 0 },
    outstanding: [],
    loop: null,
  },
  build: {
    empty: true,
    summary: null,
    structured: null,
    changeCount: 0,
    areaCount: 0,
    children: null,
  },
  pullRequest: {
    empty: true,
    number: null,
    title: null,
    url: null,
    headBranch: null,
    baseRef: null,
    state: null,
  },
};

const usage = deriveBoardUsageBreakdown({
  rows: [usageRow()],
  historyPartial: false,
  stages: [{ stageId: "building", label: "Building" }],
  runningThreadId: null,
});

function built(structured: BoardBuildSummaryPayload): BoardCardWorkSummary {
  const areas = structured.areas.filter((area) => area.items.length > 0);
  return {
    ...emptySummary,
    build: {
      empty: false,
      summary: structured.lead,
      structured,
      changeCount: areas.reduce((total, area) => total + area.items.length, 0),
      areaCount: areas.length,
      children: null,
    },
  };
}

function reviewed(
  counts: Partial<BoardCardWorkSummary["review"]["counts"]>,
  loop: BoardCardWorkSummaryVerdict | null,
): BoardCardWorkSummary {
  return {
    ...emptySummary,
    review: {
      empty: false,
      currentRound: 2,
      maxRounds: 5,
      counts: {
        raised: 4,
        fixed: 3,
        rejected: 1,
        open: 0,
        disputed: 0,
        escalated: 0,
        ...counts,
      },
      outstanding: [],
      loop,
    },
  };
}

const overview = (
  summary: BoardCardWorkSummary,
  options: {
    readonly pastBuild?: boolean;
    readonly integrates?: boolean;
    readonly decisionLog?: BoardDecisionLogView | null;
    readonly usage?: typeof usage | null;
  } = {},
) =>
  deriveBoardSummaryOverview({
    summary,
    decisionLog: options.decisionLog ?? null,
    usage: options.usage === undefined ? usage : options.usage,
    pastBuild: options.pastBuild ?? false,
    integrates: options.integrates ?? true,
  });

const logView = (flags: ReadonlyArray<"normal" | "important" | "unclear">, autoPlanned: boolean) =>
  ({
    rows: flags.map((flag, index) => ({
      id: `d${index}`,
      question: `Q${index}`,
      decision: `D${index}`,
      reason: "",
      who: "Agent",
      flag,
    })),
    count: `${flags.length} decisions`,
    unclear: null,
    important: null,
    autoPlanned,
    defaultOpen: autoPlanned && flags.includes("unclear"),
    canAct: false,
  }) satisfies BoardDecisionLogView;

describe("deriveBoardSummaryOverview", () => {
  describe("which tiles show", () => {
    it("gives a planning card exactly one tile, Cost", () => {
      expect(overview(emptySummary).tiles.map((tile) => tile.label)).toEqual(["Cost"]);
    });

    it("keeps Cost as a muted empty slot when there is no usage", () => {
      const [cost] = overview(emptySummary, { usage: null }).tiles;
      expect(cost).toMatchObject({
        label: "Cost",
        value: "—",
        sub: "No usage yet",
        available: false,
      });
    });

    it("never gives an inherit group a Review tile", () => {
      const summary = reviewed({}, { label: "Review settled", tone: "success" });
      expect(
        overview(summary, { integrates: false }).tiles.map((tile) => tile.label),
      ).not.toContain("Review");
      expect(overview(summary).tiles.map((tile) => tile.label)).toContain("Review");
    });

    it("shows empty Checks and Heads-up text once the card is past Build", () => {
      const tiles = overview(emptySummary, { pastBuild: true }).tiles;
      expect(tiles.map((tile) => [tile.label, tile.value, tile.sub, tile.available])).toEqual([
        ["Checks", "—", "No checks reported", false],
        ["Heads-up", "—", "No build notes", false],
        ["Cost", expect.any(String), expect.any(String), true],
      ]);
      const finished = overview(built({ lead: "x", notes: [], checks: [], areas: [] }), {
        pastBuild: true,
      }).tiles.find((tile) => tile.label === "Heads-up");
      expect(finished).toMatchObject({ value: "0 notes", sub: "Nothing to flag", tone: "success" });
    });

    it("shows Review as round 1 on the review stage before any completion", () => {
      const summary: BoardCardWorkSummary = {
        ...emptySummary,
        review: { ...emptySummary.review, loop: { label: "Waiting to run", tone: "attention" } },
      };
      const review = overview(summary).tiles.find((tile) => tile.label === "Review");
      expect(review).toMatchObject({ value: "Round 1 of 5", tone: "attention" });
    });
  });

  describe("the Checks tile's wording", () => {
    const check = (status: "pass" | "fail" | "fail_preexisting" | "not_run") => ({
      status,
      name: status,
      detail: "",
    });
    it.each([
      [["pass", "pass"], "2 / 2 passed", "All clean", "success"],
      [["pass", "fail_preexisting"], "1 / 2 passed", "1 flagged, not from this card", "warning"],
      [["pass", "fail", "fail_preexisting"], "1 / 3 passed", "2 flagged", "warning"],
      [["pass", "not_run"], "1 / 2 passed", "1 skipped", "success"],
      [["not_run", "not_run"], "0 / 2 passed", "2 skipped", "none"],
      [
        ["fail_preexisting", "not_run"],
        "0 / 2 passed",
        "1 flagged, not from this card · 1 skipped",
        "warning",
      ],
    ] as const)("%j reads %s, %s", (statuses, value, sub, tone) => {
      const summary = built({ lead: "x", notes: [], checks: statuses.map(check), areas: [] });
      const tile = overview(summary).tiles.find((entry) => entry.label === "Checks");
      expect(tile).toMatchObject({ value, sub, tone });
    });
  });

  describe("the Review tile's tone is the loop chip's, never the counts'", () => {
    it.each([
      [{ label: "Review running", tone: "info" }, "info"],
      [{ label: "Waiting to run", tone: "attention" }, "attention"],
      [{ label: "Stuck", tone: "attention" }, "attention"],
      [{ label: "No convergence", tone: "warning" }, "warning"],
      [{ label: "Review stopped", tone: "warning" }, "warning"],
      [{ label: "Review paused", tone: "muted" }, "none"],
      [{ label: "Review advanced", tone: "muted" }, "none"],
      [{ label: "Review settled", tone: "success" }, "success"],
    ] as const)("%j", (loop, tone) => {
      // Counts that look settled must not turn a running loop green.
      const tile = overview(reviewed({}, loop)).tiles.find((entry) => entry.label === "Review");
      expect(tile?.tone).toBe(tone);
      expect(tile?.tooltip).toBe(loop.label);
    });

    it("falls back to the counts only once the loop is history", () => {
      const find = (summary: BoardCardWorkSummary) =>
        overview(summary).tiles.find((entry) => entry.label === "Review");
      expect(find(reviewed({}, null))?.tone).toBe("success");
      expect(find(reviewed({ open: 1, disputed: 1, escalated: 1 }, null))).toMatchObject({
        tone: "none",
        sub: "4 raised · 3 fixed · 1 rejected · 1 open · 1 disputed · 1 escalated",
      });
    });
  });

  it("names up to four areas on What was built and counts the rest as +N", () => {
    const summary = built({
      lead: "x",
      notes: [],
      checks: [],
      areas: ["Data", "API", "Panel", "Docs", "Tests", "Evals", "Empty"].map((name) => ({
        name,
        items: name === "Empty" ? [] : [`${name} item`],
      })),
    });
    const section = overview(summary).sections.find((entry) => entry.id === "built");
    expect(section?.count).toBe("6 changes · 6 areas");
    expect(section?.chips.map((chip) => chip.label)).toEqual([
      "Data",
      "API",
      "Panel",
      "Docs",
      "+2",
    ]);
  });

  it("sorts notes not done first and checks flagged, skipped, passed, stable within each", () => {
    const summary = built({
      lead: "x",
      notes: [
        { kind: "shortcut", text: "s1" },
        { kind: "plan_change", text: "p1" },
        { kind: "not_done", text: "n1" },
        { kind: "plan_change", text: "p2" },
        { kind: "not_done", text: "n2" },
      ],
      checks: [
        { status: "pass", name: "a", detail: "" },
        { status: "not_run", name: "b", detail: "" },
        { status: "fail_preexisting", name: "c", detail: "" },
        { status: "pass", name: "d", detail: "" },
        { status: "fail", name: "e", detail: "" },
      ],
      areas: [],
    });
    const result = overview(summary);
    expect(result.notes.map((note) => note.text)).toEqual(["n1", "n2", "p1", "p2", "s1"]);
    expect(result.checks.map((check) => check.name)).toEqual(["c", "e", "b", "a", "d"]);
    expect(result.notDone).toEqual(["n1", "n2"]);
    expect(result.sections.map((section) => section.id)).toEqual(["notes", "checks", "usage"]);
  });

  it("opens the decision log at mount only for an auto-planned card with unclear decisions", () => {
    expect(
      overview(emptySummary, { decisionLog: logView(["unclear", "important"], true) })
        .initiallyOpen,
    ).toEqual(["decisions"]);
    expect(
      overview(emptySummary, { decisionLog: logView(["unclear"], false) }).initiallyOpen,
    ).toEqual([]);
    expect(
      overview(emptySummary, { decisionLog: logView(["important"], true) }).initiallyOpen,
    ).toEqual([]);
    const section = overview(emptySummary, {
      decisionLog: logView(["unclear", "important", "important"], false),
    }).sections.find((entry) => entry.id === "decisions");
    expect(section?.chips).toEqual([
      { label: "2 important", tone: "neutral" },
      { label: "1 unclear", tone: "attention" },
    ]);
  });
});
