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
        offStage
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

  // T3O-3: the same pane, read through its ROUND. A card that has never
  // reached review still derives a synthetic round 1 (that is where the loop
  // will start), and the pane used to dress it as "In progress" with a
  // spinning phase marker while the card sat in Building.
  it("renders the round of a not-started loop as not started, never as in progress", () => {
    const html = renderToStaticMarkup(
      <BoardCardReviewPane
        completions={[]}
        live={false}
        maxRounds={3}
        offStage
        onBackToThread={noop}
      />,
    );
    expect(html).toContain("Not started");
    expect(html).not.toContain("In progress");
    // No phase claims to be running: no spinner, and the review phase's note
    // is the resting one.
    expect(html).not.toContain("Running now");
    expect(html).not.toContain("A fresh thread is reading the diff");
    expect(html).toContain("Not started.");
    // The footer says when the loop WILL run rather than describing a run.
    expect(html).toContain("starts when the card reaches the review stage");
  });

  // T3O-3: a card dragged BACK off the review stage mid-loop. Round 1 has
  // history, so it is not "not started" — but nothing is running either.
  it("renders an off-stage mid-loop round as not running, with no spinning phase", () => {
    const html = renderToStaticMarkup(
      <BoardCardReviewPane
        completions={[
          completion("review@1", {
            reviewedSha: "sha1",
            findings: [
              {
                id: "f1",
                severity: "critical",
                file: "a.ts",
                line: 1,
                title: "Open finding",
                detail: "",
              },
            ],
          }),
        ]}
        live={false}
        maxRounds={3}
        offStage
        onBackToThread={noop}
      />,
    );
    expect(html).toContain("Not running");
    expect(html).not.toContain("In progress");
    expect(html).not.toContain("Running now");
    // Triage is the due phase; off-stage it has simply not started.
    expect(html).not.toContain("still being worked");
    expect(html).toContain("Not started.");
    expect(html).toContain("paused while the card sits off the review stage");
  });

  // T3O-3, the mixed case: off-stage with a closed round behind the open one.
  // The closed round keeps its real outcome; only the round the loop would
  // have entered next reads as not started.
  it("keeps a closed round's outcome while its unstarted successor reads as not started", () => {
    const html = renderToStaticMarkup(
      <BoardCardReviewPane
        completions={[
          completion("review@1", {
            reviewedSha: "sha1",
            findings: [
              { id: "f1", severity: "critical", file: "a.ts", line: 1, title: "Boom", detail: "" },
            ],
          }),
          completion("triage@1", {
            fixedSha: "sha2",
            dispositions: [{ findingId: "f1", action: "fixed", note: "fixed it" }],
          }),
          completion("adjudicate@1", {
            verdicts: [{ findingId: "f1", verdict: "fix-upheld", note: "" }],
          }),
        ]}
        live={false}
        maxRounds={3}
        offStage
        onBackToThread={noop}
      />,
    );
    expect(html).toContain("Changes requested");
    expect(html).toContain("Not started");
    expect(html).not.toContain("In progress");
    expect(html).not.toContain("Running now");
  });

  // The guard for the fix above: ON the review stage the round still reads as
  // in progress, and the due phase still spins.
  it("still shows a live on-stage round as in progress, with its phase running", () => {
    const html = renderToStaticMarkup(
      <BoardCardReviewPane completions={[]} live maxRounds={3} onBackToThread={noop} />,
    );
    expect(html).toContain("In progress");
    expect(html).toContain("Running now");
    expect(html).toContain("A fresh thread is reading the diff");
  });

  // A card dragged off the review stage mid-loop: the loop derives as
  // "running", but nothing is, and nobody is waited on — the pill must say
  // so rather than wear the waiting-on-you colour.
  it("renders an off-stage mid-loop pane as not running, never as waiting", () => {
    const html = renderToStaticMarkup(
      <BoardCardReviewPane
        completions={[
          completion("review@1", {
            reviewedSha: "sha1",
            findings: [
              {
                id: "f1",
                severity: "critical",
                file: "a.ts",
                line: 1,
                title: "Open finding",
                detail: "",
              },
            ],
          }),
        ]}
        live={false}
        maxRounds={3}
        offStage
        onBackToThread={noop}
      />,
    );
    expect(html).toContain("Not running — card is off the review stage");
    expect(html).not.toContain("running now");
    expect(html).not.toContain("waiting to run");
  });
});
