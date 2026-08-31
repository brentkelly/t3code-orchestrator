/**
 * T3o column card (t3o-06, D7). The column/board view renders from
 * `BoardCardShell` ALONE and must never open a detail subscription.
 * `BoardCardContent` takes only a shell (plus the label catalogue index) —
 * no environment id, no card id, no atom — so it is structurally incapable of
 * subscribing, and `renderToStaticMarkup` needs no runtime to render it. That
 * is the payload-discipline line D7 draws, asserted here.
 */
import {
  BoardCardId,
  BoardStageId,
  ProjectId,
  ThreadId,
  makeBoardCardShell,
  type BoardCardShell,
  type BoardLabel,
  type BoardLabelId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardCardContent } from "./BoardCardItem";

function shell(stage: string, overrides?: Partial<BoardCardShell>): BoardCardShell {
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make("card-1"),
      key: "T3-9",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BoardStageId.make(stage),
      orderKey: "m",
      title: "Render me from the shell",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...overrides,
  };
}

const emptyLabels = new Map<BoardLabelId, BoardLabel>();

describe("BoardCardContent (D7)", () => {
  it("renders the whole card from shell data with no environment or subscription", () => {
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("backlog")}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(html).toContain("T3-9");
    expect(html).toContain("Render me from the shell");
  });

  it("renders a review card's severity triple from shell fields alone", () => {
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("review", {
          severityCritical: 1,
          severityImprovement: 2,
          severityNitpick: 3,
        })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    // The severity triple's tooltip spells the three numbers out.
    expect(html).toContain("1 critical · 2 improvements · 3 nitpicks");
  });

  it("counts dependencies before the gate, and names the gate once it bites", () => {
    const early = renderToStaticMarkup(
      <BoardCardContent
        card={shell("backlog", { dependencyCount: 2 })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    // Backlog is before the D18 gate: a count, not the word "Blocked".
    expect(early).toContain("Depends on 2 cards");
    expect(early).not.toContain("Blocked");

    const gated = renderToStaticMarkup(
      <BoardCardContent
        card={shell("ready", { blocked: true, dependencyCount: 2 })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(gated).toContain("Blocked");
    expect(gated).toContain("Blocked by 2 dependencies");
    // The gate does not swallow the count: a blocked card still says what it
    // is waiting on, down in the meta row.
    expect(gated).toContain("Depends on 2 cards");
  });

  it("wears the plan bar with its drill-in chip on a split parent, at any stage", () => {
    // The prototype's treatment (t3o-25): a segment bar — one flex segment per
    // child, coloured done/started/pending — with the "N/M plans" chip beside
    // it. No footer "N cards" button, and the row shows outside Building too.
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("ready", { planTotal: 6, planDone: 2, planStatuses: "ddiipp" })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(html).toContain("2/6 plans");
    expect(html).toContain("2 of 6 plans done");
    expect(html).toContain("bg-emerald-500");
    expect(html).toContain("bg-info/60");
    expect(html).not.toContain("6 cards");
    // Without the drill handler (the ghost, the archive sheet) the chip is a
    // static span, not a button.
    expect(html).not.toContain("Open this card&#x27;s sub-board");
  });

  it("spells out every meta indicator in a tooltip, since a bare glyph and a number mean nothing", () => {
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("review", {
          dependencyCount: 1,
          planCount: 1,
          prNumber: 88,
          briefHasImage: true,
        })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(html).toContain("Depends on 1 card");
    expect(html).toContain("1 plan");
    expect(html).toContain("Pull request #88");
    expect(html).toContain("#88");
    expect(html).toContain("Brief contains an image");
  });

  it("renders no meta row at all when the card is tied to nothing", () => {
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("backlog")}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(html).not.toContain("Depends on");
    expect(html).not.toContain("Brief contains an image");
    expect(html).not.toContain("agent thread");
  });

  it("counts the card's live threads in the meta row (t3o-18)", () => {
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("building")}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        todos={{
          threads: [
            { cardId: BoardCardId.make("card-1"), threadId: ThreadId.make("thread-1") },
            { cardId: BoardCardId.make("card-1"), threadId: ThreadId.make("thread-2") },
          ],
          stateOf: () => undefined,
          titleOf: () => "Thread",
          expanded: false,
          onToggleExpanded: () => {},
        }}
      />,
    );
    expect(html).toContain("2 agent threads on this card");
  });

  it("paints the whole card blue when it is waiting on a human", () => {
    const awaiting = renderToStaticMarkup(
      <BoardCardContent
        card={shell("building", { awaitingInput: true })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    // Not just the badge: the fill, the border and the ring all go info-blue,
    // so "where am I needed" is answerable across a whole column at a glance.
    expect(awaiting).toContain("border-info/55");
    expect(awaiting).toContain("color-mix(in_srgb,var(--info)_7%,var(--card))");
    expect(awaiting).not.toContain("border-border");

    const calm = renderToStaticMarkup(
      <BoardCardContent
        card={shell("building")}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(calm).toContain("border-border");
    expect(calm).not.toContain("border-info/55");

    // Selection still wins the border — the blue would otherwise read as
    // "needs input" on whichever card you happened to click.
    const selected = renderToStaticMarkup(
      <BoardCardContent
        card={shell("building", { awaitingInput: true })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={true}
      />,
    );
    expect(selected).toContain("border-foreground/40");
    expect(selected).not.toContain("border-info/55");
  });

  it("renders a distinct stalled badge, separate from the awaiting-input treatment (t3o-17, D3)", () => {
    const stalled = renderToStaticMarkup(
      <BoardCardContent
        card={shell("building", { stalled: true })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    // The loud, human-needed signal — distinct from the blue "Input needed".
    expect(stalled).toContain("Stalled");
    expect(stalled).toContain("text-destructive-foreground");
    expect(stalled).not.toContain("Input needed");

    // A healthy question is still the blue awaiting-input treatment, never flagged
    // as stalled (crit 8).
    const awaiting = renderToStaticMarkup(
      <BoardCardContent
        card={shell("building", { awaitingInput: true })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(awaiting).toContain("Input needed");
    expect(awaiting).not.toContain("Stalled");
  });

  it("keeps the working dot lit while the executor step is running, even when no thread is mid-turn", () => {
    // A Code-review card mid-loop: the executor's step is admitted and running,
    // but between one phase's thread completing and the next spinning up, no
    // linked thread is itself mid-turn (threadState is "stopped"/"none"). The
    // card is still being actively worked, so the durable `stepRunning` signal
    // must keep the green dot lit across the per-phase gap.
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("review", { stepRunning: true, threadState: "stopped" })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(html).toContain("Thread running");
    expect(html).toContain("bg-emerald-500");
    // The working dot pulses so an actively-worked card reads at a glance.
    expect(html).toContain("animate-pulse");
  });

  it("shows no working dot on a settled card with no running step and no live turn", () => {
    // The other half: a review card whose loop has settled (step succeeded)
    // and whose threads are all idle must NOT show the dot.
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("review", { stepRunning: false, threadState: "stopped" })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(html).not.toContain("Thread running");
  });

  it("mutes a Done card", () => {
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("done")}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(html).toContain("opacity-70");
  });
});
