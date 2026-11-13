import { BoardCardId, type BoardCardDecision } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";

import { BoardDecisionLog } from "./BoardDecisionLog";
import { boardDecisionLogView } from "./boardDecisionLog";

const decision = (
  question: string,
  flag: BoardCardDecision["flag"],
  decidedBy: BoardCardDecision["decidedBy"] = "agent",
): BoardCardDecision => ({
  decisionId: `d-${question}`,
  cardId: BoardCardId.make("card-1"),
  stepId: "planning",
  threadId: null,
  question,
  decision: `Decided: ${question}`,
  reason: "Because.",
  flag,
  decidedBy,
  createdAt: "2026-01-01T00:00:00.000Z",
});

// Recorded out of reading order on purpose.
const decisions = [
  decision("Where does it live?", "normal", "human"),
  decision("Split the card?", "important"),
  decision("Ship behind a flag?", "unclear"),
  decision("Name the table?", "normal"),
];

function Log({
  autoPlanned,
  entries = decisions,
}: {
  readonly autoPlanned: boolean;
  readonly entries?: ReadonlyArray<BoardCardDecision>;
}) {
  const view = boardDecisionLogView({ decisions: entries, autoPlanned, pastBuild: false });
  return view === null ? null : <BoardDecisionLog view={view} />;
}

const flags = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("li[data-flag]"), (row) => row.getAttribute("data-flag"));

describe("BoardDecisionLog", () => {
  it("numbers the decisions unclear first, with who decided each", async () => {
    await using screen = await render(<Log autoPlanned />, { router: false });
    await expect.element(screen.getByText("Decided: Ship behind a flag?")).toBeVisible();
    expect(flags(screen.container)).toEqual(["unclear", "important", "normal", "normal"]);
    expect(
      Array.from(screen.container.querySelectorAll("li[data-flag]"), (row) => row.textContent),
    ).toEqual([
      expect.stringMatching(/^1Ship behind a flag\?.*Unclear/),
      expect.stringMatching(/^2Split the card\?.*Important/),
      expect.stringMatching(/^3Where does it live\?.*You$/),
      expect.stringMatching(/^4Name the table\?.*Agent$/),
    ]);
    await expect.element(screen.getByText(/^Auto-planned\./)).toBeVisible();
  });

  it("filters to important or unclear and keeps each row's number", async () => {
    await using screen = await render(<Log autoPlanned={false} />, { router: false });
    const unclear = screen.getByRole("button", { name: "Unclear 1" });
    await userEvent.click(unclear);
    await expect.element(unclear).toHaveAttribute("aria-pressed", "true");
    expect(flags(screen.container)).toEqual(["unclear"]);

    await userEvent.click(screen.getByRole("button", { name: "Important 1" }));
    expect(flags(screen.container)).toEqual(["important"]);
    expect(screen.container.querySelector("li[data-flag]")?.textContent).toMatch(/^2/);

    await userEvent.click(screen.getByRole("button", { name: "All 4" }));
    expect(flags(screen.container)).toHaveLength(4);
  });

  it("hides a filter with no decisions, and the bar when only All is left", async () => {
    await using screen = await render(
      <Log autoPlanned={false} entries={decisions.filter((entry) => entry.flag !== "unclear")} />,
      { router: false },
    );
    await expect.element(screen.getByRole("button", { name: "Important 1" })).toBeVisible();
    expect(
      Array.from(
        screen.container.querySelectorAll("button[aria-pressed]"),
        (button) => button.textContent,
      ),
    ).toEqual(["All3", "Important1"]);

    await screen.rerender(
      <Log autoPlanned={false} entries={decisions.filter((entry) => entry.flag === "normal")} />,
    );
    expect(screen.container.querySelectorAll("button[aria-pressed]")).toHaveLength(0);
    expect(flags(screen.container)).toEqual(["normal", "normal"]);
  });

  it("falls back to All when the selected filter's decisions go away", async () => {
    await using screen = await render(<Log autoPlanned={false} />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Unclear 1" }));
    await screen.rerender(
      <Log autoPlanned={false} entries={decisions.filter((entry) => entry.flag !== "unclear")} />,
    );
    await expect
      .element(screen.getByRole("button", { name: "All 3" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(flags(screen.container)).toHaveLength(3);
  });
});
