import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

import { BoardCardUsageSection } from "./BoardCardUsageSection";
import { deriveBoardUsageBreakdown } from "./boardUsageBreakdown";
import { usageRow } from "./boardUsageFixtures";

function setup() {
  return deriveBoardUsageBreakdown({
    rows: [
      usageRow(),
      usageRow({ stepId: "review@1", threadId: ThreadId.make("t-r1"), costUsd: 0.5 }),
      usageRow({
        stepId: "review@2",
        threadId: ThreadId.make("t-r2"),
        provider: "codex",
        model: "gpt-5-codex",
        costUsd: 0.25,
        turnsOverride: 0,
        turnsListPriced: 1,
      }),
    ],
    historyPartial: false,
    stages: [
      { stageId: "building", label: "Building" },
      { stageId: "review", label: "Code review" },
    ],
    runningThreadId: null,
  });
}

describe("BoardCardUsageSection", () => {
  it("lists stages with cached input in the Input tooltip, drills into rounds, and switches to By model", async () => {
    const breakdown = setup();
    await using screen = await render(<BoardCardUsageSection breakdown={breakdown} />);
    const headings = Array.from(
      screen.container.querySelectorAll(".uppercase > span"),
      (cell) => cell.textContent,
    );
    expect(headings).toEqual(["Stage", "Models", "Input", "Output", "Cost"]);
    await expect.element(screen.getByText("Code review (2 rounds)")).toBeVisible();
    expect(screen.container.querySelectorAll("[data-usage-line]")).toHaveLength(0);

    await userEvent.hover(screen.getByText("3.6k"));
    await expect.element(screen.getByText("12.0k cached")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Code review/ }));
    await expect.element(screen.getByText("review@2")).toBeVisible();
    expect(
      Array.from(screen.container.querySelectorAll("[data-usage-line]")).map((line) =>
        line.getAttribute("data-usage-line"),
      ),
    ).toEqual(["review@1", "review@2"]);

    await userEvent.click(screen.getByRole("button", { name: "By model" }));
    await expect.element(screen.getByText("gpt-5-codex")).toBeVisible();
    expect(
      Array.from(screen.container.querySelectorAll("[data-usage-model]")).map((row) =>
        row.getAttribute("data-usage-model"),
      ),
    ).toEqual(["claude-sonnet", "gpt-5-codex"]);
  });

  it("counts a step with several causes once", async () => {
    const breakdown = deriveBoardUsageBreakdown({
      rows: [usageRow({ turnsOverride: 0, turnsNoUsage: 1, turnsUnpriced: 1, turnsPartial: 1 })],
      historyPartial: false,
      stages: [{ stageId: "building", label: "Building" }],
      runningThreadId: null,
    });
    await using screen = await render(<BoardCardUsageSection breakdown={breakdown} />);
    await expect.element(screen.getByText(/Partial total: 1 step isn't in/)).toBeVisible();
  });
});
