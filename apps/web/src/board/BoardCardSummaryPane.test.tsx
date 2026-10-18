/**
 * The Summary pane (T3O-5, T3O-21), rendered to static markup from a derived
 * recap — the pane is a pure function of that recap plus its click handlers,
 * so these pin which sections a given recap shows.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardCardSummaryPane } from "./BoardCardSummaryPane";
import type { BoardCardWorkSummary } from "./boardCardWorkSummary";

const empty: BoardCardWorkSummary = {
  verdict: { label: "Review not started", tone: "muted" },
  review: {
    empty: true,
    currentRound: 0,
    maxRounds: 5,
    counts: { raised: 0, fixed: 0, rejected: 0, open: 0, disputed: 0 },
    outstanding: [],
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

const pullRequest: BoardCardWorkSummary["pullRequest"] = {
  empty: false,
  number: 110,
  title: "Summary tab",
  url: "https://example.test/pr/110",
  headBranch: "board/t3o-5",
  baseRef: "t3o",
  state: "open",
};

const noop = () => {};

const render = (summary: BoardCardWorkSummary) =>
  renderToStaticMarkup(
    <BoardCardSummaryPane
      onBackToThread={noop}
      onOpenChild={noop}
      onOpenPullRequest={noop}
      onSelectReview={noop}
      summary={summary}
    />,
  );

describe("BoardCardSummaryPane", () => {
  it("shows only the header line when nothing has run", () => {
    const html = render(empty);
    expect(html).toContain("Build summary");
    expect(html).toContain("Back to thread");
    expect(html).toContain("Review not started");
    expect(html).toContain("No build summary");
    for (const section of [
      "Heads-up",
      "Open findings",
      "Checks",
      "What was built",
      "Review round",
    ]) {
      expect(html).not.toContain(section);
    }
  });

  it("folds review counts and PR identity into the one header line", () => {
    const html = render({
      ...empty,
      verdict: { label: "Review running", tone: "info" },
      review: {
        empty: false,
        currentRound: 1,
        maxRounds: 5,
        counts: { raised: 3, fixed: 1, rejected: 1, open: 1, disputed: 0 },
        outstanding: [{ id: "f1", title: "Null deref" }],
      },
      pullRequest,
    });
    expect(html).toContain("Review round 1 of 5");
    expect(html).toContain("3 raised · 1 fixed · 1 rejected · 1 open");
    expect(html).not.toContain("disputed");
    expect(html).toContain("#110");
    expect(html).toContain("t3o ← board/t3o-5");
    expect(html).toContain("Open findings");
    expect(html).toContain("Null deref");
  });

  it("falls back to the plain summary as the lead, with no structured sections", () => {
    const html = render({
      ...empty,
      build: { ...empty.build, empty: false, summary: "Wired the pane" },
    });
    expect(html).toContain("Wired the pane");
    expect(html).not.toContain("No build summary");
    for (const section of ["Heads-up", "Checks", "What was built"]) {
      expect(html).not.toContain(section);
    }
  });

  it("renders the structured payload: lead, notes, checks and areas", () => {
    const html = render({
      ...empty,
      build: {
        empty: false,
        summary: "plain fallback",
        structured: {
          lead: "Built on `board/t3o-21`, 4 commits, pushed.",
          notes: [
            { kind: "plan_change", text: "Dropped the chip", detail: "Agreed in `planning`" },
            { kind: "not_done", text: "Mobile `half" },
            { kind: "shortcut", text: "Skipped the sweep" },
          ],
          checks: [
            { status: "fail", name: "lint", detail: "1 error in `pane.tsx`" },
            { status: "pass", name: "`vitest`", detail: "" },
          ],
          areas: [
            { name: "Data", items: ["Added `BoardBuildSummaryPayload`", "Decoder"] },
            { name: "Panel", items: ["Pane"] },
          ],
        },
        changeCount: 3,
        areaCount: 2,
        children: null,
      },
    });
    // The structured lead wins over the plain summary.
    expect(html).not.toContain("plain fallback");
    expect(html).toMatch(/Built on <code[^>]*>board\/t3o-21<\/code>, 4 commits, pushed\./);
    expect(html).toContain("Heads-up");
    for (const tag of ["Plan change", "Not done", "Shortcut"]) expect(html).toContain(tag);
    // Details go through the inline-code renderer too.
    expect(html).toMatch(/Agreed in <code[^>]*>planning<\/code>/);
    // An unpaired backtick stays literal instead of opening a code chip.
    expect(html).toContain("Mobile `half");
    expect(html).toContain("Checks");
    expect(html).toMatch(/1 error in <code[^>]*>pane\.tsx<\/code>/);
    expect(html).toContain("3 changes across 2 areas");
    expect(html).toMatch(/Added <code[^>]*>BoardBuildSummaryPayload<\/code>/);
  });

  it("hides Heads-up when there are no notes, and Checks when there are none", () => {
    const html = render({
      ...empty,
      build: {
        empty: false,
        summary: "Built it",
        structured: {
          lead: "Built it",
          notes: [],
          checks: [],
          areas: [{ name: "Docs", items: ["One line"] }],
        },
        changeCount: 1,
        areaCount: 1,
        children: null,
      },
    });
    expect(html).not.toContain("Heads-up");
    expect(html).not.toContain("Checks");
    expect(html).toContain("1 change across 1 area");
  });

  it("puts a split parent's child plans under What was built", () => {
    const html = render({
      ...empty,
      build: {
        ...empty.build,
        empty: false,
        summary: "Integrated the children",
        children: {
          done: 1,
          total: 2,
          rows: [
            { cardId: "child-a", key: "T3O-51", stageLabel: "Done", done: true },
            { cardId: "child-b", key: "T3O-52", stageLabel: "Code review", done: false },
          ],
        },
      },
    });
    expect(html).toContain("What was built");
    expect(html).toContain("1 of 2 plans done");
    expect(html).toContain("T3O-51");
    expect(html).toContain("T3O-52");
    expect(html).toContain("Integrated the children");
  });
});
