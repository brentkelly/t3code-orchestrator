/**
 * Plan review (T3O-39): the instructions the planning agent gets, the card and
 * settings resolution, and the completion report reader.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BOARD_PLAN_REVIEW_PROMPT,
  readBoardPlanReviewReport,
  resolveBoardCardPlanReview,
  resolveBoardPlanReviewSettings,
} from "./board.ts";
import {
  BOARD_ENVELOPE_QUESTION_MECHANISM,
  composePlanReviewInstructions,
  composeStepPrompt,
  fillPlanReviewRounds,
} from "./boardEnvelope.ts";

describe("composePlanReviewInstructions", () => {
  it("fills every {rounds} in the user's prompt", () => {
    const text = composePlanReviewInstructions({
      prompt: DEFAULT_BOARD_PLAN_REVIEW_PROMPT,
      rounds: 4,
      humanInLoop: true,
    });
    expect(text).not.toContain("{rounds}");
    expect(text).toContain("a maximum of 4 rounds of reviewing the plan");
    expect(text).toContain("maximum limit of 4 review rounds");
    expect(fillPlanReviewRounds("{rounds} and {rounds}", 2)).toBe("2 and 2");
  });

  it("puts the fixed closing after the user's text, so it wins", () => {
    const text = composePlanReviewInstructions({
      prompt: "USER TEXT: ask the user before every change.",
      rounds: 1,
      humanInLoop: true,
    });
    const user = text.indexOf("USER TEXT");
    const closing = text.indexOf("Board rules for the plan review");
    expect(user).toBeGreaterThan(text.indexOf("Plan review is on for this card: up to 1 round "));
    expect(closing).toBeGreaterThan(user);
    expect(text.slice(closing)).toContain("board_propose_plans");
    expect(text.slice(closing)).toContain("planReview: { roundsRun, converged }");
  });

  it("asks for sign-off with a human in the loop and finishes without asking when unattended", () => {
    const attended = composePlanReviewInstructions({ prompt: "p", rounds: 2, humanInLoop: true });
    expect(attended).toContain(BOARD_ENVELOPE_QUESTION_MECHANISM);
    expect(attended).toContain("wait for the human's sign-off");
    const unattended = composePlanReviewInstructions({
      prompt: "p",
      rounds: 2,
      humanInLoop: false,
    });
    expect(unattended).toContain("ask nothing");
    expect(unattended).not.toContain("sign-off");
  });
});

describe("composeStepPrompt with a plan review", () => {
  const base = {
    card: { key: "T3-1", title: "Card", stage: "planning" },
    stageLabel: "Planning",
    role: "plan" as const,
  };
  it("carries the instructions after the body, before the postamble", () => {
    const prompt = composeStepPrompt({
      ...base,
      step: {
        stepId: "planning",
        stepLabel: null,
        prompt: "PLAN BODY",
        humanInLoop: true,
        planReview: { instructions: "REVIEW INSTRUCTIONS" },
      },
    });
    expect(prompt.indexOf("REVIEW INSTRUCTIONS")).toBeGreaterThan(prompt.indexOf("PLAN BODY"));
    expect(prompt.indexOf("When the work is done")).toBeGreaterThan(
      prompt.indexOf("REVIEW INSTRUCTIONS"),
    );
  });

  it("leaves a prompt with no review untouched", () => {
    const prompt = composeStepPrompt({
      ...base,
      step: { stepId: "planning", stepLabel: null, prompt: "PLAN BODY", humanInLoop: true },
    });
    expect(prompt).not.toContain("Plan review is on");
  });
});

describe("plan review resolution", () => {
  it("fills the settings defaults and treats a blank prompt as the default", () => {
    expect(resolveBoardPlanReviewSettings(undefined)).toEqual({
      enabledByDefault: false,
      defaultRounds: 2,
      prompt: DEFAULT_BOARD_PLAN_REVIEW_PROMPT,
    });
    expect(
      resolveBoardPlanReviewSettings({
        planReview: { enabledByDefault: true, defaultRounds: 5, prompt: "  " },
      }).prompt,
    ).toBe(DEFAULT_BOARD_PLAN_REVIEW_PROMPT);
    expect(
      resolveBoardPlanReviewSettings({
        planReview: { enabledByDefault: true, defaultRounds: 5, prompt: "Mine" },
      }).prompt,
    ).toBe("Mine");
  });

  it("uses the card's own setting before the Settings default", () => {
    const stage = { planReview: { enabledByDefault: true, defaultRounds: 7, prompt: null } };
    expect(resolveBoardCardPlanReview({}, stage)).toEqual({ enabled: true, rounds: 7 });
    expect(
      resolveBoardCardPlanReview({ planReview: { enabled: false, rounds: 1 } }, stage),
    ).toEqual({ enabled: false, rounds: 1 });
  });

  it("reads the agent's report, tolerating anything malformed", () => {
    expect(
      readBoardPlanReviewReport(JSON.stringify({ planReview: { roundsRun: 2, converged: false } })),
    ).toEqual({ roundsRun: 2, converged: false });
    expect(readBoardPlanReviewReport(null)).toEqual({ roundsRun: null, converged: null });
    expect(readBoardPlanReviewReport("not json")).toEqual({ roundsRun: null, converged: null });
    expect(
      readBoardPlanReviewReport(
        JSON.stringify({ planReview: { roundsRun: -1, converged: "yes" } }),
      ),
    ).toEqual({ roundsRun: null, converged: null });
  });
});
