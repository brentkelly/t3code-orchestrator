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
  BOARD_SUBMIT_STEP_ID,
  DEFAULT_BOARD_STAGE_EXECUTION,
  ProviderInstanceId,
  type BoardModelSelection,
  type BoardStepCompletion,
} from "@t3tools/contracts";

import {
  BuildStageExecutor,
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
  stageLabel: "Building",
  prompt: "Implement the card's brief.",
  model,
  cardOverride: null,
  timeoutMs: 600_000,
  maxAttempts: 3,
  runtimeMode: "auto",
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
      runState: {
        round: 1,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: null,
        baseStale: false,
      },
    });

    expect(plan).toEqual({
      kind: "run",
      round: 1,
      stepId: "building",
      // No step identity (t3o-19, D4): the stage runs one step, so naming it
      // would just echo the stage.
      stepLabel: null,
      prompt: "Implement the card's brief.",
      model,
      runtimeMode: "auto",
      timeoutMs: 600_000,
      maxAttempts: 3,
      recordBaseTip: false,
    });
  });

  it("stamps the executor's round onto the step it hands back", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config(),
      completions: [],
      runState: {
        round: 4,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: null,
        baseStale: false,
      },
    });

    expect(plan.kind).toBe("run");
    if (plan.kind === "run") expect(plan.round).toBe(4);
  });

  it("reports complete as soon as the single step has succeeded this run", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config(),
      completions: [],
      runState: {
        round: 1,
        completedStepIds: ["building"],
        liveStepId: null,
        settledStepId: null,
        baseStale: false,
      },
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
      runState: {
        round: 1,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: null,
        baseStale: false,
      },
    });

    expect(plan.kind).toBe("run");
  });

  it("passes the config's step id, label, prompt and model through unchanged", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config({
        stepId: "triage",
        stageLabel: "Triage",
        prompt: "Assess it.",
        maxAttempts: 1,
      }),
      completions: [],
      runState: {
        round: 2,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: null,
        baseStale: false,
      },
    });

    expect(plan).toEqual({
      kind: "run",
      round: 2,
      stepId: "triage",
      // A single-step stage plans NO step identity (t3o-19, D4) — the stage's
      // own label would only echo itself in the prompt.
      stepLabel: null,
      prompt: "Assess it.",
      model,
      runtimeMode: "auto",
      timeoutMs: 600_000,
      maxAttempts: 1,
      recordBaseTip: false,
    });
  });
});

describe("per-card model overrides (t3o-29)", () => {
  const override = {
    instanceId: ProviderInstanceId.make("anthropic"),
    model: "claude-opus-5",
    options: [{ id: "reasoning", value: "high" }],
  } as const;

  it("AC1: runs the stage's single step on the card's override instead of the workspace model", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config({ cardOverride: override }),
      completions: [],
      runState: {
        round: 1,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: null,
        baseStale: false,
      },
    });

    expect(plan).toMatchObject({
      kind: "run",
      model: { instanceId: override.instanceId, model: override.model, options: override.options },
    });
  });

  it("keeps the stage's access level when the override names a model but no level", () => {
    // An override says only what it changes: naming a model must not silently
    // drag the run down to some default authority.
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config({ cardOverride: override, runtimeMode: "approval-required" }),
      completions: [],
      runState: {
        round: 1,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: null,
        baseStale: false,
      },
    });

    expect(plan).toMatchObject({ kind: "run", runtimeMode: "approval-required" });
  });

  it("takes the override's access level when it names one", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config({
        cardOverride: { ...override, runtimeMode: "approval-required" },
        runtimeMode: "auto",
      }),
      completions: [],
      runState: {
        round: 1,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: null,
        baseStale: false,
      },
    });

    expect(plan).toMatchObject({ kind: "run", runtimeMode: "approval-required" });
  });

  it("runs the workspace model when the card overrides nothing", () => {
    const plan = SimpleStageExecutor.planNext({
      card,
      config: config({ cardOverride: null }),
      completions: [],
      runState: {
        round: 1,
        completedStepIds: [],
        liveStepId: null,
        settledStepId: null,
        baseStale: false,
      },
    });

    expect(plan).toMatchObject({ kind: "run", model, runtimeMode: "auto" });
  });
});

/**
 * The build executor (t3o-07, D4/D5). Pure over its run state, like everything
 * else in this file: what it decides is "did the SUBMIT step just settle?", and
 * nothing else about the card can answer that question for it.
 */
describe("BuildStageExecutor.planNext (t3o-07, D4/D5)", () => {
  const submitCompletion: BoardStepCompletion = {
    cardId: card.id,
    stepId: BOARD_SUBMIT_STEP_ID,
    outcome: "succeeded",
    summary: "opened PR #12",
    payload: null,
    threadId: null,
    completedAt: "2026-01-01T00:00:00.000Z",
  };

  it("routes the card to the merge role when the submit step is the one that settled", () => {
    const plan = BuildStageExecutor.planNext({
      card,
      config: config(),
      completions: [submitCompletion],
      runState: {
        round: 1,
        completedStepIds: ["building", BOARD_SUBMIT_STEP_ID],
        liveStepId: null,
        settledStepId: BOARD_SUBMIT_STEP_ID,
        baseStale: false,
      },
    });

    // `advanceToRole` is what steps over Code review; without it the stage
    // would end toward the next stage in order, which IS Code review.
    expect(plan).toEqual({ kind: "complete", outcome: "succeeded", advanceToRole: "merge" });
  });

  it("delegates to the simple executor when the ordinary build step settled", () => {
    const runState = {
      round: 1,
      completedStepIds: ["building"],
      liveStepId: null,
      settledStepId: "building",
      baseStale: false,
    };
    const input = { card, config: config(), completions: [], runState };

    // Identical to what the simple executor says, and — crucially — carrying no
    // `advanceToRole`, so the reactor's ordinary auto-advance runs.
    expect(BuildStageExecutor.planNext(input)).toEqual(SimpleStageExecutor.planNext(input));
    expect(BuildStageExecutor.planNext(input)).toEqual({
      kind: "complete",
      outcome: "succeeded",
    });
  });

  it("delegates on stage entry, where nothing has settled at all", () => {
    const runState = {
      round: 1,
      completedStepIds: [],
      liveStepId: null,
      settledStepId: null,
      baseStale: false,
    };
    const input = { card, config: config(), completions: [], runState };

    expect(BuildStageExecutor.planNext(input)).toEqual(SimpleStageExecutor.planNext(input));
    expect(BuildStageExecutor.planNext(input).kind).toBe("run");
  });

  // The regression D5 names. Completions are keyed `(cardId, stepId)` and never
  // cleared, so a card dragged back to Building for a SECOND build still
  // carries the submit completion from its first pass. Routing on that
  // completion would send the rebuild straight to the merge stage the moment it
  // finished — skipping review on a card nobody asked to skip review for.
  it("does NOT route on a stale submit COMPLETION when a rebuild is what settled", () => {
    const plan = BuildStageExecutor.planNext({
      card,
      config: config(),
      completions: [submitCompletion],
      runState: {
        round: 1,
        completedStepIds: ["building", BOARD_SUBMIT_STEP_ID],
        liveStepId: null,
        // The BUILD step just settled; the submit completion is history.
        settledStepId: "building",
        baseStale: false,
      },
    });

    expect(plan).toEqual({ kind: "complete", outcome: "succeeded" });
    expect("advanceToRole" in plan).toBe(false);
  });

  it("does not route when some OTHER step settled, even with the submit step recorded", () => {
    const plan = BuildStageExecutor.planNext({
      card,
      config: config(),
      completions: [submitCompletion],
      runState: {
        round: 1,
        completedStepIds: [BOARD_SUBMIT_STEP_ID],
        liveStepId: null,
        settledStepId: "review@1",
        baseStale: false,
      },
    });

    // Nothing recorded for the stage's own step, so the simple executor plans a
    // run — the point being only that no directed advance was emitted.
    expect(plan.kind).toBe("run");
  });
});

describe("stageExecutorForRole registry (D15 / t3o-16 / t3o-07)", () => {
  it("routes review to the loop, build to the build executor, and every other role to the simple one", () => {
    expect(stageExecutorForRole("build")).toBe(BuildStageExecutor);
    expect(stageExecutorForRole("review")).toBe(ReviewLoopExecutor);
    expect(stageExecutorForRole("done")).toBe(SimpleStageExecutor);
    expect(stageExecutorForRole(null)).toBe(SimpleStageExecutor);
  });
});
