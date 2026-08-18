import {
  ProviderInstanceId,
  type BoardCardStepState,
  type BoardResolvedRecipe,
  type BoardStep,
  type BoardStepCompletion,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  composeStepPrompt,
  providerQuestionMechanism,
  reconcileStepDecision,
  recoveryDecision,
  selectNextStep,
} from "./supervisor.ts";

const step = (overrides: Partial<BoardStep> = {}): BoardStep => ({
  id: "build",
  label: "Build",
  promptTemplate: "Implement the brief.",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
  timeoutMs: 1000,
  maxAttempts: 3,
  ...overrides,
});

const completion = (
  stepId: string,
  outcome: BoardStepCompletion["outcome"],
): BoardStepCompletion => ({
  cardId: "card-1" as BoardStepCompletion["cardId"],
  stepId,
  outcome,
  summary: "done",
  payload: null,
  threadId: null,
  completedAt: "2026-01-01T00:00:00.000Z",
});

describe("composeStepPrompt (D5 envelope)", () => {
  it("has preamble (card context), body (template) and postamble (completion contract)", () => {
    const prompt = composeStepPrompt({
      card: { key: "T3-1", title: "Ship it", stage: "building" },
      step: step(),
      attempt: 2,
    });
    // Preamble: card key, title, stage, step, attempt N of M, context pointer.
    assert.include(prompt, "T3-1");
    assert.include(prompt, "Ship it");
    assert.include(prompt, "attempt 2 of 3");
    assert.include(prompt, "board_get_card_context");
    // Body: the recipe's promptTemplate verbatim.
    assert.include(prompt, "Implement the brief.");
    // Postamble: the completion contract and the never-prose rule.
    assert.include(prompt, "board_complete_step");
    assert.include(prompt, "never end a turn with an unanswered question in prose");
  });

  it("words the question mechanism per provider instance", () => {
    const claudePrompt = composeStepPrompt({
      card: { key: "T3-1", title: "x", stage: "building" },
      step: step({ providerInstanceId: ProviderInstanceId.make("claude") }),
      attempt: 1,
    });
    assert.include(claudePrompt, "Claude Code question");
    const codexPrompt = composeStepPrompt({
      card: { key: "T3-1", title: "x", stage: "building" },
      step: step({ providerInstanceId: ProviderInstanceId.make("codex") }),
      attempt: 1,
    });
    assert.include(codexPrompt, "Codex");
    assert.notInclude(codexPrompt, "Claude Code question");
  });
});

describe("selectNextStep (D4)", () => {
  const recipe: BoardResolvedRecipe = {
    stage: "building",
    steps: [step({ id: "plan" }), step({ id: "build" })],
  };

  it("returns the first step with no successful completion", () => {
    assert.strictEqual(selectNextStep(recipe, [])?.id, "plan");
    assert.strictEqual(selectNextStep(recipe, [completion("plan", "succeeded")])?.id, "build");
  });

  it("does not skip a step that failed or blocked — recovery/gating owns it", () => {
    assert.strictEqual(selectNextStep(recipe, [completion("plan", "failed")])?.id, "plan");
    assert.strictEqual(selectNextStep(recipe, [completion("plan", "blocked")])?.id, "plan");
  });

  it("returns null when every step has succeeded", () => {
    assert.strictEqual(
      selectNextStep(recipe, [completion("plan", "succeeded"), completion("build", "succeeded")]),
      null,
    );
  });
});

describe("recoveryDecision (D13 escalation, bounded)", () => {
  const base = (
    attempt: number,
  ): Pick<BoardCardStepState, "attempt" | "maxAttempts" | "stepLabel"> => ({
    attempt,
    maxAttempts: 3,
    stepLabel: "Build",
  });

  it("resumes with a nudge within budget, adding an outstanding summary on later tries", () => {
    const first = recoveryDecision({ stepState: base(1), questionMechanism: "ask" });
    assert.strictEqual(first.kind, "resume");
    if (first.kind === "resume") {
      assert.strictEqual(first.attempt, 2);
      assert.notInclude(first.nudge, "outstanding");
    }
    const second = recoveryDecision({ stepState: base(2), questionMechanism: "ask" });
    assert.strictEqual(second.kind, "resume");
    if (second.kind === "resume") {
      assert.strictEqual(second.attempt, 3);
      assert.include(second.nudge, "outstanding");
    }
  });

  it("escalates to the human when the attempt budget is exhausted, and never loops", () => {
    const escalated = recoveryDecision({ stepState: base(3), questionMechanism: "ask" });
    assert.strictEqual(escalated.kind, "escalate");
    if (escalated.kind === "escalate") {
      assert.strictEqual(escalated.attempt, 4);
      assert.include(escalated.question, "retry");
      assert.include(escalated.question, "switch");
      assert.include(escalated.question, "manually");
    }
  });
});

describe("reconcileStepDecision (boot reconciliation)", () => {
  it("advances a step that completed while the server was down", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "running", threadAlive: false, hasSucceeded: true }),
      { kind: "advance" },
    );
  });

  it("resumes watching a running step whose thread is still alive", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "running", threadAlive: true, hasSucceeded: false }),
      { kind: "resume-watch" },
    );
  });

  it("recovers a running step whose thread is gone (routine, not an error)", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "running", threadAlive: false, hasSucceeded: false }),
      { kind: "recover" },
    );
  });

  it("keeps waiting on an awaiting-input step whose question thread survives", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "awaiting-input", threadAlive: true, hasSucceeded: false }),
      { kind: "resume-watch" },
    );
  });

  it("re-drives a queued/pending step (no live thread to watch)", () => {
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "queued", threadAlive: false, hasSucceeded: false }),
      { kind: "recover" },
    );
    assert.deepStrictEqual(
      reconcileStepDecision({ status: "pending", threadAlive: false, hasSucceeded: false }),
      { kind: "recover" },
    );
  });
});

describe("providerQuestionMechanism", () => {
  it("falls back to neutral wording for an unknown provider", () => {
    assert.include(
      providerQuestionMechanism(ProviderInstanceId.make("some-custom-runtime")),
      "user-input request",
    );
  });
});
