/**
 * T3o (T3O-48): what "Check again" says back.
 *
 * The refresh used to return nothing at all, so a card sitting at Ready for
 * merge with no pull request could not tell "the forge says this branch has
 * none" from "the forge could not be asked" — and only the second is worth
 * retrying. Every arm answers; the sentences are what the user reads.
 */
import { describe, expect, it } from "vite-plus/test";

import { describeBoardRefreshOutcome } from "./boardCommandFeedback";

describe("describeBoardRefreshOutcome", () => {
  it("stays silent when the pull request turned up", () => {
    // The Merge button and the View PR link both appear, which says it better
    // than a sentence would.
    expect(describeBoardRefreshOutcome({ outcome: "linked", number: 110 }, "board/t3o-46")).toBe(
      null,
    );
  });

  it("names the branch it looked for when there is still nothing", () => {
    // Not silence: the card looks identical before and after, so without this
    // the click has no acknowledgement at all.
    expect(describeBoardRefreshOutcome({ outcome: "none" }, "board/t3o-46")).toBe(
      "Still no pull request for board/t3o-46.",
    );
  });

  it("quotes the forge when it could not be reached", () => {
    expect(
      describeBoardRefreshOutcome(
        { outcome: "lookup-failed", detail: "GitHub API rate limit exceeded." },
        "board/t3o-46",
      ),
    ).toBe("Could not reach the forge: GitHub API rate limit exceeded.");
  });

  it("still says the forge could not be reached when it gave no reason", () => {
    expect(describeBoardRefreshOutcome({ outcome: "lookup-failed", detail: "" }, null)).toBe(
      "Could not reach the forge.",
    );
  });

  it("distinguishes a failed lookup from a branch with no pull request", () => {
    // The whole point of the result union: these two must never read the same.
    const failed = describeBoardRefreshOutcome(
      { outcome: "lookup-failed", detail: "gh: not authenticated" },
      "board/t3o-46",
    );
    const none = describeBoardRefreshOutcome({ outcome: "none" }, "board/t3o-46");
    expect(failed).not.toBe(none);
  });

  it("names a card with no branch, and one that has gone", () => {
    expect(describeBoardRefreshOutcome({ outcome: "no-branch" }, null)).toBe(
      "This card has no branch to look a pull request up for.",
    );
    expect(describeBoardRefreshOutcome({ outcome: "unknown-card" }, null)).toBe(
      "This card no longer exists.",
    );
  });

  it("drops the branch clause rather than printing an empty one", () => {
    expect(describeBoardRefreshOutcome({ outcome: "none" }, null)).toBe("Still no pull request.");
  });
});
