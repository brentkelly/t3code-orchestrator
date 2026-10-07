/**
 * The Summary pane (T3O-5), rendered to static markup from a derived recap —
 * the pane is a pure function of that recap plus the three click handlers.
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
    severities: { critical: 0, improvement: 0, nitpick: 0 },
    counts: { raised: 0, fixed: 0, rejected: 0, open: 0, disputed: 0 },
    outstanding: [],
  },
  build: { empty: true, summary: null, children: null },
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

const noop = () => {};

describe("BoardCardSummaryPane", () => {
  it("always renders the four blocks, with the locked empty copy", () => {
    const html = renderToStaticMarkup(
      <BoardCardSummaryPane
        onBackToThread={noop}
        onOpenPullRequest={noop}
        onSelectReview={noop}
        summary={empty}
        threadLocked={false}
      />,
    );
    expect(html).toContain(">Summary</h3>");
    expect(html).toContain("Verdict");
    expect(html).toContain("Review not started");
    expect(html).toContain("No review summary");
    expect(html).toContain("No build summary");
    expect(html).toContain("No PR");
    expect(html).toContain("Back to thread");
  });

  it("omits Back to thread when the thread is locked", () => {
    const html = renderToStaticMarkup(
      <BoardCardSummaryPane
        onBackToThread={noop}
        onOpenPullRequest={noop}
        onSelectReview={noop}
        summary={empty}
        threadLocked
      />,
    );
    expect(html).not.toContain("Back to thread");
  });

  it("shows review counts, outstanding titles, build summary, and PR identity", () => {
    const html = renderToStaticMarkup(
      <BoardCardSummaryPane
        onBackToThread={noop}
        onOpenChild={noop}
        onOpenPullRequest={noop}
        onSelectReview={noop}
        summary={{
          verdict: { label: "Review running", tone: "info" },
          review: {
            empty: false,
            currentRound: 1,
            maxRounds: 5,
            severities: { critical: 1, improvement: 0, nitpick: 0 },
            counts: { raised: 1, fixed: 0, rejected: 0, open: 1, disputed: 0 },
            outstanding: [{ id: "f1", title: "Null deref" }],
          },
          build: { empty: false, summary: "Wired the pane", children: null },
          pullRequest: {
            empty: false,
            number: 110,
            title: "Summary tab",
            url: "https://example.test/pr/110",
            headBranch: "board/t3o-5",
            baseRef: "t3o",
            state: "open",
          },
        }}
        threadLocked={false}
      />,
    );
    expect(html).toContain("Review running");
    expect(html).toContain("Round 1 of 5");
    expect(html).toContain("1 / 0 / 0");
    expect(html).toContain("Null deref");
    expect(html).toContain("Wired the pane");
    expect(html).toContain("#110");
    expect(html).toContain("Summary tab");
    expect(html).toContain("t3o ← board/t3o-5");
  });

  it("renders split-parent child rows and a parent build summary under them", () => {
    const html = renderToStaticMarkup(
      <BoardCardSummaryPane
        onBackToThread={noop}
        onOpenChild={noop}
        onOpenPullRequest={noop}
        onSelectReview={noop}
        summary={{
          ...empty,
          verdict: { label: "Review running", tone: "info" },
          build: {
            empty: false,
            summary: "Integrated the children",
            children: {
              done: 1,
              total: 2,
              rows: [
                {
                  cardId: "child-a",
                  key: "T3O-51",
                  stageLabel: "Done",
                  done: true,
                },
                {
                  cardId: "child-b",
                  key: "T3O-52",
                  stageLabel: "Code review",
                  done: false,
                },
              ],
            },
          },
        }}
        threadLocked={false}
      />,
    );
    expect(html).toContain("1 of 2 plans done");
    expect(html).toContain("T3O-51");
    expect(html).toContain("T3O-52");
    expect(html).toContain("Integrated the children");
  });

  it("shows a PR number with no title when the stored link predates the field", () => {
    const html = renderToStaticMarkup(
      <BoardCardSummaryPane
        onBackToThread={noop}
        onOpenPullRequest={noop}
        onSelectReview={noop}
        summary={{
          ...empty,
          verdict: { label: "Merged", tone: "success" },
          pullRequest: {
            empty: false,
            number: 110,
            title: null,
            url: "https://example.test/pr/110",
            headBranch: "board/t3o-5",
            baseRef: "t3o",
            state: "merged",
          },
        }}
        threadLocked={false}
      />,
    );
    expect(html).toContain("#110");
    expect(html).not.toContain("No PR");
  });
});
