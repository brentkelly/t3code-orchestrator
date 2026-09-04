/**
 * The Review pane (t3o-16, D9), rendered to static markup straight from step
 * completions — the pane is a pure function of the completions plus the
 * configured round cap, so these tests need no atoms and no subscription.
 */
import { BoardCardId, ThreadId, type BoardStepCompletion } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardCardReviewPane } from "./BoardCardReviewPane";

const cardId = BoardCardId.make("card-1");
const NOW = "2026-01-01T00:00:00.000Z";

const completion = (
  stepId: string,
  payload: unknown,
  threadId: ThreadId | null = null,
): BoardStepCompletion => ({
  cardId,
  stepId,
  outcome: "succeeded",
  summary: `did ${stepId}`,
  payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  threadId,
  completedAt: NOW,
});

const noop = () => {};

describe("BoardCardReviewPane", () => {
  it("renders the segment bar, the current round's steps, and the running phase", () => {
    const html = renderToStaticMarkup(
      <BoardCardReviewPane
        completions={[
          completion("review@1", {
            reviewedSha: "sha1",
            findings: [
              {
                id: "f1",
                severity: "nitpick",
                file: "index.test.mjs",
                line: 31,
                title: "Regex-based HTML assertions are brittle",
                detail: "",
              },
            ],
          }),
        ]}
        live
        maxRounds={5}
        onBackToThread={noop}
      />,
    );
    expect(html).toContain("Adversarial review");
    expect(html).toContain("Round 1 of 5");
    // All five segments render; only round 1 exists.
    for (let n = 1; n <= 5; n++) expect(html).toContain(`R${n}`);
    // The three phases, with triage running (a nitpick still gets triaged).
    expect(html).toContain("Fresh-eyes review");
    expect(html).toContain("Triage &amp; respond");
    expect(html).toContain("Adjudication");
    expect(html).toContain("running now");
    expect(html).toContain("Only runs when a finding blocks the round.");
    // The finding, with its severity and its open state.
    expect(html).toContain("Regex-based HTML assertions are brittle");
    expect(html).toContain("nitpick");
    expect(html).toContain("index.test.mjs:31");
    expect(html).toContain("1 raised");
  });

  it("renders a settled loop with per-round history and verdict-folded resolutions", () => {
    const html = renderToStaticMarkup(
      <BoardCardReviewPane
        completions={[
          completion("review@1", {
            reviewedSha: "sha1",
            findings: [
              {
                id: "f1",
                severity: "critical",
                file: "src/a.ts",
                line: 12,
                title: "Null deref",
                detail: "x may be null",
              },
            ],
          }),
          completion("triage@1", {
            fixedSha: "sha2",
            dispositions: [{ findingId: "f1", action: "fixed", note: "guarded it" }],
          }),
          completion("adjudicate@1", {
            verdicts: [{ findingId: "f1", verdict: "fix-upheld", note: "" }],
          }),
          completion("review@2", { reviewedSha: "sha3", findings: [] }),
        ]}
        live={false}
        maxRounds={5}
        onBackToThread={noop}
      />,
    );
    expect(html).toContain("Loop settled");
    expect(html).toContain("Round 1");
    expect(html).toContain("Round 2");
    expect(html).toContain("Changes requested");
    expect(html).toContain("Clean");
    // The current round is the expanded one; round 1 is collapsed to its head
    // — severity tally and disposition summary, not finding bodies.
    expect(html).toContain("1 / 0 / 0");
    expect(html).toContain("1 fixed · 0 rejected");
    expect(html).not.toContain("Null deref");
    expect(html).toContain("1 raised");
  });

  it("offers a Thread button only for phases that recorded one", () => {
    const html = renderToStaticMarkup(
      <BoardCardReviewPane
        completions={[
          completion(
            "review@1",
            { reviewedSha: "sha1", findings: [] },
            ThreadId.make("thread-review-1"),
          ),
        ]}
        live={false}
        maxRounds={5}
        onBackToThread={noop}
        onOpenThread={noop}
      />,
    );
    expect(html.match(/Thread<\/button>/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  // The pane opens ahead of the loop from any stage (so round models can be
  // chosen before the executor freezes them): nothing has run, so the pill
  // must not claim the loop is running or waiting, and every round — round 1
  // included — is still plannable.
  it("renders a not-started loop as neutral, with every round plannable", () => {
    const html = renderToStaticMarkup(
      <BoardCardReviewPane
        completions={[]}
        live={false}
        maxRounds={3}
        notStarted
        onBackToThread={noop}
        onSetRoundModel={noop}
        onSetRounds={noop}
      />,
    );
    expect(html).toContain("Not started yet");
    expect(html).not.toContain("running now");
    expect(html).not.toContain("waiting to run");
    // No round has started, so no control is disabled — not even R1's.
    expect(html).not.toContain('disabled=""');
  });
});
