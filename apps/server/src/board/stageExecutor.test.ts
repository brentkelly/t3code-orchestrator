/**
 * Unit tests for the stage executor seam (t3o-15, D15 — acceptance criterion
 * 19): `SimpleStageExecutor.planNext` is exercised with **no reactor, no
 * database and no git**. Nothing here constructs an Effect, opens a connection
 * or shells out; the whole point of the seam is that "what runs next" is a pure
 * decision over its inputs, testable in isolation exactly like `recoveryDecision`
 * and `reconcileStepDecision`.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_BOARD_STAGE_EXECUTION,
  ProviderInstanceId,
  type BoardModelSelection,
  type BoardStepCompletion,
} from "@t3tools/contracts";

import {
  SimpleStageExecutor,
  stageExecutorForRole,
  type BoardStageExecutorConfig,
} from "./stageExecutor.ts";
import { ReviewLoopExecutor } from "./reviewLoopExecutor.ts";
import { makeBoardCard } from "./supervisorHarness.testkit.ts";

const model: BoardModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const config = (overrides: Partial<BoardStageExecutorConfig> = {}): BoardStageExecutorConfig => ({
  stepId: "building",
  label: "Building",
  prompt: "Implement the card's brief.",
  model,
  timeoutMs: 600_000,
  maxAttempts: 3,
  execution: DEFAULT_BOARD_STAGE_EXECUTION,
  ...overrides,
});

const card = makeBoardCard({ id: "card-1", stage: "building", orderKey: "a0" });

describe("SimpleStageExecutor.planNext (D15)", () => {
  it("yields the stage's single seeded step when the run has completed nothing", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config(),
      completions: [],
      runState: { round: 1, completedStepIds: [] },
    });

    expect(plan).toEqual({
      kind: "run",
      round: 1,
      stepId: "building",
      label: "Building",
      prompt: "Implement the card's brief.",
      model,
      timeoutMs: 600_000,
      maxAttempts: 3,
    });
  });

  it("stamps the executor's round onto the step it hands back", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config(),
      completions: [],
      runState: { round: 4, completedStepIds: [] },
    });

    expect(plan.kind).toBe("run");
    if (plan.kind === "run") expect(plan.round).toBe(4);
  });

  it("reports complete as soon as the single step has succeeded this run", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config(),
      completions: [],
      runState: { round: 1, completedStepIds: ["building"] },
    });

    expect(plan).toEqual({ kind: "complete", outcome: "succeeded" });
  });

  it("resolves complete/run from run progress, not from the card's all-time completions", () => {
    // A prior visit's succeeded completion (D7 re-entry) is the reactor's
    // concern, not the executor's: with nothing completed in THIS run the
    // executor still yields the step to run.
    const priorSuccess: BoardStepCompletion = {
      cardId: card.id,
      stepId: "building",
      outcome: "succeeded",
      summary: "done last time",
      payload: null,
      threadId: null,
      completedAt: "2026-08-20T00:00:00.000Z",
    };

    const plan = SimpleStageExecutor.planNext({
      card,
      config: config(),
      completions: [priorSuccess],
      runState: { round: 1, completedStepIds: [] },
    });

    expect(plan.kind).toBe("run");
  });

  it("passes the config's step id, label, prompt and model through unchanged", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config({ stepId: "triage", label: "Triage", prompt: "Assess it.", maxAttempts: 1 }),
      completions: [],
      runState: { round: 2, completedStepIds: [] },
    });

    expect(plan).toEqual({
      kind: "run",
      round: 2,
      stepId: "triage",
      label: "Triage",
      prompt: "Assess it.",
      model,
      timeoutMs: 600_000,
      maxAttempts: 1,
    });
  });
});

describe("stageExecutorForRole registry (D15 / t3o-16)", () => {
  it("routes the review role to the review loop and every other role to the simple executor", () => {
    expect(stageExecutorForRole("build")).toBe(SimpleStageExecutor);
    expect(stageExecutorForRole("review")).toBe(ReviewLoopExecutor);
    expect(stageExecutorForRole("done")).toBe(SimpleStageExecutor);
    expect(stageExecutorForRole(null)).toBe(SimpleStageExecutor);
  });
});
