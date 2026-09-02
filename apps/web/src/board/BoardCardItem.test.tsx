/**
 * T3o column card (t3o-06, D7). The column/board view renders from
 * `BoardCardShell` ALONE and must never open a detail subscription.
 * `BoardCardContent` takes only a shell (plus the label catalogue index) —
 * no environment id, no card id, no atom — so it is structurally incapable of
 * subscribing, and `renderToStaticMarkup` needs no runtime to render it. That
 * is the payload-discipline line D7 draws, asserted here.
 */
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardStageId,
  ProjectId,
  ThreadId,
  boardCardAttention,
  deriveBoardCardChildAttention,
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

/** The card's own attention, resolved exactly as the board page resolves it —
    the renderer takes it as a prop (it has no stage list of its own), so a test
    that wants the real treatment has to compute the real answer. */
const attentionOf = (card: BoardCardShell) =>
  boardCardAttention({ card, stages: BOARD_SEED_STAGES });

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
    expect(html).toContain("bg-success");
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
        attention={attentionOf(shell("building", { awaitingInput: true }))}
      />,
    );
    // Not just the badge: the fill, the border and the ring all go violet,
    // so "where am I needed" is answerable across a whole column at a glance.
    expect(awaiting).toContain("border-attention/55");
    expect(awaiting).toContain("color-mix(in_srgb,var(--attention)_7%,var(--card))");
    expect(awaiting).not.toContain("border-border");

    const calm = renderToStaticMarkup(
      <BoardCardContent
        card={shell("building")}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attentionOf(shell("building"))}
      />,
    );
    expect(calm).toContain("border-border");
    expect(calm).not.toContain("border-attention/55");

    // Selection still wins the border — the violet would otherwise read as
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
    expect(selected).not.toContain("border-attention/55");
  });

  it("renders a distinct stalled badge, separate from the awaiting-input treatment (t3o-17, D3)", () => {
    const stalled = renderToStaticMarkup(
      <BoardCardContent
        card={shell("building", { stalled: true })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attentionOf(shell("building", { stalled: true }))}
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
        attention={attentionOf(shell("building", { awaitingInput: true }))}
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
    expect(html).toContain("bg-info");
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

describe("cards that need a human (attention)", () => {
  it("paints a PARKED card amber and names it, where before it looked healthy", () => {
    // The quiet one: a human-in-the-loop build ran to the end, or the forge
    // refused a merge. Nothing is running, nothing stalled, no question asked
    // — the card face used to say nothing at all and the card sat mid-pipeline
    // looking exactly like a card being worked on.
    const parked = shell("building", { held: true });
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={parked}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attentionOf(parked)}
      />,
    );
    expect(html).toContain("Needs a human");
    expect(html).toContain("border-amber-500/60");
    expect(html).not.toContain("border-border");
  });

  it("does not flag a held step that is running again, nor one that reached Done", () => {
    // `held` rests on the shell until the next select-step clears it, so the
    // renderer must not treat a re-started card as parked…
    const restarted = shell("building", { held: true, stepRunning: true });
    expect(attentionOf(restarted)).toBeNull();
    // …and a finished card is not asking for anything, whatever its last step
    // status said.
    const done = shell("done", { held: true });
    expect(attentionOf(done)).toBeNull();
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={done}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attentionOf(done)}
      />,
    );
    expect(html).not.toContain("Needs a human");
  });

  it("ranks the loudest reason when a card qualifies for several", () => {
    // A stalled step whose thread also has a pending question: one chip, and it
    // is the stalled one.
    const both = shell("building", { stalled: true, awaitingInput: true, held: true });
    const attention = attentionOf(both);
    expect(attention?.reason).toBe("stalled");
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={both}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attention}
      />,
    );
    expect(html).toContain("Stalled");
    expect(html).not.toContain("Input needed");
    expect(html).not.toContain("Needs a human");
  });

  it("flows a child's block up to the parent, tone and all", () => {
    // The rule the sub-board needs: a parent builds THROUGH its children, so a
    // child waiting on a human blocks the parent too. The parent has no problem
    // of its own — before this it rendered as a perfectly healthy card while
    // its split sat dead.
    const parent = shell("building");
    const child = {
      ...shell("building", { stalled: true }),
      cardId: BoardCardId.make("card-2"),
      parentCardId: parent.cardId,
    };
    const byParent = deriveBoardCardChildAttention({
      cards: [parent, child],
      stages: BOARD_SEED_STAGES,
    });
    const inherited = byParent.get(parent.cardId);
    expect(inherited?.reason).toBe("stalled");
    expect(inherited?.childCount).toBe(1);

    const html = renderToStaticMarkup(
      <BoardCardContent
        card={parent}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attentionOf(parent)}
        childAttention={inherited}
      />,
    );
    // The child's RED, not a generic warning — the colour keeps meaning one
    // thing wherever it appears.
    expect(html).toContain("border-destructive/60");
    expect(html).toContain("1 child needs you");
  });

  it("keeps a blue child's question blue on the parent, and counts siblings", () => {
    const parent = shell("building");
    const asking = {
      ...shell("building", { awaitingInput: true }),
      cardId: BoardCardId.make("card-2"),
      parentCardId: parent.cardId,
    };
    const alsoAsking = {
      ...shell("review", { awaitingInput: true }),
      cardId: BoardCardId.make("card-3"),
      parentCardId: parent.cardId,
    };
    const inherited = deriveBoardCardChildAttention({
      cards: [parent, asking, alsoAsking],
      stages: BOARD_SEED_STAGES,
    }).get(parent.cardId);
    expect(inherited?.tone).toBe("attention");
    expect(inherited?.childCount).toBe(2);

    const html = renderToStaticMarkup(
      <BoardCardContent
        card={parent}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attentionOf(parent)}
        childAttention={inherited}
      />,
    );
    expect(html).toContain("border-attention/55");
    expect(html).toContain("2 children need you");
  });

  it("lets the parent's OWN problem win over an inherited one", () => {
    const parent = shell("building", { stalled: true });
    const child = {
      ...shell("building", { awaitingInput: true }),
      cardId: BoardCardId.make("card-2"),
      parentCardId: parent.cardId,
    };
    const inherited = deriveBoardCardChildAttention({
      cards: [parent, child],
      stages: BOARD_SEED_STAGES,
    }).get(parent.cardId);
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={parent}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attentionOf(parent)}
        childAttention={inherited}
      />,
    );
    // Its own stall is the actionable thing on THIS card; the child's question
    // is actionable on the child.
    expect(html).toContain("Stalled");
    expect(html).not.toContain("child needs you");
  });
});

describe("held review loop chip suppression", () => {
  /** A card whose review loop ran every round without converging. */
  const heldLoopCard = (stage: string): BoardCardShell =>
    shell(stage, {
      roundCurrent: 3,
      roundMax: 3,
      reviewOutcome: "running",
      reviewHeldOutcome: "round-cap",
      reviewRoundComplete: true,
    });

  it("skips the chip only where the round row actually explains the tint", () => {
    // On the review stage the summary renders "No convergence" beside the round
    // pips, so a second chip saying the same thing is noise.
    const onReview = heldLoopCard("review");
    const reviewHtml = renderToStaticMarkup(
      <BoardCardContent
        card={onReview}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attentionOf(onReview)}
      />,
    );
    expect(attentionOf(onReview)?.reason).toBe("review-held");
    expect(reviewHtml).toContain("No convergence");
    expect(reviewHtml).toContain("border-amber-500/60");

    // Off it, the round row is not rendered at all — so the card must NOT be
    // left tinted amber with nothing saying why.
    const offReview = heldLoopCard("building");
    const offHtml = renderToStaticMarkup(
      <BoardCardContent
        card={offReview}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
        attention={attentionOf(offReview)}
      />,
    );
    expect(offHtml).toContain("border-amber-500/60");
    expect(offHtml).toContain("No convergence");
  });
});
