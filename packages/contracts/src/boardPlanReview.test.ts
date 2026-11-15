/**
 * Plan review: the instructions the planning agent gets, the card and
 * settings resolution, and the completion report reader.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  BoardStageId,
  DEFAULT_BOARD_PLAN_REVIEW_PROMPT,
  boardPlanReviewCreationDefaults,
  isBoardPlanReviewRunning,
  readBoardPlanReviewReport,
  resolveBoardStageExecution,
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
    expect(text.slice(closing)).toContain("planReview: { roundsRun, converged, findings }");
    // The round tool's target wins over the stated rounds.
    expect(text.slice(closing)).toContain("board_plan_review_round");
    expect(text.slice(closing)).toContain("continue: false");
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
    expect(unattended).not.toContain("wait for the human's sign-off");
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
    expect(resolveBoardCardPlanReview({}, stage)).toEqual({
      enabled: true,
      rounds: 7,
      unattended: false,
    });
    expect(
      resolveBoardCardPlanReview({ planReview: { enabled: false, rounds: 1 } }, stage),
    ).toEqual({ enabled: false, rounds: 1 });
  });

  it("reads the agent's report, tolerating anything malformed", () => {
    expect(
      readBoardPlanReviewReport(JSON.stringify({ planReview: { roundsRun: 2, converged: false } })),
    ).toEqual({ roundsRun: 2, converged: false, findings: null });
    expect(
      readBoardPlanReviewReport(
        JSON.stringify({ planReview: { roundsRun: 3, converged: true, findings: 7 } }),
      ),
    ).toEqual({ roundsRun: 3, converged: true, findings: 7 });
    const none = { roundsRun: null, converged: null, findings: null };
    expect(readBoardPlanReviewReport(null)).toEqual(none);
    expect(readBoardPlanReviewReport("not json")).toEqual(none);
    expect(
      readBoardPlanReviewReport(
        JSON.stringify({ planReview: { roundsRun: -1, converged: "yes", findings: 1.5 } }),
      ),
    ).toEqual(none);
  });
});

describe("plan review new-card defaults", () => {
  it("stamps on, 3 rounds, attended when nothing is set, even beside a stored prompt", () => {
    const stamped = { enabled: true, rounds: 3, unattended: false, source: "default" };
    expect(boardPlanReviewCreationDefaults(undefined)).toEqual(stamped);
    expect(
      boardPlanReviewCreationDefaults({
        planReview: { enabledByDefault: false, defaultRounds: 2, prompt: "Mine" },
      }),
    ).toEqual(stamped);
  });

  it("reads newCards, not the live-fallback keys", () => {
    expect(
      boardPlanReviewCreationDefaults({
        planReview: {
          enabledByDefault: true,
          defaultRounds: 9,
          prompt: null,
          newCards: { enabled: false, rounds: 5, unattended: true },
        },
      }),
    ).toEqual({ enabled: false, rounds: 5, unattended: true, source: "default" });
  });

  it("merges a project's newCards over the board's key by key", () => {
    const execution = resolveBoardStageExecution(
      {
        pipeline: {
          planning: {
            kind: "simple",
            planReview: {
              enabledByDefault: false,
              defaultRounds: 2,
              prompt: null,
              newCards: { rounds: 4, unattended: true },
            },
          },
        },
      } as unknown as Parameters<typeof resolveBoardStageExecution>[0],
      BoardStageId.make("planning"),
      { overrides: { planning: { planReview: { newCards: { unattended: false } } } } },
    );
    expect(execution.kind === "simple" ? execution.planReview?.newCards : null).toEqual({
      rounds: 4,
      unattended: false,
    });
  });
});

describe("isBoardPlanReviewRunning", () => {
  it("is started, not done, on a live step", () => {
    const started = { status: "running" as const, planReviewStartedAt: "2026-01-01T00:00:00Z" };
    expect(isBoardPlanReviewRunning(started)).toBe(true);
    expect(isBoardPlanReviewRunning({ ...started, status: "awaiting-input" })).toBe(true);
    expect(isBoardPlanReviewRunning({ ...started, planReviewDoneAt: "2026-01-01T01:00:00Z" })).toBe(
      false,
    );
    expect(isBoardPlanReviewRunning({ ...started, status: "succeeded" })).toBe(false);
    expect(isBoardPlanReviewRunning({ status: "running" })).toBe(false);
    expect(isBoardPlanReviewRunning(null)).toBe(false);
  });
});
