import { BoardCardId, type BoardCardDecision } from "@t3tools/contracts";
import { useState } from "react";
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

function Log({ autoPlanned }: { readonly autoPlanned: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const view = boardDecisionLogView({ decisions, autoPlanned, pastBuild: false });
  return view === null ? null : <BoardDecisionLog onOpenChange={setOpen} open={open} view={view} />;
}

describe("BoardDecisionLog", () => {
  it("opens an auto-planned log with unclear decisions, unclear first", async () => {
    await using screen = await render(<Log autoPlanned />, { router: false });
    const header = screen.getByRole("button", { name: /Decision log/ });
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    const summary = screen.container.querySelector("button[aria-expanded]")?.textContent ?? "";
    expect(summary.replace(/\s+/g, " ")).toContain("4 decisions");
    expect(summary).toContain("1 unclear·1 important");

    const rows = Array.from(screen.container.querySelectorAll("li[data-flag]"));
    expect(rows.map((row) => row.getAttribute("data-flag"))).toEqual([
      "unclear",
      "important",
      "normal",
      "normal",
    ]);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ship behind a flag?Unclear"),
      expect.stringContaining("Split the card?Important"),
      expect.stringContaining("Where does it live?You"),
      expect.stringContaining("Name the table?Agent"),
    ]);
  });

  it("keeps a log the human planned closed until it is opened", async () => {
    await using screen = await render(<Log autoPlanned={false} />, { router: false });
    const header = screen.getByRole("button", { name: /Decision log/ });
    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.container.querySelectorAll("li[data-flag]").length).toBe(0);

    await userEvent.click(header);
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("Decided: Ship behind a flag?")).toBeVisible();
  });
});
