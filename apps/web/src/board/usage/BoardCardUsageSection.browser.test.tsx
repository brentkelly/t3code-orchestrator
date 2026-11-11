import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

import { useBoardUiStore } from "../boardUiStore";
import { BoardCardUsageSection } from "./BoardCardUsageSection";
import { deriveBoardUsageBreakdown } from "./boardUsageBreakdown";
import { usageRow } from "./boardUsageFixtures";

function setup() {
  useBoardUiStore.setState({ usageSectionOpen: false });
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
  it("opens from its total row, expands a stage into its rounds, and switches to By model", async () => {
    const breakdown = setup();
    await using screen = await render(<BoardCardUsageSection breakdown={breakdown} />);
    const header = screen.getByRole("button", { name: "Usage" });
    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByText("≈$1.75")).toBeVisible();

    await userEvent.click(header);
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    expect(useBoardUiStore.getState().usageSectionOpen).toBe(true);
    expect(screen.container.querySelectorAll("[data-usage-line]")).toHaveLength(0);

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
});
