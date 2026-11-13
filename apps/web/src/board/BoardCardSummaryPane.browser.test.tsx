import {
  BoardCardId,
  type BoardBuildSummaryPayload,
  type BoardCardDecision,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";

import { BoardCardSummaryPane } from "./BoardCardSummaryPane";
import type { BoardCardWorkSummary } from "./boardCardWorkSummary";
import { boardDecisionLogView } from "./boardDecisionLog";
import { deriveBoardUsageBreakdown } from "./usage/boardUsageBreakdown";
import { usageRow } from "./usage/boardUsageFixtures";

const structured: BoardBuildSummaryPayload = {
  lead: "Wired the `BoardCardSummaryPane` overview",
  notes: [
    { kind: "plan_change", text: "Dropped the chip", detail: "Agreed in `planning`" },
    { kind: "not_done", text: "Mobile `half" },
    { kind: "shortcut", text: "Skipped the sweep" },
  ],
  checks: [
    { status: "pass", name: "`vitest`", detail: "" },
    { status: "fail_preexisting", name: "lint", detail: "1 error in `other.tsx`" },
    { status: "not_run", name: "evals", detail: "No key" },
  ],
  areas: [
    { name: "Data", items: ["Added `BoardSummaryOverview`", "Decoder"] },
    { name: "Panel", items: ["Pane"] },
  ],
};

const summary: BoardCardWorkSummary = {
  verdict: { label: "Ready for merge", tone: "attention" },
  review: {
    empty: false,
    currentRound: 2,
    maxRounds: 5,
    counts: { raised: 3, fixed: 2, rejected: 0, open: 1, disputed: 0, escalated: 0 },
    outstanding: [{ id: "f1", title: "Null deref" }],
    loop: { label: "Review settled", tone: "success" },
  },
  build: {
    empty: false,
    summary: "plain fallback",
    structured,
    changeCount: 3,
    areaCount: 2,
    children: null,
  },
  pullRequest: {
    empty: false,
    number: 110,
    title: "Summary tab",
    url: "https://example.test/pr/110",
    headBranch: "board/t3o-5",
    baseRef: "t3o",
    state: "open",
  },
};

const decision = (index: number, flag: BoardCardDecision["flag"]): BoardCardDecision => ({
  decisionId: `d-${index}`,
  cardId: BoardCardId.make("card-1"),
  stepId: "planning",
  threadId: null,
  question: `Question ${index}?`,
  decision: `Decision ${index}`,
  reason: "Because.",
  flag,
  decidedBy: "agent",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const logView = (autoPlanned: boolean, count = 3) =>
  boardDecisionLogView({
    decisions: Array.from({ length: count }, (_, index) =>
      decision(index, index === 0 ? "unclear" : "normal"),
    ),
    autoPlanned,
    pastBuild: true,
  });

const usage = deriveBoardUsageBreakdown({
  rows: [usageRow()],
  historyPartial: false,
  stages: [{ stageId: "building", label: "Building" }],
  runningThreadId: null,
});

const noop = () => {};

function frame(height: number) {
  const container = document.createElement("div");
  container.style.display = "grid";
  container.style.height = `${height}px`;
  container.style.width = "720px";
  return container;
}

type PaneProps = ComponentProps<typeof BoardCardSummaryPane>;

const pane = (props: Partial<PaneProps> = {}) => (
  <BoardCardSummaryPane
    decisionLog={logView(false)}
    onBackToThread={noop}
    onOpenPullRequest={noop}
    onSelectReview={noop}
    pastBuild
    summary={summary}
    usage={usage}
    {...props}
  />
);

const sectionRow = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLButtonElement>(`[data-summary-section="${id}"] > button`)!;

const openSections = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll('[data-summary-section] > button[aria-expanded="true"]'),
    (row) => row.parentElement?.getAttribute("data-summary-section"),
  );

describe("BoardCardSummaryPane", () => {
  it("keeps every section at full height when a long decision log overflows the pane", async () => {
    await using screen = await render(pane({ decisionLog: logView(false, 40) }), {
      container: frame(400),
    });
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await expect.element(screen.getByText("Decision 39")).toBeInTheDocument();
    await expect.element(screen.getByText("Card total")).toBeInTheDocument();
    for (const element of screen.container.querySelectorAll<HTMLElement>(
      "[data-summary-scroll] > *",
    )) {
      expect(element.scrollHeight).toBeLessThanOrEqual(element.offsetHeight + 1);
    }
    const block = screen.container.querySelector<HTMLElement>('[data-summary-section="usage"]')!;
    // Borders alone keep offsetHeight above zero, so compare against the row.
    expect(block.offsetHeight).toBeGreaterThan(sectionRow(screen.container, "usage").offsetHeight);
    await expect.element(screen.getByRole("button", { name: /^Cost: \$1\.00/ })).toBeVisible();
  });

  it("shows the lead, the verdict, the PR and its branches, with no commit count", async () => {
    const onOpenPullRequest = vi.fn();
    await using screen = await render(pane({ onOpenPullRequest }));
    const lead = screen.getByText(/^Wired the/);
    await expect.element(lead).toBeVisible();
    expect(lead.element().innerHTML).toMatch(/<code[^>]*>BoardCardSummaryPane<\/code> overview/);
    await expect.element(screen.getByText("plain fallback")).not.toBeInTheDocument();
    await expect.element(screen.getByText("t3o ← board/t3o-5")).toBeVisible();
    await expect.element(screen.getByText(/commit/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "#110" }));
    expect(onOpenPullRequest).toHaveBeenCalledWith("https://example.test/pr/110");
  });

  it("falls back to the plain summary, or says there is none", async () => {
    await using screen = await render(
      pane({ summary: { ...summary, build: { ...summary.build, structured: null } } }),
    );
    await expect.element(screen.getByText("plain fallback")).toBeVisible();
    await screen.rerender(
      pane({
        summary: {
          ...summary,
          build: { ...summary.build, empty: true, summary: null, structured: null },
        },
      }),
    );
    await expect.element(screen.getByText("No build summary")).toBeVisible();
  });

  it("opens every section closed unless an auto-planned log has unclear decisions", async () => {
    await using screen = await render(pane());
    await expect.element(screen.getByRole("button", { name: "Expand all" })).toBeVisible();
    expect(openSections(screen.container)).toEqual([]);
    expect(
      Array.from(screen.container.querySelectorAll("[data-summary-section]"), (section) =>
        section.getAttribute("data-summary-section"),
      ),
    ).toEqual(["notes", "checks", "built", "decisions", "usage"]);

    await using auto = await render(pane({ decisionLog: logView(true) }));
    await expect.element(auto.getByText("Decision 0")).toBeVisible();
    expect(openSections(auto.container)).toEqual(["decisions"]);
  });

  it("opens Usage at mount when the opener asks for it", async () => {
    await using screen = await render(pane({ initialOpen: ["usage"] }));
    await expect.element(screen.getByText("Card total")).toBeVisible();
    expect(openSections(screen.container)).toEqual(["usage"]);
  });

  it("opens a tile's section, focuses its row and scrolls it to the top of the pane", async () => {
    await using screen = await render(pane({ decisionLog: logView(false, 40) }), {
      container: frame(400),
    });
    await userEvent.click(screen.getByRole("button", { name: /^Cost: / }));
    const row = sectionRow(screen.container, "usage");
    await expect.element(row).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(row);
    const column = screen.container.querySelector<HTMLElement>("[data-summary-scroll]")!;
    const columnRect = column.getBoundingClientRect();
    const rowTop = row.getBoundingClientRect().top;
    expect(rowTop).toBeGreaterThanOrEqual(columnRect.top - 1);
    expect(rowTop).toBeLessThan(columnRect.bottom);

    await userEvent.click(screen.getByRole("button", { name: /^Review: / }));
    await expect
      .element(sectionRow(screen.container, "checks"))
      .toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("Review: round 2 of 5")).toBeVisible();
    await expect.element(screen.getByText("Not from this card")).toBeVisible();
  });

  it("names what wasn't done and opens Heads-up from Details", async () => {
    await using screen = await render(pane());
    const callout = screen.container.querySelector("[data-summary-not-done]");
    expect(callout?.textContent).toContain("1 thing wasn't done");
    // An unpaired backtick stays literal instead of opening a code chip.
    expect(callout?.textContent).toContain("Mobile `half");
    await userEvent.click(screen.getByRole("button", { name: "Details ›" }));
    await expect
      .element(sectionRow(screen.container, "notes"))
      .toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("Dropped the chip")).toBeVisible();

    await using clean = await render(
      pane({
        summary: {
          ...summary,
          build: {
            ...summary.build,
            structured: {
              ...structured,
              notes: structured.notes.filter((note) => note.kind !== "not_done"),
            },
          },
        },
      }),
    );
    await expect.element(clean.getByText("Dropped the chip").first()).not.toBeInTheDocument();
    expect(clean.container.querySelector("[data-summary-not-done]")).toBeNull();
  });

  it("expands and collapses every section from one toggle", async () => {
    await using screen = await render(pane());
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(openSections(screen.container)).toEqual([
      "notes",
      "checks",
      "built",
      "decisions",
      "usage",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(openSections(screen.container)).toEqual([]);
    await userEvent.click(sectionRow(screen.container, "built"));
    await expect.element(screen.getByRole("button", { name: "Collapse all" })).toBeVisible();
  });

  it("lists a split parent's child plans under What was built", async () => {
    const onOpenChild = vi.fn();
    await using screen = await render(
      pane({
        onOpenChild,
        summary: {
          ...summary,
          build: {
            ...summary.build,
            children: {
              done: 1,
              total: 2,
              rows: [
                { cardId: "child-a", key: "T3O-51", stageLabel: "Done", done: true },
                { cardId: "child-b", key: "T3O-52", stageLabel: "Code review", done: false },
              ],
            },
          },
        },
      }),
    );
    expect(sectionRow(screen.container, "built").textContent).toContain(
      "1 of 2 plans done · 3 changes · 2 areas",
    );
    await userEvent.click(sectionRow(screen.container, "built"));
    await userEvent.click(screen.getByRole("button", { name: /T3O-52/ }));
    expect(onOpenChild).toHaveBeenCalledWith("child-b");
  });

  it("opens the Review pane from an outstanding finding", async () => {
    const onSelectReview = vi.fn();
    await using screen = await render(pane({ onSelectReview, initialOpen: ["checks"] }));
    await userEvent.click(screen.getByRole("button", { name: /Null deref/ }));
    expect(onSelectReview).toHaveBeenCalled();
  });
});
