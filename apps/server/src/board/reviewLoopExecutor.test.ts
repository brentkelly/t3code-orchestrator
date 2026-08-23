/**
 * Unit tests for the review-loop executor (t3o-16, acceptance criterion 9):
 * `ReviewLoopExecutor.planNext` is a PURE decision over a completions array —
 * no reactor, no database, no git, no thread. Every criterion the loop owns is
 * expressible as "these completions in, this decision out":
 *
 *  - AC3  a clean review pass completes the stage after ONE phase.
 *  - AC4  a nitpick-only review pass also converges.
 *  - AC5  a card needing two rounds runs distinct `<phase>@<round>` steps.
 *  - AC7  exhausting the round cap completes the stage `blocked`.
 *  - AC8  a malformed/absent review payload never reads as "no findings".
 */
import { describe, expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import {
  BoardStageExecution,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  ProviderInstanceId,
  isBoardReviewBlockingSeverity,
  parseReviewStepId,
  reviewStepId,
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
): BoardStagePlan =>
  ReviewLoopExecutor.planNext({
    card,
    config: config(execution ?? DEFAULT_BOARD_REVIEW_STAGE_EXECUTION),
    completions,
    runState: { round: 1, completedStepIds: completions.map((c) => c.stepId) },
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

  it("AC4: a nitpick-only review pass also converges", () => {
    const result = plan([completion("review@1", reviewPayload([finding("nitpick")]))]);
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

  it("AC7: exhausting the round cap completes the stage blocked", () => {
    const oneRound = reviewExec({ rounds: 1 });
    const capped = plan(
      [
        completion("review@1", reviewPayload([finding("critical")])),
        completion("triage@1", { fixedSha: "s1", dispositions: [] }),
        completion("adjudicate@1", { verdicts: [] }),
      ],
      oneRound,
    );
    expect(capped).toEqual({ kind: "complete", outcome: "blocked" });
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
      runState: { round: 1, completedStepIds: [] },
    });
    expect(result.kind === "run" && result.stepId).toBe("review@1");
  });
});
