/**
 * The executor keeps its own copy of `boardReviewLoopWalk`; the differential holding them
 * together lives in `apps/server` (`reviewLoopExecutor.test.ts`), since contracts cannot
 * import the server. This file pins the walk itself.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  boardReviewBlockedOutcomeRefusal,
  boardReviewCompletionDefect,
  boardReviewFindingResolution,
  boardReviewQuestionAnswer,
  boardReviewHeldLabel,
  boardReviewLoopWalk,
  boardStepPayloadDefect,
  isBoardReviewLoopHeld,
  boardReviewRoundsStarted,
  deriveBoardCardReviewSummary,
  effectiveBoardReviewRounds,
  resolveBoardCardReviewOutcome,
  boardReviewDismissals,
  BoardCard,
  BoardCardId,
  BoardCardReviewSummary,
  BoardCardReviewOverrides,
  BoardReviewPayload,
  BoardStageExecutionReview,
  boardReviewNextRoundMode,
  boardReviewRoundForcingCount,
  boardReviewRoundModeOf,
  EMPTY_BOARD_CARD_REVIEW_OVERRIDES,
  type BoardReviewFinding,
  type BoardStepCompletion,
} from "./board.ts";
import * as Schema from "effect/Schema";

const cardId = BoardCardId.make("card-1");
const decodeOverrides = Schema.decodeUnknownSync(BoardCardReviewOverrides);
const decodeReviewStage = Schema.decodeUnknownSync(BoardStageExecutionReview);
const decodeReviewPayload = Schema.decodeUnknownSync(BoardReviewPayload);

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
  runThroughRound: number | null = null,
) => boardReviewLoopWalk({ completions, maxRounds, stopAfterRound, runThroughRound });

describe("boardReviewLoopWalk", () => {
  it("reports the next phase while a round is unfinished", () => {
    assert.deepStrictEqual(walk([], 5), {
      next: { phase: "review", round: 1 },
      status: "running",
      currentRound: 1,
      unreadableStepId: null,
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

  // Every phase, not only `review`, must have a readable payload: the completion handler
  // and the decider already treat an unreadable one as unusable.
  it("halts on an unreadable payload from ANY phase, naming the step to reopen", () => {
    const brokenTriage = walk(
      [review(1, [finding("nitpick")]), completion("triage@1", "{oops")],
      5,
    );
    assert.strictEqual(brokenTriage.status, "unreadable");
    assert.strictEqual(brokenTriage.unreadableStepId, "triage@1");

    const brokenAdjudicate = walk(
      [
        review(1, [finding("critical")]),
        completion("triage@1", { fixedSha: "s", dispositions: [] }),
        completion("adjudicate@1", null),
      ],
      5,
    );
    assert.strictEqual(brokenAdjudicate.status, "unreadable");
    assert.strictEqual(brokenAdjudicate.unreadableStepId, "adjudicate@1");

    const brokenSync = walk([review(1, []), completion("sync@1", { nope: 1 })], 5);
    assert.strictEqual(brokenSync.status, "unreadable");
    assert.strictEqual(brokenSync.unreadableStepId, "sync@1");

    // The review case reports its own step, so the recovery always has one.
    assert.strictEqual(walk([completion("review@1", null)], 5).unreadableStepId, "review@1");
    // And nothing else in the vocabulary carries one.
    assert.strictEqual(walk([review(1, [])], 5).unreadableStepId, null);
    assert.strictEqual(walk(unconverged(1), 1).unreadableStepId, null);

    // Repairing the broken triage moves the loop on exactly as repairing a
    // broken review does: this round had only a nitpick, so it converges.
    const repaired = walk(
      [
        review(1, [finding("nitpick")]),
        completion("triage@1", { fixedSha: "s", dispositions: [] }),
      ],
      5,
    );
    assert.strictEqual(repaired.status, "converged");
  });

  it("only reads the phases a round actually summons", () => {
    // A clean round never summoned triage, so a stray broken triage record is
    // not a phase this loop is waiting on — reading it would halt a converged
    // loop on work it never asked for.
    assert.strictEqual(
      walk([review(1, []), completion("triage@1", "{oops")], 5).status,
      "converged",
    );
    // Nothing blocked, so adjudication was never summoned either.
    assert.strictEqual(
      walk(
        [
          review(1, [finding("nitpick")]),
          completion("triage@1", { fixedSha: "s", dispositions: [] }),
          completion("adjudicate@1", "{oops"),
        ],
        5,
      ).status,
      "converged",
    );
  });

  // An agent may hand `board_complete_step` an already-stringified payload, which gets
  // stringified again; one level of wrapping is unwrapped on read.
  it("t3o-2: reads a payload the agent handed the tool already stringified", () => {
    const doubled = (round: number, findings: ReadonlyArray<BoardReviewFinding>) =>
      completion(
        `review@${round}`,
        JSON.stringify(JSON.stringify({ reviewedSha: `sha-${round}`, findings })),
      );
    // Exactly the shape the walk gives the same payload encoded once.
    assert.deepStrictEqual(walk([doubled(1, [])], 5), walk([review(1, [])], 5));
    assert.deepStrictEqual(
      walk([doubled(1, [finding("critical")])], 5),
      walk([review(1, [finding("critical")])], 5),
    );
    // ...and a string that is not a payload at all stays unreadable: the
    // tolerance is for the encoding, never for the content.
    assert.strictEqual(
      walk([completion("review@1", JSON.stringify("done"))], 5).status,
      "unreadable",
    );
    assert.strictEqual(
      walk([completion("review@1", JSON.stringify(JSON.stringify({ nope: 1 })))], 5).status,
      "unreadable",
    );
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
      unreadableStepId: null,
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

  it("T3O-39: a requested round outranks the convergence exit", () => {
    // The control: the same completions converge with nothing asked for.
    assert.strictEqual(walk([review(1, [])], 5).status, "converged");
    // Asked for, round 2 is what the loop owes — and the pane must say so,
    // or it reports `converged` while the executor dispatches the round.
    const requested = walk([review(1, [])], 5, null, 2);
    assert.strictEqual(requested.status, "running");
    assert.deepStrictEqual(requested.next, { phase: "review", round: 2 });
    // Self-clearing: once round 2 has run, the loop converges normally.
    assert.strictEqual(walk([review(1, []), review(2, [])], 5, null, 2).status, "converged");
  });

  it("T3O-39: a recorded sync still gates a requested round", () => {
    // The sync's own gate round comes first: the request is satisfied by the
    // round that follows the rebase, and reviewing the diff against a base it
    // is no longer built on is not the pass that was asked for.
    const stale = walk([review(1, []), completion("sync@1", { rebasedSha: "s" })], 5, null, 2);
    assert.deepStrictEqual(stale.next, { phase: "review", round: 2 });
  });
});

describe("deriveBoardCardReviewSummary", () => {
  it("is null for a card with no review history", () => {
    assert.strictEqual(
      deriveBoardCardReviewSummary({
        completions: [],
        maxRounds: 5,
        stopAfterRound: null,
        runThroughRound: null,
      }),
      null,
    );
    // A non-review step is not review history.
    assert.strictEqual(
      deriveBoardCardReviewSummary({
        completions: [completion("building", null)],
        maxRounds: 5,
        stopAfterRound: null,
        runThroughRound: null,
      }),
      null,
    );
  });

  it("T3O-39: a requested round keeps the cache off `converged`", () => {
    const converged = deriveBoardCardReviewSummary({
      completions: [review(1, [])],
      maxRounds: 5,
      stopAfterRound: null,
      runThroughRound: null,
    });
    assert.strictEqual(converged?.outcome, "converged");
    // With the round asked for the cache reports the loop as still going, so
    // the column card cannot render a pass over a round that is dispatching.
    const requested = deriveBoardCardReviewSummary({
      completions: [review(1, [])],
      maxRounds: 5,
      stopAfterRound: null,
      runThroughRound: 2,
    });
    assert.strictEqual(requested?.outcome, "running");
  });

  it("T3O-39: the walk bound comes from the ledger, not a compiled-in ceiling", () => {
    // Eleven clean-then-blocking rounds: the old bound of 10 truncated the
    // walk here and reported `round-cap` on a loop that had simply run long.
    const long = Array.from({ length: 11 }, (_, index) => unconverged(index + 1)).flat();
    const summary = deriveBoardCardReviewSummary({
      completions: long,
      maxRounds: null,
      stopAfterRound: null,
      runThroughRound: null,
    });
    assert.strictEqual(summary?.outcome, "running");
    assert.strictEqual(summary?.roundCurrent, 11);
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
        runThroughRound: null,
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
      runThroughRound: null,
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

  // The tally skipped the double-encoded round entirely, so the card
  // showed round 1's counts under a round-2 header.
  it("t3o-2: tallies a round whose payload arrived double-encoded", () => {
    const doubled = deriveBoardCardReviewSummary({
      completions: [
        completion(
          "review@1",
          JSON.stringify(JSON.stringify({ reviewedSha: "sha-1", findings: [finding("nitpick")] })),
        ),
        completion("triage@1", {
          fixedSha: "s1",
          dispositions: [{ findingId: "f1", action: "fixed", note: "" }],
        }),
      ],
      maxRounds: 5,
      stopAfterRound: null,
      runThroughRound: null,
    });
    assert.strictEqual(doubled?.severityNitpick, 1);
    assert.strictEqual(doubled?.issuesFixed, 1);
    assert.strictEqual(doubled?.outcome, "converged");
  });

  it("reports the round the loop ENTERED, never the one it is waiting on", () => {
    // The ceiling walk sits on `lastRound + 1` for a held loop — a round that
    // never started. Letting that through rendered one pip more than the
    // executor's budget and disagreed with the pane over the same ledger.
    const capped = deriveBoardCardReviewSummary({
      completions: [...unconverged(1), ...unconverged(2)],
      maxRounds: 2,
      stopAfterRound: null,
      runThroughRound: null,
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
      runThroughRound: null,
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
      runThroughRound: null,
    });
    assert.strictEqual(midRound?.roundCurrent, 2);
    assert.strictEqual(midRound?.roundMax, 5);
  });

  it("carries the held reading the read side needs to settle the outcome", () => {
    const capped = deriveBoardCardReviewSummary({
      completions: unconverged(1),
      maxRounds: 1,
      stopAfterRound: null,
      runThroughRound: null,
    });
    assert.strictEqual(capped?.heldOutcome, "round-cap");
    const stopped = deriveBoardCardReviewSummary({
      completions: unconverged(1),
      maxRounds: 5,
      stopAfterRound: 1,
      runThroughRound: null,
    });
    assert.strictEqual(stopped?.heldOutcome, "stopped");
  });
});

describe("resolveBoardCardReviewOutcome", () => {
  const summary = deriveBoardCardReviewSummary({
    completions: unconverged(1),
    maxRounds: 5,
    stopAfterRound: null,
    runThroughRound: null,
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
      runThroughRound: null,
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
      runThroughRound: null,
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
        overrides: {
          rounds: 1,
          stopAfterRound: null,
          roundModels: {},
          runThroughRound: null,
          carriedFindings: {},
          stuckWaivedThrough: null,
          roundModes: {},
        },
        roundsStarted: 3,
      }),
      3,
    );
  });

  it("has no ceiling and defaults to the stage setting", () => {
    // The round ceiling is gone. A budget a human typed into the
    // stepper is a number they can see, and denying it bought nothing.
    assert.strictEqual(
      effectiveBoardReviewRounds({
        configured: 5,
        overrides: {
          rounds: 99,
          stopAfterRound: null,
          roundModels: {},
          runThroughRound: null,
          carriedFindings: {},
          stuckWaivedThrough: null,
          roundModes: {},
        },
        roundsStarted: 0,
      }),
      99,
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

  it("T3O-55: reads the adjudicator's escalation as escalated", () => {
    assert.strictEqual(
      boardReviewFindingResolution({ action: "rejected" }, { verdict: "escalated" }),
      "escalated",
    );
  });
});

const decodeBoardCard = Schema.decodeUnknownSync(BoardCard);
const decodeReviewSummary = Schema.decodeSync(BoardCardReviewSummary);

describe("replay equals rehydration for a pre-t3o-22 log", () => {
  it("decodes a card payload written before this spec to null overrides", () => {
    // Migration 025's `review_overrides` column defaults to NULL, so a
    // rehydrated legacy row reads null. A from-empty replay of the same
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
      attachments: [],
      externalRef: null,
      blocked: false,
      archivedAt: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    assert.strictEqual(decodeBoardCard(legacy).reviewOverrides, null);
    // The identical guarantee for model overrides: migration 029's
    // `model_overrides` column also defaults to NULL, so the same payload must
    // decode to null overrides rather than an empty map — `{}` and `null` would
    // make a replayed card and a rehydrated one compare unequal.
    assert.strictEqual(decodeBoardCard(legacy).modelOverrides, null);
    // The same guarantee for the per-card base branch: migration
    // 036's `base_branch` column defaults to NULL, and a card created before
    // this spec genuinely HAD no base branch, so replaying its payload must
    // reach null — "follow the project default" — rather than any branch name.
    assert.strictEqual(decodeBoardCard(legacy).baseBranch, null);
    // Migration 057's `merge_strategy` defaults to NULL, so an older
    // payload replays to "follow the default".
    assert.strictEqual(decodeBoardCard(legacy).mergeStrategy, null);
  });

  it("T3O-39: decodes a card written with the older overrides struct", () => {
    // `runThroughRound` needs no migration: every field of the struct carries
    // a decoding default, so a card whose recorded overrides predate this
    // spec replays to exactly what a rehydrated row reads.
    const withOldOverrides = {
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
      attachments: [],
      externalRef: null,
      blocked: false,
      archivedAt: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      reviewOverrides: { rounds: 5, stopAfterRound: 2, roundModels: {} },
    };
    const decoded = decodeBoardCard(withOldOverrides);
    assert.strictEqual(decoded.reviewOverrides?.runThroughRound, null);
    // And the fields it DID carry are untouched: a decoding default must not
    // rewrite the card's own settings.
    assert.strictEqual(decoded.reviewOverrides?.rounds, 5);
    assert.strictEqual(decoded.reviewOverrides?.stopAfterRound, 2);
  });
});

/**
 * The single definition of a usable review-loop payload, asked by both the completion
 * handler and the decider.
 */
describe("boardStepPayloadDefect", () => {
  it("rejects a review step that recorded no payload", () => {
    const defect = boardStepPayloadDefect({ stepId: "review@10", payload: null });
    assert.isNotNull(defect);
    // Actionable, and specific about the mistake that causes it: the payload
    // belongs in its own argument, not folded into the summary.
    assert.include(defect ?? "", "review@10");
    assert.include(defect ?? "", "reviewedSha");
    assert.include(defect ?? "", "payload");
  });

  it("rejects a review payload of the wrong shape", () => {
    assert.isNotNull(
      boardStepPayloadDefect({ stepId: "review@1", payload: JSON.stringify({ notes: "lgtm" }) }),
    );
    // Findings without the SHA is still the wrong shape — the round has to say
    // what it read, or a later round cannot tell whether the base moved.
    assert.isNotNull(
      boardStepPayloadDefect({ stepId: "review@1", payload: JSON.stringify({ findings: [] }) }),
    );
  });

  it("accepts a review payload with a valid, empty findings list", () => {
    // The distinction the whole loop turns on: an empty findings list is a
    // CONVERGED round, and must not be confused with an unreadable one.
    assert.isNull(
      boardStepPayloadDefect({
        stepId: "review@1",
        payload: JSON.stringify({ reviewedSha: "abc123", findings: [] }),
      }),
    );
  });

  it("accepts an already-stringified payload, which is what agents send", () => {
    // Storage unwraps one level, so the check has to read the same way
    // or it would reject exactly the payloads that fix made readable.
    assert.isNull(
      boardStepPayloadDefect({
        stepId: "review@1",
        payload: JSON.stringify(JSON.stringify({ reviewedSha: "abc123", findings: [] })),
      }),
    );
  });

  it("holds every review-loop phase to its own declared shape", () => {
    assert.isNull(
      boardStepPayloadDefect({
        stepId: "triage@2",
        payload: JSON.stringify({ fixedSha: "def456", dispositions: [] }),
      }),
    );
    assert.isNotNull(boardStepPayloadDefect({ stepId: "triage@2", payload: null }));
    assert.isNull(
      boardStepPayloadDefect({
        stepId: "adjudicate@2",
        payload: JSON.stringify({ verdicts: [] }),
      }),
    );
    assert.isNotNull(boardStepPayloadDefect({ stepId: "adjudicate@2", payload: null }));
    assert.isNull(
      boardStepPayloadDefect({ stepId: "sync@2", payload: JSON.stringify({ rebasedSha: "aaa" }) }),
    );
    assert.isNotNull(boardStepPayloadDefect({ stepId: "sync@2", payload: null }));
  });

  it("asks nothing of a step outside the review loop", () => {
    // Every other step's payload is opaque to the board, so a building
    // step that reports nothing structured is a perfectly ordinary success.
    assert.isNull(boardStepPayloadDefect({ stepId: "building", payload: null }));
    assert.isNull(boardStepPayloadDefect({ stepId: "planning", payload: '"done"' }));
  });
});

describe("an unreadable loop is held (T3O-14)", () => {
  it("counts as an ending that never passed", () => {
    // It always ended the loop without a pass — the executor has refused to
    // converge on an unreadable payload — but it was missing from
    // this list, so the one ending that needs a human MOST was the only one the
    // column card never flagged.
    assert.isTrue(isBoardReviewLoopHeld("unreadable"));
    assert.isTrue(isBoardReviewLoopHeld("round-cap"));
    assert.isTrue(isBoardReviewLoopHeld("stopped"));
    assert.isFalse(isBoardReviewLoopHeld("converged"));
    assert.isFalse(isBoardReviewLoopHeld("running"));
  });

  it("says which ending it was", () => {
    assert.strictEqual(boardReviewHeldLabel("unreadable"), "Unreadable");
    assert.strictEqual(boardReviewHeldLabel("stopped"), "Stopped");
    assert.strictEqual(boardReviewHeldLabel("round-cap"), "No convergence");
  });

  it("reopens the round it halted on once the broken record is superseded", () => {
    // The recovery, end to end at the walk: a `succeeded` review with an
    // unreadable payload halts the loop; replacing that record with a `failed`
    // one (what the pane's Reopen does) puts the round back in front of it.
    const broken = boardReviewLoopWalk({
      completions: [completion("review@1", undefined)],
      maxRounds: 5,
      stopAfterRound: null,
      runThroughRound: null,
    });
    assert.strictEqual(broken.status, "unreadable");
    assert.strictEqual(broken.currentRound, 1);

    const reopened = boardReviewLoopWalk({
      completions: [completion("review@1", undefined, "failed")],
      maxRounds: 5,
      stopAfterRound: null,
      runThroughRound: null,
    });
    assert.strictEqual(reopened.status, "running");
    assert.deepStrictEqual(reopened.next, { phase: "review", round: 1 });

    // And repairing it in place — the auto-repair path — moves the loop on to
    // the triage the deadlock was blocking.
    const repaired = boardReviewLoopWalk({
      completions: [
        completion("review@1", { reviewedSha: "abc123", findings: [finding("improvement")] }),
      ],
      maxRounds: 5,
      stopAfterRound: null,
      runThroughRound: null,
    });
    assert.strictEqual(repaired.status, "running");
    assert.deepStrictEqual(repaired.next, { phase: "triage", round: 1 });
  });
});

describe("T3O-51: a ruling binds inside its round", () => {
  const sha = (round: number) => `sha-${round}`;
  const triage = (
    round: number,
    actions: Record<string, "fixed" | "rejected">,
    fixedSha = sha(round),
  ) =>
    completion(`triage@${round}`, {
      fixedSha,
      dispositions: Object.entries(actions).map(([findingId, action]) => ({
        findingId,
        action,
        note: `${action} it`,
      })),
    });
  const adjudicate = (
    round: number,
    verdicts: Record<string, string>,
    anotherRound: boolean | "absent" = true,
    phase: "adjudicate" | "readjudicate" = "adjudicate",
  ) =>
    completion(`${phase}@${round}`, {
      verdicts: Object.entries(verdicts).map(([findingId, verdict]) => ({
        findingId,
        verdict,
        note: `ruled ${verdict}`,
      })),
      ...(anotherRound === "absent" ? {} : { anotherRound }),
    });
  const retriage = (
    round: number,
    actions: Record<string, "fixed" | "rejected" | "escalated">,
    fixedSha = sha(round),
  ) =>
    completion(`retriage@${round}`, {
      fixedSha,
      dispositions: Object.entries(actions).map(([findingId, action]) => ({
        findingId,
        action,
        note: `re-${action}`,
      })),
    });
  const readjudicate = (round: number, verdicts: Record<string, string>, anotherRound = true) =>
    adjudicate(round, verdicts, anotherRound, "readjudicate");

  type Carry = Parameters<typeof boardReviewLoopWalk>[0]["carriedFindings"];
  const walkWith = (
    completions: ReadonlyArray<BoardStepCompletion>,
    options: {
      maxRounds?: number;
      stopAfterRound?: number | null;
      runThroughRound?: number | null;
      carriedFindings?: Carry;
      stuckWaivedThrough?: number | null;
    } = {},
  ) =>
    boardReviewLoopWalk({
      completions,
      maxRounds: options.maxRounds ?? 10,
      stopAfterRound: options.stopAfterRound ?? null,
      runThroughRound: options.runThroughRound ?? null,
      carriedFindings: options.carriedFindings ?? {},
      stuckWaivedThrough: options.stuckWaivedThrough ?? null,
    });

  /** Z5-291's round: rejected, ruled unjustified, rejected again. */
  const disputedRound = (round: number) => [
    review(round, [finding("critical", "f1")]),
    triage(round, { f1: "rejected" }),
    adjudicate(round, { f1: "rejection-unjustified" }),
  ];

  const carriedFix = (round: number, origRound = round - 1) => ({
    [String(round)]: {
      ruling: "fix" as const,
      note: null,
      findings: [
        {
          findingId: `carried:r${origRound}:f1`,
          origRound,
          severity: "critical" as const,
          title: "critical thing",
          file: "src/x.ts",
          line: 1,
          detail: "",
          rulingNote: "ruled fix-incomplete",
        },
      ],
    },
  });

  it("Z5-291: a rejection overruled twice stops the loop stuck in round 1", () => {
    const completions = [
      ...disputedRound(1),
      retriage(1, { f1: "rejected" }),
      readjudicate(1, { f1: "rejection-unjustified" }),
    ];
    const result = walkWith(completions);
    assert.strictEqual(result.status, "stuck");
    assert.strictEqual(result.currentRound, 1);
    assert.deepStrictEqual(
      result.stuckFindings?.map((f) => [f.findingId, f.round, f.triageAction, f.rulingVerdict]),
      [["f1", 1, "rejected", "rejection-unjustified"]],
    );
    // Stuck beats the budget on the last round.
    assert.strictEqual(walkWith(completions, { maxRounds: 1 }).status, "stuck");
    assert.isTrue(isBoardReviewLoopHeld("stuck"));
    assert.strictEqual(boardReviewHeldLabel("stuck"), "Stuck");
  });

  it("runs re-triage on the overruled findings, then re-adjudicate", () => {
    assert.deepStrictEqual(walkWith(disputedRound(1)).next, { phase: "retriage", round: 1 });
    assert.deepStrictEqual(walkWith([...disputedRound(1), retriage(1, { f1: "fixed" })]).next, {
      phase: "readjudicate",
      round: 1,
    });
  });

  it("continues when the second pass settles the dispute", () => {
    const justified = [
      ...disputedRound(1),
      retriage(1, { f1: "rejected" }),
      readjudicate(1, { f1: "rejection-justified" }),
    ];
    assert.deepStrictEqual(walkWith(justified).next, { phase: "review", round: 2 });
    const refixed = [
      ...disputedRound(1),
      retriage(1, { f1: "fixed" }),
      readjudicate(1, { f1: "fix-upheld" }),
    ];
    assert.deepStrictEqual(walkWith(refixed).next, { phase: "review", round: 2 });
  });

  it("goes stuck when a re-fix is still incomplete", () => {
    const result = walkWith([
      ...disputedRound(1),
      retriage(1, { f1: "fixed" }),
      readjudicate(1, { f1: "fix-incomplete" }),
    ]);
    assert.strictEqual(result.status, "stuck");
    assert.strictEqual(result.unreviewedFixes, 1);
  });

  it("an escalation stops the round with no re-adjudication", () => {
    const result = walkWith([...disputedRound(1), retriage(1, { f1: "escalated" })]);
    assert.strictEqual(result.status, "stuck");
    assert.strictEqual(result.stuckFindings?.[0]?.triageAction, "escalated");
  });

  it("a missing re-triage disposition is stuck, not settled", () => {
    assert.strictEqual(walkWith([...disputedRound(1), retriage(1, {})]).status, "stuck");
  });

  it("never re-triages an overruled nitpick", () => {
    const completions = [
      review(1, [finding("critical", "f1"), finding("nitpick", "n1")]),
      triage(1, { f1: "fixed", n1: "rejected" }),
      adjudicate(1, { f1: "fix-upheld", n1: "rejection-unjustified" }),
    ];
    assert.deepStrictEqual(walkWith(completions).next, { phase: "review", round: 2 });
  });

  it("finishes the round before stopping on one stuck finding beside fixed ones", () => {
    const completions = [
      review(1, [finding("critical", "f1"), finding("improvement", "f2")]),
      triage(1, { f1: "rejected", f2: "fixed" }),
      adjudicate(1, { f1: "rejection-unjustified", f2: "fix-upheld" }),
    ];
    assert.deepStrictEqual(walkWith(completions).next, { phase: "retriage", round: 1 });
    const result = walkWith([...completions, retriage(1, { f1: "escalated" })]);
    assert.strictEqual(result.status, "stuck");
    assert.deepStrictEqual(
      result.stuckFindings?.map((f) => f.findingId),
      ["f1"],
    );
    assert.strictEqual(result.unreviewedFixes, 1);
  });

  it("a gate round gets the second pass like a budget round", () => {
    const completions = [
      review(1, []),
      completion("sync@1", { rebasedSha: "rebased" }),
      ...disputedRound(2),
    ];
    assert.deepStrictEqual(walkWith(completions, { maxRounds: 1 }).next, {
      phase: "retriage",
      round: 2,
    });
  });

  it("keeps the old rule for an adjudication written before T3O-51", () => {
    const old = [
      review(1, [finding("critical", "f1")]),
      triage(1, { f1: "rejected" }),
      adjudicate(1, { f1: "rejection-unjustified" }, "absent"),
    ];
    assert.deepStrictEqual(walkWith(old).next, { phase: "review", round: 2 });
    // A held round-cap card stays round-cap and plans nothing.
    assert.strictEqual(walkWith(old, { maxRounds: 1 }).status, "round-cap");
  });

  it("never plans a second pass behind a recorded next review", () => {
    const completions = [...disputedRound(1), review(2, [])];
    assert.strictEqual(walkWith(completions).status, "converged");
  });

  describe("anotherRound=false", () => {
    const settledRound = (extra: ReadonlyArray<BoardStepCompletion> = []) => [
      review(1, [finding("critical", "f1")]),
      triage(1, { f1: "rejected" }),
      adjudicate(1, { f1: "rejection-justified" }, false),
      ...extra,
    ];

    it("converges when nothing changed and every blocking finding was rightly rejected", () => {
      const result = walkWith(settledRound());
      assert.strictEqual(result.status, "converged");
      assert.strictEqual(result.convergedBy, "adjudicator");
    });

    it("still converges when only nitpick fixes landed", () => {
      const result = walkWith([
        review(1, [finding("critical", "f1"), finding("nitpick", "n1")]),
        triage(1, { f1: "rejected", n1: "fixed" }, "new-sha"),
        adjudicate(1, { f1: "rejection-justified", n1: "fix-upheld" }, false),
      ]);
      assert.strictEqual(result.status, "converged");
    });

    it("is refused when a blocking fix landed", () => {
      const result = walkWith([
        review(1, [finding("critical", "f1")]),
        triage(1, { f1: "fixed" }, "new-sha"),
        adjudicate(1, { f1: "fix-upheld" }, false),
      ]);
      assert.deepStrictEqual(result.next, { phase: "review", round: 2 });
    });

    it("a blocking fix with no new commit does not count as landed", () => {
      const result = walkWith([
        review(1, [finding("critical", "f1")]),
        triage(1, { f1: "fixed" }, "sha-1"),
        adjudicate(1, { f1: "fix-upheld" }, false),
      ]);
      assert.strictEqual(result.status, "converged");
    });

    it("is refused when triage pushed a commit while fixing nothing", () => {
      const result = walkWith([
        review(1, [finding("critical", "f1")]),
        triage(1, { f1: "rejected" }, "other-sha"),
        adjudicate(1, { f1: "rejection-justified" }, false),
      ]);
      assert.deepStrictEqual(result.next, { phase: "review", round: 2 });
    });

    it("is refused while a blocking finding is still open", () => {
      const result = walkWith([
        review(1, [finding("critical", "f1"), finding("critical", "f2")]),
        triage(1, { f1: "rejected" }),
        adjudicate(1, { f1: "rejection-justified" }, false),
      ]);
      assert.deepStrictEqual(result.next, { phase: "review", round: 2 });
    });

    it("matches abbreviated SHAs", () => {
      const result = walkWith([
        completion("review@1", {
          reviewedSha: "abcdef1234",
          findings: [finding("critical", "f1")],
        }),
        triage(1, { f1: "rejected" }, "abcdef1"),
        adjudicate(1, { f1: "rejection-justified" }, false),
      ]);
      assert.strictEqual(result.status, "converged");
    });

    it("a requested round outranks the early exit", () => {
      assert.deepStrictEqual(walkWith(settledRound(), { runThroughRound: 2 }).next, {
        phase: "review",
        round: 2,
      });
    });

    it("the re-adjudication's flag wins over the first one's", () => {
      const completions = [
        review(1, [finding("critical", "f1")]),
        triage(1, { f1: "rejected" }),
        adjudicate(1, { f1: "rejection-unjustified" }, true),
        retriage(1, { f1: "rejected" }),
        readjudicate(1, { f1: "rejection-justified" }, false),
      ];
      assert.strictEqual(walkWith(completions).status, "converged");
      const flipped = [
        review(1, [finding("critical", "f1")]),
        triage(1, { f1: "rejected" }),
        adjudicate(1, { f1: "rejection-unjustified" }, false),
        retriage(1, { f1: "rejected" }),
        readjudicate(1, { f1: "rejection-justified" }, true),
      ];
      assert.deepStrictEqual(walkWith(flipped).next, { phase: "review", round: 2 });
    });
  });

  describe("passing a stuck round", () => {
    const stuckRound = [
      ...disputedRound(1),
      retriage(1, { f1: "rejected" }),
      readjudicate(1, { f1: "rejection-unjustified" }),
    ];

    it("a plain requested round does not pass it; a waiver does", () => {
      assert.strictEqual(walkWith(stuckRound, { runThroughRound: 2 }).status, "stuck");
      const advanced = walkWith(stuckRound, { stuckWaivedThrough: 1 });
      assert.strictEqual(advanced.status, "advanced");
      assert.strictEqual(advanced.currentRound, 1);
      assert.isFalse(isBoardReviewLoopHeld("advanced"));
      assert.deepStrictEqual(
        walkWith(stuckRound, { stuckWaivedThrough: 1, runThroughRound: 2 }).next,
        { phase: "review", round: 2 },
      );
    });

    it("a recorded sync still gates a waived round", () => {
      assert.deepStrictEqual(
        walkWith([...stuckRound, completion("sync@1", { rebasedSha: "r" })], {
          stuckWaivedThrough: 1,
        }).next,
        { phase: "review", round: 2 },
      );
    });
  });

  describe("carried findings", () => {
    // Round 1 stuck; the human's Fix it waived it and carried f1 into round 2.
    const round1 = [...disputedRound(1), retriage(1, { f1: "escalated" })];
    const fixIt = { stuckWaivedThrough: 1, runThroughRound: 2 } as const;
    it("a carried fix joins the round even when the reviewer omits it", () => {
      const carried = carriedFix(2);
      const completions = [...round1, review(2, [])];
      assert.deepStrictEqual(walkWith(completions, { ...fixIt, carriedFindings: carried }).next, {
        phase: "triage",
        round: 2,
      });
      assert.deepStrictEqual(
        walkWith([...completions, triage(2, { "carried:r1:f1": "fixed" })], {
          ...fixIt,
          carriedFindings: carried,
        }).next,
        { phase: "adjudicate", round: 2 },
      );
    });

    it("an upheld carried fix continues to a fresh round", () => {
      const result = walkWith(
        [
          ...round1,
          review(2, []),
          triage(2, { "carried:r1:f1": "fixed" }, "new"),
          adjudicate(2, { "carried:r1:f1": "fix-upheld" }),
        ],
        { ...fixIt, carriedFindings: carriedFix(2), maxRounds: 2 },
      );
      // Not round-cap: the walk's caller floors the budget past a landed fix.
      assert.strictEqual(result.status, "round-cap");
      assert.strictEqual(
        effectiveBoardReviewRounds({
          configured: 2,
          overrides: {
            rounds: null,
            stopAfterRound: null,
            roundModels: {},
            runThroughRound: 2,
            carriedFindings: carriedFix(2),
            stuckWaivedThrough: 1,
            roundModes: {},
          },
          roundsStarted: 2,
          completions: [review(2, []), triage(2, { "carried:r1:f1": "fixed" }, "new")],
        }),
        3,
      );
    });

    it("an incomplete carried fix gets re-triage, then sticks if still incomplete", () => {
      const base = [
        ...round1,
        review(2, []),
        triage(2, { "carried:r1:f1": "fixed" }),
        adjudicate(2, { "carried:r1:f1": "fix-incomplete" }),
      ];
      const opts = { ...fixIt, carriedFindings: carriedFix(2) };
      assert.deepStrictEqual(walkWith(base, opts).next, { phase: "retriage", round: 2 });
      const upheld = [
        ...base,
        retriage(2, { "carried:r1:f1": "fixed" }),
        readjudicate(2, { "carried:r1:f1": "fix-upheld" }),
      ];
      assert.deepStrictEqual(walkWith(upheld, opts).next, { phase: "review", round: 3 });
      const again = [
        ...base,
        retriage(2, { "carried:r1:f1": "fixed" }),
        readjudicate(2, { "carried:r1:f1": "fix-incomplete" }),
      ];
      const result = walkWith(again, opts);
      assert.strictEqual(result.status, "stuck");
      assert.strictEqual(result.stuckFindings?.[0]?.carriedFrom, 1);
    });

    it("a reviewer id that collides with a carried id is read once, as the carried one", () => {
      const result = walkWith(
        [
          ...round1,
          review(2, [finding("nitpick", "carried:r1:f1")]),
          triage(2, { "carried:r1:f1": "fixed" }),
        ],
        { ...fixIt, carriedFindings: carriedFix(2) },
      );
      // Still blocking — the carried finding forces adjudication.
      assert.deepStrictEqual(result.next, { phase: "adjudicate", round: 2 });
    });

    it("a dismissal never forces blocking or stuck", () => {
      const dismissed = {
        "2": { ...carriedFix(2)["2"]!, ruling: "dismiss" as const },
      };
      assert.strictEqual(
        walkWith([...round1, review(2, [])], { ...fixIt, carriedFindings: dismissed }).status,
        "converged",
      );
    });

    it("the latest ruling per finding wins", () => {
      const fix = carriedFix(2)["2"]!;
      const both = {
        "2": { ...fix, ruling: "dismiss" as const },
        "4": fix,
      };
      assert.deepStrictEqual(
        boardReviewDismissals(both, 3).map((d) => d.findingId),
        ["carried:r1:f1"],
      );
      assert.deepStrictEqual(boardReviewDismissals(both, 4), []);
      const reversed = { "2": fix, "4": { ...fix, ruling: "dismiss" as const } };
      assert.deepStrictEqual(boardReviewDismissals(reversed, 3), []);
      assert.strictEqual(boardReviewDismissals(reversed, 4).length, 1);
    });

    it("two Fix its in a row reach a fresh round and replay never re-blocks", () => {
      const stuckCarry = (round: number) => [
        review(round, []),
        triage(round, { "carried:r1:f1": "fixed" }),
        adjudicate(round, { "carried:r1:f1": "fix-incomplete" }),
        retriage(round, { "carried:r1:f1": "escalated" }),
      ];
      const carried = { ...carriedFix(2), ...carriedFix(3, 1) };
      const completions = [
        ...disputedRound(1),
        retriage(1, { f1: "escalated" }),
        ...stuckCarry(2),
        ...stuckCarry(3),
      ];
      assert.strictEqual(
        walkWith(completions, { carriedFindings: carried, stuckWaivedThrough: 2 }).status,
        "stuck",
      );
      assert.deepStrictEqual(
        walkWith(completions, {
          carriedFindings: carried,
          stuckWaivedThrough: 3,
          runThroughRound: 4,
        }).next,
        { phase: "review", round: 4 },
      );
    });
  });

  describe("the summary", () => {
    it("resolves by the latest pass and counts escalations in the latest round", () => {
      const summary = deriveBoardCardReviewSummary({
        completions: [...disputedRound(1), retriage(1, { f1: "escalated" })],
        maxRounds: null,
        stopAfterRound: null,
        runThroughRound: null,
      });
      assert.strictEqual(summary?.outcome, "stuck");
      assert.strictEqual(summary?.issuesEscalated, 1);
      assert.strictEqual(summary?.issuesDisputed, 0);
    });

    it("an advanced loop carries its round and unreviewed fixes", () => {
      const summary = deriveBoardCardReviewSummary({
        completions: [
          review(1, [finding("critical", "f1"), finding("critical", "f2")]),
          triage(1, { f1: "rejected", f2: "fixed" }),
          adjudicate(1, { f1: "rejection-unjustified", f2: "fix-upheld" }),
          retriage(1, { f1: "escalated" }),
        ],
        maxRounds: null,
        stopAfterRound: null,
        runThroughRound: null,
        stuckWaivedThrough: 1,
      });
      assert.strictEqual(summary?.outcome, "advanced");
      assert.strictEqual(summary?.advancedRound, 1);
      assert.strictEqual(summary?.unreviewedFixes, 1);
    });

    it("a carried finding resolves once, as its latest pass", () => {
      const summary = deriveBoardCardReviewSummary({
        completions: [
          ...disputedRound(1),
          retriage(1, { f1: "escalated" }),
          review(2, []),
          triage(2, { "carried:r1:f1": "fixed" }),
          adjudicate(2, { "carried:r1:f1": "fix-upheld" }),
        ],
        maxRounds: null,
        stopAfterRound: null,
        runThroughRound: 2,
        carriedFindings: carriedFix(2),
        stuckWaivedThrough: 1,
      });
      assert.strictEqual(summary?.severityCritical, 1);
      assert.strictEqual(summary?.issuesFixed, 1);
      assert.strictEqual(summary?.issuesEscalated, 0);
    });

    it("decodes a summary written before T3O-51", () => {
      const decoded = decodeReviewSummary({
        roundCurrent: 1,
        roundMax: null,
        outcome: "converged",
        heldOutcome: "round-cap",
        roundComplete: true,
        severityCritical: 0,
        severityImprovement: 0,
        severityNitpick: 0,
        issuesFixed: 0,
        issuesRejected: 0,
        issuesOpen: 0,
        issuesDisputed: 0,
      });
      assert.strictEqual(decoded.issuesEscalated, 0);
      assert.strictEqual(decoded.advancedRound, null);
    });
  });

  it("holds the follow-up phases to their own payload shapes", () => {
    assert.isNotNull(
      boardStepPayloadDefect({ stepId: "retriage@1", payload: JSON.stringify({ verdicts: [] }) }),
    );
    assert.isNull(
      boardStepPayloadDefect({
        stepId: "retriage@1",
        payload: JSON.stringify({
          fixedSha: "a",
          dispositions: [{ findingId: "f", action: "escalated", note: "" }],
        }),
      }),
    );
    assert.isNull(
      boardStepPayloadDefect({
        stepId: "readjudicate@1",
        payload: JSON.stringify({ verdicts: [], anotherRound: false }),
      }),
    );
    // Only re-triage may escalate.
    assert.isNotNull(
      boardStepPayloadDefect({
        stepId: "triage@1",
        payload: JSON.stringify({
          fixedSha: "a",
          dispositions: [{ findingId: "f", action: "escalated", note: "" }],
        }),
      }),
    );
  });

  describe("T3O-55: only the adjudicator escalates", () => {
    const escalatedRound = (round: number) => [
      review(round, [finding("critical", "f1")]),
      triage(round, { f1: "rejected" }),
      adjudicate(round, { f1: "escalated" }),
    ];

    it("a first-pass escalation is stuck straight away, with no re-triage", () => {
      const result = walkWith(escalatedRound(1));
      assert.strictEqual(result.status, "stuck");
      assert.isNull(result.next);
      assert.deepStrictEqual(
        result.stuckFindings?.map((f) => [
          f.findingId,
          f.triageAction,
          f.rulingVerdict,
          f.rulingNote,
        ]),
        [["f1", "rejected", "escalated", "ruled escalated"]],
      );
    });

    it("stuck wins whatever anotherRound says", () => {
      const result = walkWith([
        review(1, [finding("critical", "f1")]),
        triage(1, { f1: "rejected" }, "sha-1"),
        adjudicate(1, { f1: "escalated" }, false),
      ]);
      assert.strictEqual(result.status, "stuck");
    });

    it("an overruled finding beside an escalation still gets its second pass first", () => {
      const completions = [
        review(1, [finding("critical", "f1"), finding("critical", "f2")]),
        triage(1, { f1: "rejected", f2: "rejected" }),
        adjudicate(1, { f1: "escalated", f2: "rejection-unjustified" }),
      ];
      assert.deepStrictEqual(walkWith(completions).next, { phase: "retriage", round: 1 });
      const disputed = walkWith([
        ...completions,
        retriage(1, { f2: "rejected" }),
        readjudicate(1, { f2: "rejection-unjustified" }),
      ]);
      assert.strictEqual(disputed.status, "stuck");
      assert.deepStrictEqual(
        disputed.stuckFindings?.map((f) => f.findingId),
        ["f1", "f2"],
      );
      const settled = walkWith([
        ...completions,
        retriage(1, { f2: "fixed" }),
        readjudicate(1, { f2: "fix-upheld" }),
      ]);
      assert.deepStrictEqual(
        settled.stuckFindings?.map((f) => f.findingId),
        ["f1"],
      );
    });

    it("a re-adjudicator's escalation is stuck", () => {
      const result = walkWith([
        ...disputedRound(1),
        retriage(1, { f1: "rejected" }),
        readjudicate(1, { f1: "escalated" }),
      ]);
      assert.strictEqual(result.status, "stuck");
      assert.strictEqual(result.stuckFindings?.[0]?.rulingVerdict, "escalated");
    });

    it("a carried finding triage cannot fix ends stuck once the adjudicator rules it absent", () => {
      const ruled = [
        review(1, []),
        triage(1, { "carried:r0:f1": "rejected" }),
        adjudicate(1, { "carried:r0:f1": "fix-absent" }),
      ];
      const carriedFindings = carriedFix(1, 0);
      assert.deepStrictEqual(walkWith(ruled, { carriedFindings }).next, {
        phase: "retriage",
        round: 1,
      });
      const result = walkWith(
        [
          ...ruled,
          retriage(1, { "carried:r0:f1": "rejected" }),
          readjudicate(1, { "carried:r0:f1": "fix-absent" }),
        ],
        { carriedFindings },
      );
      assert.strictEqual(result.status, "stuck");
    });

    it("the summary counts an adjudicator's escalation", () => {
      const summary = deriveBoardCardReviewSummary({
        completions: escalatedRound(1),
        maxRounds: null,
        stopAfterRound: null,
        runThroughRound: null,
      });
      assert.strictEqual(summary?.outcome, "stuck");
      assert.strictEqual(summary?.issuesEscalated, 1);
      assert.strictEqual(summary?.issuesDisputed, 0);
    });

    describe("new completions", () => {
      const defect = (
        stepId: string,
        payload: unknown,
        completions: ReadonlyArray<BoardStepCompletion>,
        carriedFindings: Carry = {},
      ) =>
        boardReviewCompletionDefect({
          stepId,
          payload: JSON.stringify(payload),
          completions,
          carriedFindings: carriedFindings ?? {},
        });
      const verdicts = (entries: Record<string, [string, string]>) => ({
        verdicts: Object.entries(entries).map(([findingId, [verdict, note]]) => ({
          findingId,
          verdict,
          note,
        })),
        anotherRound: true,
      });
      const dispositions = (entries: Record<string, [string, string]>) => ({
        fixedSha: "sha-1",
        dispositions: Object.entries(entries).map(([findingId, [action, note]]) => ({
          findingId,
          action,
          note,
        })),
      });
      const firstPass = [
        review(1, [finding("critical", "f1"), finding("nitpick", "n1")]),
        triage(1, { f1: "rejected", n1: "rejected" }),
      ];
      const carryRound = [review(1, [])];
      const carried = carriedFix(1, 0);

      it("refuses a re-triage escalation", () => {
        assert.include(
          defect("retriage@1", dispositions({ f1: ["escalated", "I disagree"] }), disputedRound(1)),
          "cannot escalate",
        );
        assert.isNull(
          defect("retriage@1", dispositions({ f1: ["rejected", "still wrong"] }), disputedRound(1)),
        );
      });

      it("lets triage reject a carried finding only with a reason", () => {
        assert.isNull(
          defect(
            "triage@1",
            dispositions({ "carried:r0:f1": ["rejected", "the API does not exist"] }),
            carryRound,
            carried,
          ),
        );
        assert.include(
          defect(
            "triage@1",
            dispositions({ "carried:r0:f1": ["rejected", " "] }),
            carryRound,
            carried,
          ),
          "genuinely cannot be done",
        );
      });

      it("holds an escalation to a reason, a blocking finding, and no human order", () => {
        assert.isNull(
          defect("adjudicate@1", verdicts({ f1: ["escalated", "scope call"] }), firstPass),
        );
        assert.include(
          defect("adjudicate@1", verdicts({ f1: ["escalated", ""] }), firstPass),
          "needs a note",
        );
        assert.include(
          defect(
            "adjudicate@1",
            verdicts({ f1: ["rejection-justified", "ok"], n1: ["escalated", "why"] }),
            firstPass,
          ),
          "'n1'",
        );
        assert.include(
          defect(
            "adjudicate@1",
            verdicts({ "carried:r0:f1": ["escalated", "why"] }),
            [...carryRound, triage(1, { "carried:r0:f1": "rejected" })],
            carried,
          ),
          "'carried:r0:f1'",
        );
        assert.include(
          defect(
            "adjudicate@1",
            verdicts({ "carried:r0:f1": ["escalated", "why"] }),
            [completion("review@1", "not json"), triage(1, { "carried:r0:f1": "rejected" })],
            carried,
          ),
          "'carried:r0:f1'",
        );
        assert.isNull(
          defect("readjudicate@1", verdicts({ f1: ["escalated", "owner's risk"] }), [
            ...disputedRound(1),
            retriage(1, { f1: "rejected" }),
          ]),
        );
      });

      it("refuses blocked on triage and adjudication only, and answers their questions", () => {
        for (const stepId of ["triage@1", "retriage@2", "adjudicate@1", "readjudicate@1"]) {
          assert.isNotNull(boardReviewBlockedOutcomeRefusal(stepId), stepId);
          assert.isNotNull(boardReviewQuestionAnswer(stepId), stepId);
        }
        for (const stepId of ["review@1", "sync@1", "building", "planning"]) {
          assert.isNull(boardReviewBlockedOutcomeRefusal(stepId), stepId);
          assert.isNull(boardReviewQuestionAnswer(stepId), stepId);
        }
      });
    });
  });

  it("halts on an unreadable follow-up record", () => {
    const result = walkWith([...disputedRound(1), completion("retriage@1", { nope: true })]);
    assert.strictEqual(result.status, "unreadable");
    assert.strictEqual(result.unreadableStepId, "retriage@1");
  });
});

describe("T3O-64: settling rounds", () => {
  const SETTLING = { settleAfterRound: 3, settleBelowFindings: 2 } as const;
  const triage = (round: number, actions: Record<string, "fixed" | "rejected">, fixedSha: string) =>
    completion(`triage@${round}`, {
      fixedSha,
      dispositions: Object.entries(actions).map(([findingId, action]) => ({
        findingId,
        action,
        note: `${action} it`,
      })),
    });
  const ruling = (
    phase: "adjudicate" | "readjudicate",
    round: number,
    verdicts: Record<string, string>,
    anotherRound: boolean | "absent" = false,
  ) =>
    completion(`${phase}@${round}`, {
      verdicts: Object.entries(verdicts).map(([findingId, verdict]) => ({
        findingId,
        verdict,
        note: `ruled ${verdict}`,
      })),
      ...(anotherRound === "absent" ? {} : { anotherRound }),
    });
  /** A round whose findings were each fixed past the reviewed SHA and upheld: a full round
      continues on it, because no review has read the fix. */
  const fixedRound = (
    round: number,
    findings: ReadonlyArray<BoardReviewFinding>,
  ): BoardStepCompletion[] => [
    review(round, findings),
    triage(
      round,
      Object.fromEntries(findings.map((f) => [f.id, "fixed" as const])),
      `fix-${round}`,
    ),
    ruling("adjudicate", round, Object.fromEntries(findings.map((f) => [f.id, "fix-upheld"]))),
  ];
  const improvements = (round: number, count = 1) =>
    Array.from({ length: count }, (_, i) => finding("improvement", `r${round}i${i}`));
  /** Rounds 1–3 each raised and fixed one improvement. */
  const firstThree = [1, 2, 3].flatMap((round) => fixedRound(round, improvements(round)));
  const overrides = (
    roundModes: BoardCardReviewOverrides["roundModes"] = {},
    rest: Partial<BoardCardReviewOverrides> = {},
  ): BoardCardReviewOverrides => ({
    ...EMPTY_BOARD_CARD_REVIEW_OVERRIDES,
    ...rest,
    roundModes,
  });
  const modeOf = (
    round: number,
    completions: ReadonlyArray<BoardStepCompletion>,
    cardOverrides: BoardCardReviewOverrides | null = null,
    settings: { settleAfterRound: number | null; settleBelowFindings: number } = SETTLING,
  ) => boardReviewNextRoundMode({ round, completions, review: settings, overrides: cardOverrides });
  const settlingSince = (sha: string) => ({ kind: "settling" as const, sinceSha: sha });
  const walkModes = (
    completions: ReadonlyArray<BoardStepCompletion>,
    roundModes: BoardCardReviewOverrides["roundModes"],
    carriedFindings: Parameters<typeof boardReviewLoopWalk>[0]["carriedFindings"] = {},
  ) =>
    boardReviewLoopWalk({
      completions,
      maxRounds: 10,
      stopAfterRound: null,
      runThroughRound: null,
      carriedFindings,
      roundModes,
    });

  describe("the mode rule", () => {
    it("keeps the first rounds full, whatever they raised", () => {
      const twoRounds = [1, 2].flatMap((round) => fixedRound(round, improvements(round)));
      assert.deepStrictEqual(modeOf(3, twoRounds), { kind: "full" });
      assert.deepStrictEqual(modeOf(2, fixedRound(1, [])), { kind: "full" });
    });

    it("settles round 4 after a round 3 with fewer than two forcing findings", () => {
      assert.deepStrictEqual(modeOf(4, firstThree), settlingSince("sha-3"));
      // A clean round 3 has none at all.
      const clean = [...firstThree.slice(0, 6), review(3, [])];
      assert.deepStrictEqual(modeOf(4, clean), settlingSince("sha-3"));
    });

    it("keeps round 4 full after a round 3 with two forcing findings", () => {
      const busy = [...firstThree.slice(0, 6), ...fixedRound(3, improvements(3, 2))];
      assert.deepStrictEqual(modeOf(4, busy), { kind: "full" });
      // A higher bar settles the same round.
      assert.deepStrictEqual(
        modeOf(4, busy, null, { settleAfterRound: 3, settleBelowFindings: 3 }),
        settlingSince("sha-3"),
      );
    });

    it("does not count a finding ruled rejection-justified, first time or on readjudication", () => {
      const [a, b] = improvements(3, 2) as [BoardReviewFinding, BoardReviewFinding];
      const head = firstThree.slice(0, 6);
      const rejectedOnce = [
        ...head,
        review(3, [a, b]),
        triage(3, { [a.id]: "fixed", [b.id]: "rejected" }, "fix-3"),
        ruling("adjudicate", 3, { [a.id]: "fix-upheld", [b.id]: "rejection-justified" }),
      ];
      assert.deepStrictEqual(modeOf(4, rejectedOnce), settlingSince("sha-3"));
      const rejectedOnSecondPass = [
        ...head,
        review(3, [a, b]),
        triage(3, { [a.id]: "fixed", [b.id]: "rejected" }, "fix-3"),
        ruling("adjudicate", 3, { [a.id]: "fix-upheld", [b.id]: "rejection-unjustified" }),
        completion("retriage@3", {
          fixedSha: "fix-3",
          dispositions: [{ findingId: b.id, action: "rejected", note: "still wrong" }],
        }),
        ruling("readjudicate", 3, { [b.id]: "rejection-justified" }),
      ];
      assert.deepStrictEqual(modeOf(4, rejectedOnSecondPass), settlingSince("sha-3"));
    });

    it("counts only criticals and carried findings after a settling round", () => {
      const settledFour = { "4": settlingSince("sha-3") };
      const twoImprovements = [...firstThree, ...fixedRound(4, improvements(4, 2))];
      assert.deepStrictEqual(
        modeOf(5, twoImprovements, overrides(settledFour)),
        settlingSince("sha-4"),
      );
      // Re-evaluated every round: two criticals send the loop back to full review.
      const twoCriticals = [
        ...firstThree,
        ...fixedRound(4, [finding("critical", "c1"), finding("critical", "c2")]),
      ];
      assert.deepStrictEqual(modeOf(5, twoCriticals, overrides(settledFour)), { kind: "full" });
      // Without the record, round 4 was full, so its two improvements counted.
      assert.deepStrictEqual(modeOf(5, twoImprovements), { kind: "full" });
    });

    it("keeps a gate round, a legacy round and an unreadable round full", () => {
      const synced = [...firstThree, completion("sync@3", { rebasedSha: "rebased" })];
      assert.deepStrictEqual(modeOf(4, synced), { kind: "full" });
      const legacy = [
        ...firstThree.slice(0, 6),
        review(3, improvements(3)),
        triage(3, { r3i0: "fixed" }, "fix-3"),
        ruling("adjudicate", 3, { r3i0: "fix-upheld" }, "absent"),
      ];
      assert.deepStrictEqual(modeOf(4, legacy), { kind: "full" });
    });

    it("returns a recorded mode unchanged, whatever the settings say now", () => {
      assert.deepStrictEqual(modeOf(4, firstThree, overrides({ "4": { kind: "full" } })), {
        kind: "full",
      });
      assert.deepStrictEqual(
        modeOf(4, [], overrides({ "4": settlingSince("abc") }), {
          settleAfterRound: null,
          settleBelowFindings: 2,
        }),
        settlingSince("abc"),
      );
    });

    it("never settles with settling off", () => {
      assert.deepStrictEqual(
        modeOf(4, firstThree, null, { settleAfterRound: null, settleBelowFindings: 2 }),
        { kind: "full" },
      );
    });

    it("lets a Fix it round follow the rule like any other", () => {
      // Round 3 stuck on one critical a human then ordered fixed: one forcing finding.
      const stuckThree = [
        ...firstThree.slice(0, 6),
        review(3, [finding("critical", "c1")]),
        triage(3, { c1: "rejected" }, "sha-3"),
        ruling("adjudicate", 3, { c1: "escalated" }),
      ];
      assert.deepStrictEqual(modeOf(4, stuckThree), settlingSince("sha-3"));
    });

    it("reads a round with no record as full", () => {
      assert.deepStrictEqual(boardReviewRoundModeOf(null, 4), { kind: "full" });
      assert.deepStrictEqual(boardReviewRoundModeOf(overrides({ "3": settlingSince("a") }), 4), {
        kind: "full",
      });
    });

    it("counts a finished round's forcing findings", () => {
      assert.strictEqual(
        boardReviewRoundForcingCount({ round: 3, completions: firstThree, overrides: null }),
        1,
      );
      // A later round's review does not hide the count.
      assert.strictEqual(
        boardReviewRoundForcingCount({
          round: 3,
          completions: [...firstThree, review(4, [])],
          overrides: null,
        }),
        1,
      );
    });
  });

  describe("a settling round's resolution", () => {
    const settledFour = { "4": settlingSince("sha-3") };

    it("converges `settled` once only improvements were raised and their fixes upheld", () => {
      const ledger = [...firstThree, ...fixedRound(4, improvements(4))];
      const settled = walkModes(ledger, settledFour);
      assert.strictEqual(settled.status, "converged");
      assert.strictEqual(settled.convergedBy, "settled");
      assert.strictEqual(settled.unreviewedFixes, 1);
      // The same ledger in a full round runs another review on the landed fix.
      assert.deepStrictEqual(walkModes(ledger, {}).next, { phase: "review", round: 5 });
    });

    it("still stalls on an improvement the adjudicator keeps overruling", () => {
      const [i] = improvements(4) as [BoardReviewFinding];
      const disputed = [
        ...firstThree,
        review(4, [i]),
        triage(4, { [i.id]: "rejected" }, "sha-4"),
        ruling("adjudicate", 4, { [i.id]: "rejection-unjustified" }),
      ];
      assert.deepStrictEqual(walkModes(disputed, settledFour).next, {
        phase: "retriage",
        round: 4,
      });
      const unresolved = [
        ...disputed,
        completion("retriage@4", {
          fixedSha: "sha-4",
          dispositions: [{ findingId: i.id, action: "rejected", note: "no" }],
        }),
        ruling("readjudicate", 4, { [i.id]: "rejection-unjustified" }),
      ];
      assert.strictEqual(walkModes(unresolved, settledFour).status, "stuck");
    });

    it("continues when a critical's fix landed", () => {
      const ledger = [
        ...firstThree,
        ...fixedRound(4, [finding("critical", "c1"), ...improvements(4)]),
      ];
      assert.deepStrictEqual(walkModes(ledger, settledFour).next, { phase: "review", round: 5 });
    });

    it("continues when a carried finding's fix landed", () => {
      const carried = {
        "4": {
          ruling: "fix" as const,
          note: null,
          findings: [
            {
              findingId: "carried:r3:f1",
              origRound: 3,
              severity: "improvement" as const,
              title: "carried thing",
              file: null,
              line: null,
              detail: "",
              rulingNote: "",
            },
          ],
        },
      };
      const ledger = [
        ...firstThree,
        review(4, []),
        triage(4, { "carried:r3:f1": "fixed" }, "fix-4"),
        ruling("adjudicate", 4, { "carried:r3:f1": "fix-upheld" }),
      ];
      assert.deepStrictEqual(walkModes(ledger, settledFour, carried).next, {
        phase: "review",
        round: 5,
      });
    });

    it("summarises a loop that converged `settled` as converged", () => {
      const ledger = [...firstThree, ...fixedRound(4, improvements(4))];
      const summary = deriveBoardCardReviewSummary({
        completions: ledger,
        maxRounds: null,
        stopAfterRound: null,
        runThroughRound: null,
        roundModes: settledFour,
      });
      assert.strictEqual(summary?.outcome, "converged");
      assert.strictEqual(
        deriveBoardCardReviewSummary({
          completions: ledger,
          maxRounds: null,
          stopAfterRound: null,
          runThroughRound: null,
        })?.outcome,
        "running",
      );
    });

    it("says `anotherRound` has no effect when a settling adjudication omits it", () => {
      const ledger = [...firstThree, review(4, improvements(4)), triage(4, { r4i0: "fixed" }, "x")];
      const payload = JSON.stringify({ verdicts: [{ findingId: "r4i0", verdict: "fix-upheld" }] });
      const settling = boardReviewCompletionDefect({
        stepId: "adjudicate@4",
        payload,
        completions: ledger,
        carriedFindings: {},
        roundModes: settledFour,
      });
      assert.include(settling ?? "", "no effect");
      const full = boardReviewCompletionDefect({
        stepId: "adjudicate@4",
        payload,
        completions: ledger,
        carriedFindings: {},
      });
      assert.notInclude(full ?? "", "no effect");
    });
  });

  describe("decoding older records", () => {
    it("decodes old overrides, stage config and review payloads", () => {
      assert.deepStrictEqual(decodeOverrides({ rounds: 5 }).roundModes, {});
      const stage = decodeReviewStage({ kind: "review" });
      assert.strictEqual(stage.settleAfterRound, 3);
      assert.strictEqual(stage.settleBelowFindings, 2);
      assert.strictEqual(
        decodeReviewStage({
          kind: "review",
          settleAfterRound: null,
        }).settleAfterRound,
        null,
      );
      assert.isUndefined(decodeReviewPayload({ reviewedSha: "a", findings: [] }).scope);
      assert.throws(() =>
        decodeReviewStage({
          kind: "review",
          settleBelowFindings: 1,
        }),
      );
    });
  });
});
