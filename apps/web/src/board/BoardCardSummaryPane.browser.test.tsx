import { BoardCardId, type BoardCardDecision } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import "../index.css";

import { BoardCardSummaryPane } from "./BoardCardSummaryPane";
import type { BoardCardWorkSummary } from "./boardCardWorkSummary";
import { BoardDecisionLog } from "./BoardDecisionLog";
import { boardDecisionLogView } from "./boardDecisionLog";
import { useBoardUiStore } from "./boardUiStore";
import { deriveBoardUsageBreakdown } from "./usage/boardUsageBreakdown";
import { usageRow } from "./usage/boardUsageFixtures";

const summary: BoardCardWorkSummary = {
  verdict: { label: "Ready for merge", tone: "attention" },
  review: {
    empty: true,
    currentRound: 0,
    maxRounds: 5,
    counts: { raised: 0, fixed: 0, rejected: 0, open: 0, disputed: 0, escalated: 0 },
    outstanding: [],
  },
  build: {
    empty: false,
    summary: "Built it",
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

const decision = (index: number): BoardCardDecision => ({
  decisionId: `d-${index}`,
  cardId: BoardCardId.make("card-1"),
  stepId: "planning",
  threadId: null,
  question: `Question ${index}?`,
  decision: `Decision ${index}`,
  reason: "Because.",
  flag: "unclear",
  decidedBy: "agent",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const usage = deriveBoardUsageBreakdown({
  rows: [usageRow()],
  historyPartial: false,
  stages: [{ stageId: "building", label: "Building" }],
  runningThreadId: null,
});

const noop = () => {};

function frame() {
  const container = document.createElement("div");
  container.style.display = "grid";
  container.style.height = "400px";
  container.style.width = "720px";
  return container;
}

describe("BoardCardSummaryPane", () => {
  it("keeps the Usage block at full height when a long decision log overflows the pane", async () => {
    useBoardUiStore.setState({ usageSectionOpen: false });
    const view = boardDecisionLogView({
      decisions: Array.from({ length: 40 }, (_, index) => decision(index)),
      autoPlanned: true,
      pastBuild: false,
    });
    await using screen = await render(
      <BoardCardSummaryPane
        decisionLog={
          view === null ? null : <BoardDecisionLog onOpenChange={noop} open view={view} />
        }
        onBackToThread={noop}
        onOpenPullRequest={noop}
        onSelectReview={noop}
        summary={summary}
        usage={usage}
      />,
      { container: frame() },
    );
    await expect.element(screen.getByText("Decision 39")).toBeInTheDocument();
    const block = screen.container.querySelector<HTMLElement>("[data-board-usage-section]");
    const header = block?.firstElementChild as HTMLElement | null | undefined;
    expect(block).not.toBeNull();
    expect(header).not.toBeNull();
    // Borders alone keep offsetHeight above zero, so compare against the header row.
    expect(block!.scrollHeight).toBeLessThanOrEqual(block!.offsetHeight + 1);
    expect(block!.offsetHeight).toBeGreaterThanOrEqual(header!.offsetHeight);
  });
});
