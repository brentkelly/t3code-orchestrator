/**
 * The review-loop helpers in contracts (t3o-22).
 *
 * These exist because three surfaces must agree on where a loop is up to — the
 * server's projection cache (what a column card shows), the Review pane (what
 * the detail shows) and `reviewLoopDecision` (what actually runs next). Two of
 * them call `boardReviewLoopWalk`; the executor keeps its own copy because it
 * must mint prompts and models as it goes.
 *
 * That duplication is only safe if something holds the copies together. The
 * differential that does it lives in `apps/server` (`reviewLoopExecutor.test.ts`),
 * which is the only package that can import BOTH this walk and
 * `reviewLoopDecision`; contracts cannot depend on the server. What this file
 * pins is the walk's own behaviour — a loop that ran out of budget is never
 * reported as one that passed, a malformed payload is never read as "no
 * findings", and a round that has STARTED can never be removed from the
 * budget.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  BOARD_REVIEW_MAX_ROUNDS,
  boardReviewFindingResolution,
  boardReviewLoopWalk,
  boardReviewRoundsStarted,
  deriveBoardCardReviewSummary,
  effectiveBoardReviewRounds,
  resolveBoardCardReviewOutcome,
  BoardCard,
  BoardCardId,
  type BoardReviewFinding,
  type BoardStepCompletion,
} from "./board.ts";
import * as Schema from "effect/Schema";

const cardId = BoardCardId.make("card-1");

const completion = (
  stepId: string,
  payload: unknown,
  outcome: BoardStepCompletion["outcome"] = "succeeded",
): BoardStepCompletion => ({
  cardId,
  stepId,
  outcome,
  summary: `did ${stepId}`,
  payload:
    payload === undefined ? null : typeof payload === "string" ? payload : JSON.stringify(payload),
  threadId: null,
  completedAt: "2026-08-27T00:00:00.000Z",
});

const finding = (severity: BoardReviewFinding["severity"], id = "f1"): BoardReviewFinding => ({
  id,
  severity,
  file: "src/x.ts",
  line: 1,
  title: `${severity} thing`,
  detail: "",
});

const review = (round: number, findings: ReadonlyArray<BoardReviewFinding>) =>
  completion(`review@${round}`, { reviewedSha: `sha-${round}`, findings });

/** A round that ran every phase and left its critical unresolved. */
const unconverged = (round: number) => [
  review(round, [finding("critical", `f${round}`)]),
  completion(`triage@${round}`, { fixedSha: `fix-${round}`, dispositions: [] }),
  completion(`adjudicate@${round}`, { verdicts: [] }),
];

const walk = (
  completions: ReadonlyArray<BoardStepCompletion>,
  maxRounds: number,
  stopAfterRound: number | null = null,
) => boardReviewLoopWalk({ completions, maxRounds, stopAfterRound });

describe("boardReviewLoopWalk", () => {
  it("reports the next phase while a round is unfinished", () => {
    assert.deepStrictEqual(walk([], 5), {
      next: { phase: "review", round: 1 },
      status: "running",
      currentRound: 1,
    });
    // Findings exist, so triage is due before anything else.
    assert.deepStrictEqual(walk([review(1, [finding("critical")])], 5).next, {
      phase: "triage",
      round: 1,
    });
  });

  it("converges on a round whose review raised nothing blocking", () => {
    const clean = walk([review(1, [])], 5);
    assert.strictEqual(clean.status, "converged");
    assert.strictEqual(clean.next, null);
  });

  it("runs one triage pass for a nitpick-only round, then converges", () => {
    const nitpicks = [review(1, [finding("nitpick")])];
    assert.deepStrictEqual(walk(nitpicks, 5).next, { phase: "triage", round: 1 });
    const triaged = walk(
      [...nitpicks, completion("triage@1", { fixedSha: "s", dispositions: [] })],
      5,
    );
    assert.strictEqual(triaged.status, "converged");
  });

  it("reports round-cap — never converged — when the budget runs out", () => {
    const capped = walk(unconverged(1), 1);
    assert.strictEqual(capped.status, "round-cap");
    assert.strictEqual(capped.currentRound, 1);
  });

  it("reports `stopped` when the user's stop lands before the budget does", () => {
    // Four rounds of budget remain; the stop outranks them.
    const stopped = walk(unconverged(1), 5, 1);
    assert.strictEqual(stopped.status, "stopped");
    // A stop for a different round leaves the loop running.
    assert.strictEqual(walk(unconverged(1), 5, 3).status, "running");
  });

  it("halts on an unreadable review payload rather than reading it as clean", () => {
    assert.strictEqual(walk([completion("review@1", "{not json")], 5).status, "unreadable");
    assert.strictEqual(walk([completion("review@1", null)], 5).status, "unreadable");
    // The distinction that matters: a VALID empty findings list converged.
    assert.strictEqual(walk([review(1, [])], 5).status, "converged");
  });

  it("ignores completions that did not succeed", () => {
    const failed = completion("review@1", { reviewedSha: "s", findings: [] }, "failed");
    // A failed phase is the reactor's to retry, not a phase that happened.
    assert.deepStrictEqual(walk([failed], 5).next, { phase: "review", round: 1 });
  });

  it("t3o-24: a recorded sync step moves the verdict to the gate round", () => {
    const synced = [review(1, []), completion("sync@1", { rebasedSha: "s" })];
    // The converged round no longer converges — the gate round is due, PAST
    // the budget (a gate, not a negotiation).
    assert.deepStrictEqual(walk(synced, 1), {
      next: { phase: "review", round: 2 },
      status: "running",
      currentRound: 2,
    });
    // A clean gate round with no further sync converges.
    assert.strictEqual(walk([...synced, review(2, [])], 1).status, "converged");
    // A base that moved again gates again.
    assert.deepStrictEqual(
      walk([...synced, review(2, []), completion("sync@2", { rebasedSha: "s2" })], 1).next,
      { phase: "review", round: 3 },
    );
  });

  it("t3o-24: a blocking gate round beyond the budget caps like any other round", () => {
    const capped = walk(
      [
        review(1, []),
        completion("sync@1", { rebasedSha: "s" }),
        review(2, [finding("critical")]),
        completion("triage@2", { fixedSha: "s", dispositions: [] }),
        completion("adjudicate@2", { verdicts: [] }),
      ],
      1,
    );
    assert.strictEqual(capped.status, "round-cap");
    assert.strictEqual(capped.currentRound, 2);
  });
});

describe("deriveBoardCardReviewSummary", () => {
  it("is null for a card with no review history", () => {
    assert.strictEqual(
      deriveBoardCardReviewSummary({ completions: [], maxRounds: 5, stopAfterRound: null }),
      null,
    );
    // A non-review step is not review history.
    assert.strictEqual(
      deriveBoardCardReviewSummary({
        completions: [completion("building", null)],
        maxRounds: 5,
        stopAfterRound: null,
      }),
      null,
    );
  });

  it("never reports round-cap for a loop the caller's budget merely bounds", () => {
    // The regression this guards: bounding the walk by `maxRounds` made a
    // healthy 1-of-5 loop cache `round-cap` for the whole gap between one
    // round finishing and the next round's review landing — every healthy
    // multi-round card wearing the alarm.
    for (const maxRounds of [0, 1, 5]) {
      const summary = deriveBoardCardReviewSummary({
        completions: unconverged(1),
        maxRounds,
        stopAfterRound: null,
      });
      assert.strictEqual(summary?.outcome, "running", `maxRounds ${maxRounds}`);
    }
  });

  it("tallies severities and folds resolutions across every round", () => {
    const summary = deriveBoardCardReviewSummary({
      completions: [
        review(1, [finding("critical", "a"), finding("improvement", "b"), finding("nitpick", "c")]),
        completion("triage@1", {
          fixedSha: "s1",
          dispositions: [
            { findingId: "a", action: "fixed", note: "" },
            { findingId: "b", action: "rejected", note: "" },
          ],
        }),
        completion("adjudicate@1", {
          verdicts: [
            { findingId: "a", verdict: "fix-upheld", note: "" },
            { findingId: "b", verdict: "rejection-unjustified", note: "" },
          ],
        }),
      ],
      maxRounds: 5,
      stopAfterRound: null,
    });
    assert.strictEqual(summary?.severityCritical, 1);
    assert.strictEqual(summary?.severityImprovement, 1);
    assert.strictEqual(summary?.severityNitpick, 1);
    assert.strictEqual(summary?.issuesFixed, 1);
    // The adjudicator struck the rejection down, so it reads disputed.
    assert.strictEqual(summary?.issuesDisputed, 1);
    // The untriaged nitpick is still open.
    assert.strictEqual(summary?.issuesOpen, 1);
    assert.strictEqual(summary?.issuesRejected, 0);
  });

  it("reports the round the loop ENTERED, never the one it is waiting on", () => {
    // The ceiling walk sits on `lastRound + 1` for a held loop — a round that
    // never started. Letting that through rendered one pip more than the
    // executor's budget and disagreed with the pane over the same ledger.
    const capped = deriveBoardCardReviewSummary({
      completions: [...unconverged(1), ...unconverged(2)],
      maxRounds: 2,
      stopAfterRound: null,
    });
    assert.strictEqual(capped?.roundCurrent, 2);
    assert.strictEqual(capped?.roundMax, 2);

    // A caller that cannot see the budget says so rather than inventing one
    // from the ledger — which made every un-overridden card read `N of N`, a
    // progress bar that is always full and disagrees with the pane.
    const unknownBudget = deriveBoardCardReviewSummary({
      completions: [...unconverged(1), ...unconverged(2)],
      maxRounds: null,
      stopAfterRound: null,
    });
    assert.strictEqual(unknownBudget?.roundCurrent, 2);
    assert.strictEqual(unknownBudget?.roundMax, null);
    // The counts are still exact — they come off the ledger, not the budget.
    assert.strictEqual(unknownBudget?.severityCritical, 2);

    // Mid-round: round 2's review is in, its triage is not. The loop is ON
    // round 2, and the budget is still whatever the caller said.
    const midRound = deriveBoardCardReviewSummary({
      completions: [...unconverged(1), review(2, [finding("critical", "f2")])],
      maxRounds: 5,
      stopAfterRound: null,
    });
    assert.strictEqual(midRound?.roundCurrent, 2);
    assert.strictEqual(midRound?.roundMax, 5);
  });

  it("carries the held reading the read side needs to settle the outcome", () => {
    const capped = deriveBoardCardReviewSummary({
      completions: unconverged(1),
      maxRounds: 1,
      stopAfterRound: null,
    });
    assert.strictEqual(capped?.heldOutcome, "round-cap");
    const stopped = deriveBoardCardReviewSummary({
      completions: unconverged(1),
      maxRounds: 5,
      stopAfterRound: 1,
    });
    assert.strictEqual(stopped?.heldOutcome, "stopped");
  });
});

describe("resolveBoardCardReviewOutcome", () => {
  const summary = deriveBoardCardReviewSummary({
    completions: unconverged(1),
    maxRounds: 5,
    stopAfterRound: null,
  })!;

  it("keeps a provisional `running` while the executor is driving the card (running or queued)", () => {
    assert.strictEqual(resolveBoardCardReviewOutcome({ summary, stepActive: true }), "running");
  });

  it("settles a provisional `running` into the held reading once nothing runs", () => {
    // Same summary, opposite meaning — whether anything is running is the fact
    // that separates "between rounds" from "the loop ended here".
    assert.strictEqual(resolveBoardCardReviewOutcome({ summary, stepActive: false }), "round-cap");
  });

  it("never calls a HALF-RUN round a stopped loop, even with nothing running", () => {
    // Round 1's review is in, triage is not, and no step is admitted yet — the
    // real gap between one phase settling and the next starting. Reading that
    // as "the loop ended" is the false NO CONVERGENCE this guard exists for.
    const midRound = deriveBoardCardReviewSummary({
      completions: [review(1, [finding("critical")])],
      maxRounds: 5,
      stopAfterRound: null,
    })!;
    assert.strictEqual(midRound.roundComplete, false);
    assert.strictEqual(
      resolveBoardCardReviewOutcome({ summary: midRound, stepActive: false }),
      "running",
    );
  });

  it("never overrides a decided outcome", () => {
    const converged = deriveBoardCardReviewSummary({
      completions: [review(1, [])],
      maxRounds: 5,
      stopAfterRound: null,
    })!;
    assert.strictEqual(
      resolveBoardCardReviewOutcome({ summary: converged, stepActive: false }),
      "converged",
    );
  });
});

describe("boardReviewRoundsStarted / effectiveBoardReviewRounds", () => {
  it("counts a round that is in flight with nothing recorded", () => {
    const recorded = unconverged(1);
    assert.strictEqual(boardReviewRoundsStarted({ completions: recorded, liveStepId: null }), 1);
    // Round 2's review is dispatched and has recorded nothing. This is the
    // case that makes the floor "started", not "run".
    assert.strictEqual(
      boardReviewRoundsStarted({ completions: recorded, liveStepId: "review@2" }),
      2,
    );
    // A non-review live step contributes nothing.
    assert.strictEqual(
      boardReviewRoundsStarted({ completions: recorded, liveStepId: "building" }),
      1,
    );
  });

  it("floors the budget at the rounds already started", () => {
    // Asking for 1 round when 3 have started cannot remove them.
    assert.strictEqual(
      effectiveBoardReviewRounds({ configured: 5, overrides: null, roundsStarted: 3 }),
      5,
    );
    assert.strictEqual(
      effectiveBoardReviewRounds({
        configured: 5,
        overrides: { rounds: 1, stopAfterRound: null, roundModels: {} },
        roundsStarted: 3,
      }),
      3,
    );
  });

  it("caps at the ceiling and defaults to the stage setting", () => {
    assert.strictEqual(
      effectiveBoardReviewRounds({
        configured: 5,
        overrides: { rounds: 99, stopAfterRound: null, roundModels: {} },
        roundsStarted: 0,
      }),
      BOARD_REVIEW_MAX_ROUNDS,
    );
    // No override → the stage setting governs, so raising it moves the card.
    assert.strictEqual(
      effectiveBoardReviewRounds({ configured: 8, overrides: null, roundsStarted: 0 }),
      8,
    );
  });
});

describe("boardReviewFindingResolution", () => {
  it("reads an untriaged finding as open", () => {
    assert.strictEqual(boardReviewFindingResolution(undefined, undefined), "open");
  });

  it("takes the triage call when the adjudicator has not ruled", () => {
    assert.strictEqual(boardReviewFindingResolution({ action: "fixed" }, undefined), "fixed");
    assert.strictEqual(boardReviewFindingResolution({ action: "rejected" }, undefined), "rejected");
  });

  it("reads every struck-down claim as disputed, whichever way it was struck", () => {
    for (const verdict of ["fix-incomplete", "fix-absent", "rejection-unjustified"] as const) {
      assert.strictEqual(
        boardReviewFindingResolution({ action: "fixed" }, { verdict }),
        "disputed",
        verdict,
      );
    }
    assert.strictEqual(
      boardReviewFindingResolution({ action: "fixed" }, { verdict: "fix-upheld" }),
      "fixed",
    );
    assert.strictEqual(
      boardReviewFindingResolution({ action: "rejected" }, { verdict: "rejection-justified" }),
      "rejected",
    );
  });
});

const decodeBoardCard = Schema.decodeUnknownSync(BoardCard);

describe("replay equals rehydration for a pre-t3o-22 log", () => {
  it("decodes a card payload written before this spec to null overrides", () => {
    // Migration 025's `review_overrides` column defaults to NULL, so a
    // rehydrated pre-t3o-22 row reads null. A from-empty replay of the same
    // log must reach the identical card, which is what this default buys.
    const legacy = {
      id: "card-1",
      key: "T3-1",
      cardNumber: 1,
      projectId: "project-1",
      labels: [],
      stage: "review",
      orderKey: "m",
      title: "Card",
      briefRef: null,
      dependsOn: [],
      parentCardId: null,
      threadLinks: [],
      externalRef: null,
      blocked: false,
      archivedAt: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    assert.strictEqual(decodeBoardCard(legacy).reviewOverrides, null);
    // t3o-29 AC8, the identical guarantee one spec later: migration 029's
    // `model_overrides` column also defaults to NULL, so the same payload must
    // decode to null overrides rather than an empty map — `{}` and `null` would
    // make a replayed card and a rehydrated one compare unequal.
    assert.strictEqual(decodeBoardCard(legacy).modelOverrides, null);
  });
});
