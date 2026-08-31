/**
 * Unit tests for the review-loop executor (t3o-16, acceptance criterion 9):
 * `ReviewLoopExecutor.planNext` is a PURE decision over a completions array —
 * no reactor, no database, no git, no thread. Every criterion the loop owns is
 * expressible as "these completions in, this decision out":
 *
 *  - AC3  a clean review pass completes the stage after ONE phase.
 *  - AC4  a nitpick-only review pass runs ONE triage pass, then converges —
 *         the nitpick gets its chance to be fixed, but never spawns a round.
 *  - AC5  a card needing two rounds runs distinct `<phase>@<round>` steps.
 *  - AC7  exhausting the round cap ends the loop `blocked` (t3o-22, D1) — the
 *         loop check is the executor's, and only the CONVERGENCE arm of it
 *         reports success. A loop that merely ran out of budget carries a
 *         converged loop's round counts and the opposite meaning, so it must
 *         never reach `advanceStage`, which is gated on `succeeded`.
 *  - AC8  a malformed/absent review payload never reads as "no findings".
 *
 * t3o-22 adds the per-card controls that hang off the same decision:
 *
 *  - the round budget is the card's own when it has one, floored at the highest
 *    round already STARTED so a shrinking budget can never strand a live run;
 *  - "stop after round N" holds the loop even with budget remaining;
 *  - a per-round model override re-points the REVIEW phase alone.
 */
import { describe, expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import {
  BoardStageExecution,
  boardReviewLoopWalk,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  ProviderInstanceId,
  isBoardReviewBlockingSeverity,
  parseReviewStepId,
  reviewStepId,
  type BoardCardReviewOverrides,
  type BoardModelSelection,
  type BoardReviewFinding,
  type BoardStageExecutionReview,
  type BoardStepCompletion,
} from "@t3tools/contracts";

import { ReviewLoopExecutor } from "./reviewLoopExecutor.ts";
import type { BoardStageExecutorConfig, BoardStagePlan } from "./stageExecutor.ts";
import { makeBoardCard } from "./supervisorHarness.testkit.ts";

const globalModel: BoardModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const card = makeBoardCard({ id: "card-1", stage: "review", orderKey: "a0" });

const config = (
  execution: BoardStageExecutionReview = DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
): BoardStageExecutorConfig => ({
  stepId: "review",
  stageLabel: "Code review",
  prompt: "",
  model: globalModel,
  timeoutMs: 600_000,
  maxAttempts: 3,
  runtimeMode: "auto",
  execution,
});

const reviewExec = (patch: Partial<BoardStageExecutionReview> = {}): BoardStageExecutionReview =>
  ({ ...DEFAULT_BOARD_REVIEW_STAGE_EXECUTION, ...patch }) as BoardStageExecutionReview;

const completion = (
  stepId: string,
  payload: unknown,
  outcome: BoardStepCompletion["outcome"] = "succeeded",
): BoardStepCompletion => ({
  cardId: card.id,
  stepId,
  outcome,
  summary: `did ${stepId}`,
  payload:
    payload === undefined ? null : typeof payload === "string" ? payload : JSON.stringify(payload),
  threadId: null,
  completedAt: "2026-08-20T00:00:00.000Z",
});

const finding = (severity: BoardReviewFinding["severity"], id = "f1"): BoardReviewFinding => ({
  id,
  severity,
  file: "src/x.ts",
  line: 1,
  title: `${severity} thing`,
  detail: "",
});

const reviewPayload = (findings: ReadonlyArray<BoardReviewFinding>) => ({
  reviewedSha: "sha-review",
  findings,
});

const plan = (
  completions: ReadonlyArray<BoardStepCompletion>,
  execution?: BoardStageExecutionReview,
  overrides: BoardCardReviewOverrides | null = null,
  liveStepId: string | null = null,
): BoardStagePlan =>
  ReviewLoopExecutor.planNext({
    card: { ...card, reviewOverrides: overrides },
    config: config(execution ?? DEFAULT_BOARD_REVIEW_STAGE_EXECUTION),
    completions,
    runState: {
      round: 1,
      completedStepIds: completions.map((c) => c.stepId),
      liveStepId,
    },
  });

const overrides = (patch: Partial<BoardCardReviewOverrides>): BoardCardReviewOverrides => ({
  rounds: null,
  stopAfterRound: null,
  roundModels: {},
  ...patch,
});

describe("reviewStepId / parseReviewStepId (D8)", () => {
  it("round-trips a round-scoped step id", () => {
    expect(reviewStepId("review", 2)).toBe("review@2");
    expect(parseReviewStepId("triage@3")).toEqual({ phase: "triage", round: 3 });
    expect(parseReviewStepId("review")).toBeNull();
    expect(parseReviewStepId("review@0")).toBeNull();
    expect(parseReviewStepId("building")).toBeNull();
  });
});

describe("blocking severity (D5)", () => {
  it("blocks on critical and improvement, never on nitpick", () => {
    expect(isBoardReviewBlockingSeverity("critical")).toBe(true);
    expect(isBoardReviewBlockingSeverity("improvement")).toBe(true);
    expect(isBoardReviewBlockingSeverity("nitpick")).toBe(false);
  });
});

describe("ReviewLoopExecutor.planNext (D1/D3)", () => {
  it("runs the first review at entry with no completions", () => {
    const result = plan([]);
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;
    expect(result.stepId).toBe("review@1");
    expect(result.round).toBe(1);
    expect(result.model).toEqual(globalModel);
    expect(result.prompt).toContain("round 1");
  });

  it("AC3: a clean review pass completes the stage after one phase", () => {
    const result = plan([completion("review@1", reviewPayload([]))]);
    expect(result).toEqual({ kind: "complete", outcome: "succeeded" });
  });

  it("AC4: a nitpick-only review pass runs triage before converging", () => {
    // The nitpick never blocks, but triage is its one chance to be fixed — the
    // loop must not end before the author has seen it.
    const afterReview = plan([completion("review@1", reviewPayload([finding("nitpick")]))]);
    expect(afterReview.kind === "run" && afterReview.stepId).toBe("triage@1");
  });

  it("AC4: a nitpick-only round converges after triage, with no adjudication and no next round", () => {
    const result = plan([
      completion("review@1", reviewPayload([finding("nitpick")])),
      completion("triage@1", {
        fixedSha: "s",
        dispositions: [{ findingId: "f1", action: "fixed", note: "" }],
      }),
    ]);
    expect(result).toEqual({ kind: "complete", outcome: "succeeded" });
  });

  it("runs triage then adjudicate when a review pass raises a blocking finding", () => {
    const blocking = [completion("review@1", reviewPayload([finding("critical")]))];
    const afterReview = plan(blocking);
    expect(afterReview.kind === "run" && afterReview.stepId).toBe("triage@1");

    const afterTriage = plan([
      ...blocking,
      completion("triage@1", { fixedSha: "s", dispositions: [] }),
    ]);
    expect(afterTriage.kind === "run" && afterTriage.stepId).toBe("adjudicate@1");
  });

  it("AC5: a second round runs distinct <phase>@<round> steps and can then converge", () => {
    const roundOne = [
      completion("review@1", reviewPayload([finding("improvement")])),
      completion("triage@1", {
        fixedSha: "s1",
        dispositions: [{ findingId: "f1", action: "fixed", note: "" }],
      }),
      completion("adjudicate@1", {
        verdicts: [{ findingId: "f1", verdict: "fix-upheld", note: "" }],
      }),
    ];
    const afterRoundOne = plan(roundOne);
    expect(afterRoundOne.kind).toBe("run");
    if (afterRoundOne.kind !== "run") return;
    expect(afterRoundOne.stepId).toBe("review@2");
    expect(afterRoundOne.round).toBe(2);

    const clean = plan([...roundOne, completion("review@2", reviewPayload([]))]);
    expect(clean).toEqual({ kind: "complete", outcome: "succeeded" });
  });

  const cappedRound = (round: number) => [
    completion(`review@${round}`, reviewPayload([finding("critical", `f${round}`)])),
    completion(`triage@${round}`, { fixedSha: `s${round}`, dispositions: [] }),
    completion(`adjudicate@${round}`, { verdicts: [] }),
  ];

  it("AC7: exhausting the round cap ends the loop BLOCKED, so the stage cannot auto-advance", () => {
    const oneRound = reviewExec({ rounds: 1 });
    const capped = plan(cappedRound(1), oneRound);
    // Nothing converged: the reviewer raised a critical and the budget simply
    // ran out. `advanceStage` is gated on `succeeded`, so `blocked` is what
    // keeps the card in Code review with its findings — the t3o-16 D8
    // guarantee that PR #40 inverted.
    expect(capped).toEqual({ kind: "complete", outcome: "blocked" });
  });

  it("AC7: a converged round still succeeds — the two exits stay distinguishable", () => {
    const oneRound = reviewExec({ rounds: 1 });
    // Same budget, same round count, no blocking finding: this one passed.
    const clean = plan([completion("review@1", reviewPayload([]))], oneRound);
    expect(clean).toEqual({ kind: "complete", outcome: "succeeded" });
  });

  it("t3o-22 D3: the card's own budget extends a loop that hit the cap", () => {
    const oneRound = reviewExec({ rounds: 1 });
    const held = cappedRound(1);
    expect(plan(held, oneRound)).toEqual({ kind: "complete", outcome: "blocked" });

    // Raising the card's budget is the whole "Run round 2" gesture: same
    // completions, same stage config, and now there is a round to run.
    const resumed = plan(held, oneRound, overrides({ rounds: 2 }));
    expect(resumed.kind).toBe("run");
    if (resumed.kind !== "run") return;
    expect(resumed.stepId).toBe("review@2");
  });

  it("t3o-22 D3: a budget below a round already RUN cannot strand it", () => {
    const fiveRounds = reviewExec({ rounds: 5 });
    const throughRound2 = [...cappedRound(1), ...cappedRound(2)];
    // The card asks for 1 round, but rounds 1 and 2 are already on the ledger.
    // The floor holds the budget at 2, so the loop reports the cap rather than
    // walking a range that excludes recorded history.
    expect(plan(throughRound2, fiveRounds, overrides({ rounds: 1 }))).toEqual({
      kind: "complete",
      outcome: "blocked",
    });
  });

  it("t3o-22 D3: the executor's own floor counts a round in flight, not just recorded", () => {
    const fiveRounds = reviewExec({ rounds: 5 });
    // Round 2's review is dispatched and running — no completion for it yet.
    // Flooring on completions alone would drop the budget to 1 and orphan it.
    // No reactor caller passes a live step today (each plans only when nothing
    // is running); this pins the executor's invariant so the walk stays correct
    // for whichever caller does.
    const inFlight = plan(cappedRound(1), fiveRounds, overrides({ rounds: 1 }), "review@2");
    expect(inFlight.kind).toBe("run");
    if (inFlight.kind !== "run") return;
    expect(inFlight.stepId).toBe("review@2");
  });

  it("t3o-22 D5: stop-after-round holds the loop even with budget remaining", () => {
    const fiveRounds = reviewExec({ rounds: 5 });
    const held = plan(cappedRound(1), fiveRounds, overrides({ stopAfterRound: 1 }));
    // Four rounds of budget are left; the user's stop outranks them, and it
    // terminates like the cap so nothing auto-advances.
    expect(held).toEqual({ kind: "complete", outcome: "blocked" });

    // Without the stop, the same completions run round 2.
    const running = plan(cappedRound(1), fiveRounds);
    expect(running.kind).toBe("run");
  });

  it("t3o-22 D5: a stop for a DIFFERENT round does not hold this one", () => {
    const fiveRounds = reviewExec({ rounds: 5 });
    const running = plan(cappedRound(1), fiveRounds, overrides({ stopAfterRound: 3 }));
    expect(running.kind).toBe("run");
  });

  it("t3o-22 D4: a round model override re-points the REVIEW phase only", () => {
    const opus: BoardModelSelection = {
      instanceId: ProviderInstanceId.make("anthropic"),
      model: "claude-opus-5",
    };
    const triageModel: BoardModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-mini",
    };
    const exec = reviewExec({
      rounds: 5,
      phases: {
        ...DEFAULT_BOARD_REVIEW_STAGE_EXECUTION.phases,
        triage: { ...DEFAULT_BOARD_REVIEW_STAGE_EXECUTION.phases.triage, model: triageModel },
      },
    } as Partial<BoardStageExecutionReview>);
    const withOverride = overrides({ roundModels: { "2": opus } });

    // Round 2's review runs on the override...
    const review2 = plan(cappedRound(1), exec, withOverride);
    expect(review2.kind).toBe("run");
    if (review2.kind !== "run") return;
    expect(review2.stepId).toBe("review@2");
    expect(review2.model).toEqual(opus);

    // ...while round 2's TRIAGE keeps its own configured model. Escalating the
    // reviewer and re-modelling the author are different decisions (D4).
    const triage2 = plan(
      [...cappedRound(1), completion("review@2", reviewPayload([finding("critical", "f2")]))],
      exec,
      withOverride,
    );
    expect(triage2.kind).toBe("run");
    if (triage2.kind !== "run") return;
    expect(triage2.stepId).toBe("triage@2");
    expect(triage2.model).toEqual(triageModel);
  });

  it("a round override's access level applies to that round's review alone", () => {
    const opus: BoardModelSelection = {
      instanceId: ProviderInstanceId.make("anthropic"),
      model: "claude-opus-5",
    };
    const exec = reviewExec({ rounds: 5 });
    const withOverride = overrides({
      roundModels: { "2": { ...opus, runtimeMode: "full-access" } },
    });

    // Round 1 has no override and runs on the phase's default (`auto`).
    const review1 = plan([], exec, withOverride);
    expect(review1.kind).toBe("run");
    if (review1.kind !== "run") return;
    expect(review1.runtimeMode).toBe("auto");

    // Round 2's review takes the override's level, and its model without the
    // level tagging along.
    const review2 = plan(cappedRound(1), exec, withOverride);
    expect(review2.kind).toBe("run");
    if (review2.kind !== "run") return;
    expect(review2.runtimeMode).toBe("full-access");
    expect(review2.model).toEqual(opus);

    // Round 2's triage keeps the phase's own level.
    const triage2 = plan(
      [...cappedRound(1), completion("review@2", reviewPayload([finding("critical", "f2")]))],
      exec,
      withOverride,
    );
    expect(triage2.kind).toBe("run");
    if (triage2.kind !== "run") return;
    expect(triage2.runtimeMode).toBe("auto");
  });

  it("t3o-22 D4: an un-overridden round inherits the stage's review model", () => {
    const exec = reviewExec({ rounds: 5 });
    const first = plan(
      [],
      exec,
      overrides({
        roundModels: {
          "4": { instanceId: ProviderInstanceId.make("anthropic"), model: "claude-opus-5" },
        },
      }),
    );
    expect(first.kind).toBe("run");
    if (first.kind !== "run") return;
    // Round 1 has no entry, so it falls through to the phase config's model
    // (null here) and then the stage's resolved fallback.
    expect(first.model).toEqual(globalModel);
  });

  // ── The differential the duplicated walk is justified on (t3o-22) ────
  //
  // `boardReviewLoopWalk` in contracts is a second copy of the phase walk
  // below, and the comment on it promises a test keeps the two honest. This is
  // that test — and it is only possible here, the one package that can import
  // both. It drives the SAME completions through each and asserts they reach
  // the same verdict, which is exactly the check that would have caught the
  // projection cache reporting `round-cap` where the executor plans round N+1.
  it("t3o-22: the contracts walk and the executor agree on every terminal verdict", () => {
    const scenarios: ReadonlyArray<{
      readonly name: string;
      readonly completions: ReadonlyArray<BoardStepCompletion>;
      readonly rounds: number;
      readonly stopAfterRound: number | null;
    }> = [
      { name: "nothing run yet", completions: [], rounds: 5, stopAfterRound: null },
      {
        name: "clean round 1",
        completions: [completion("review@1", reviewPayload([]))],
        rounds: 5,
        stopAfterRound: null,
      },
      {
        name: "nitpick-only, triaged",
        completions: [
          completion("review@1", reviewPayload([finding("nitpick")])),
          completion("triage@1", { fixedSha: "s", dispositions: [] }),
        ],
        rounds: 5,
        stopAfterRound: null,
      },
      {
        name: "mid-round: triage due",
        completions: [completion("review@1", reviewPayload([finding("critical")]))],
        rounds: 5,
        stopAfterRound: null,
      },
      {
        name: "mid-loop: round 2 due",
        completions: cappedRound(1),
        rounds: 5,
        stopAfterRound: null,
      },
      { name: "cap at 1", completions: cappedRound(1), rounds: 1, stopAfterRound: null },
      {
        name: "cap at 2",
        completions: [...cappedRound(1), ...cappedRound(2)],
        rounds: 2,
        stopAfterRound: null,
      },
      {
        name: "stopped at 1 with budget left",
        completions: cappedRound(1),
        rounds: 5,
        stopAfterRound: 1,
      },
      {
        name: "unreadable payload",
        completions: [completion("review@1", "{oops")],
        rounds: 5,
        stopAfterRound: null,
      },
    ];

    for (const scenario of scenarios) {
      const executorPlan = plan(
        scenario.completions,
        reviewExec({ rounds: scenario.rounds }),
        scenario.stopAfterRound === null
          ? null
          : overrides({ stopAfterRound: scenario.stopAfterRound }),
      );
      const contractsWalk = boardReviewLoopWalk({
        completions: scenario.completions,
        maxRounds: scenario.rounds,
        stopAfterRound: scenario.stopAfterRound,
      });

      // converged ⇔ succeeded; every held/halted ending ⇔ blocked; and while
      // the loop runs, both must name the SAME next phase and round.
      const walkAsPlan =
        contractsWalk.status === "converged"
          ? "succeeded"
          : contractsWalk.status === "running"
            ? "run"
            : "blocked";
      const executorAsPlan =
        executorPlan.kind === "run"
          ? "run"
          : executorPlan.kind === "complete"
            ? executorPlan.outcome
            : "escalate";
      expect(executorAsPlan, scenario.name).toBe(walkAsPlan);

      if (executorPlan.kind === "run" && contractsWalk.next !== null) {
        expect(executorPlan.stepId, scenario.name).toBe(
          reviewStepId(contractsWalk.next.phase, contractsWalk.next.round),
        );
        expect(executorPlan.round, scenario.name).toBe(contractsWalk.next.round);
      }
    }
  });

  it("AC8: a malformed review payload terminates blocked rather than converging", () => {
    const malformed = plan([completion("review@1", "{not json")]);
    // Never read as "no findings" (which would be complete/succeeded); the loop
    // terminates blocked so it neither passes unreviewed code nor wedges.
    expect(malformed).toEqual({ kind: "complete", outcome: "blocked" });
  });

  it("AC8: an absent review payload terminates blocked rather than converging", () => {
    const absent = plan([completion("review@1", undefined)]);
    expect(absent).toEqual({ kind: "complete", outcome: "blocked" });
  });

  it("AC8: a valid payload with an empty findings list converges (not confused with malformed)", () => {
    expect(plan([completion("review@1", reviewPayload([]))])).toEqual({
      kind: "complete",
      outcome: "succeeded",
    });
  });

  it("D2: each phase runs on its own model", () => {
    const triageModel: BoardModelSelection = {
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-opus-4-8",
    };
    const perPhase = reviewExec({
      phases: {
        ...DEFAULT_BOARD_REVIEW_STAGE_EXECUTION.phases,
        triage: { ...DEFAULT_BOARD_REVIEW_STAGE_EXECUTION.phases.triage, model: triageModel },
      },
    });
    // The review phase (no override) runs on the global model...
    const atReview = plan([], perPhase);
    expect(atReview.kind === "run" && atReview.model).toEqual(globalModel);
    // ...and the triage phase runs on its own model.
    const atTriage = plan([completion("review@1", reviewPayload([finding("critical")]))], perPhase);
    expect(atTriage.kind === "run" && atTriage.model).toEqual(triageModel);
  });

  it("falls back to the default review config when handed a non-review execution", () => {
    const simple = Schema.decodeSync(BoardStageExecution)({});
    const result = ReviewLoopExecutor.planNext({
      card,
      config: { ...config(), execution: simple },
      completions: [],
      runState: { round: 1, completedStepIds: [], liveStepId: null },
    });
    expect(result.kind === "run" && result.stepId).toBe("review@1");
  });
});
