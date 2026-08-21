/**
 * T3o prompt envelope (D5) — the system-owned wrapper the settings redesign
 * split out of the editable prompts. These lock the split's contract: the
 * completion / question / deliverable / move-guard protocol survives ANY edit
 * to the editable prompt, the `plan` role carries the `board_propose_plans`
 * deliverable, and a stored pre-split default upgrades to the slimmed one.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_SEED_STAGE_IDS,
  BoardStageId,
  boardSeedStageRole,
  DEFAULT_BOARD_BUILD_PROMPT,
  DEFAULT_BOARD_PLANNING_PROMPT,
  DEFAULT_BOARD_REVIEW_PHASE_PROMPT,
  effectiveBoardStageRole,
  upgradeLegacyBoardPrompt,
} from "./board.ts";
import {
  BOARD_ENVELOPE_MOVE_GUARD,
  BOARD_ENVELOPE_PLAN_DELIVERABLE,
  boardReviewPhasePreamble,
  boardReviewPhaseProtocol,
  boardStepPostamble,
  boardStepPreamble,
  composeBoardReviewPhasePrompt,
  composeStepPrompt,
} from "./boardEnvelope.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const CODEX = ProviderInstanceId.make("codex");

const promptFor = (input: {
  readonly role: "plan" | "build" | null;
  readonly humanInLoop: boolean;
  readonly prompt?: string;
}): string =>
  composeStepPrompt({
    card: { key: "T3-1", title: "Ship it", stage: "planning" },
    step: {
      stepLabel: "Planning",
      providerInstanceId: CODEX,
      prompt: input.prompt ?? "Whatever the user typed.",
      maxAttempts: 3,
      humanInLoop: input.humanInLoop,
    },
    attempt: 1,
    role: input.role,
  });

describe("boardStepPostamble (envelope split)", () => {
  it("carries the plan deliverable for the plan role only", () => {
    expect(promptFor({ role: "plan", humanInLoop: true })).toContain("board_propose_plans");
    expect(promptFor({ role: "plan", humanInLoop: false })).toContain("board_propose_plans");
    expect(promptFor({ role: "build", humanInLoop: false })).not.toContain("board_propose_plans");
    expect(promptFor({ role: null, humanInLoop: false })).not.toContain("board_propose_plans");
  });

  it("always carries the completion contract and the move guard, whatever the editable prompt says", () => {
    for (const role of ["plan", "build", null] as const) {
      for (const humanInLoop of [true, false]) {
        const prompt = promptFor({ role, humanInLoop, prompt: "Rewritten from scratch." });
        expect(prompt).toContain("board_complete_step");
        expect(prompt).toContain(BOARD_ENVELOPE_MOVE_GUARD);
      }
    }
  });

  it("keeps the stance split: unattended never-prose vs question-friendly", () => {
    const unattended = boardStepPostamble({
      humanInLoop: false,
      providerInstanceId: CODEX,
      role: null,
    });
    expect(unattended).toContain("running unattended");
    expect(unattended).toContain("never end a turn with an unanswered question in prose");
    const hitl = boardStepPostamble({ humanInLoop: true, providerInstanceId: CODEX, role: null });
    expect(hitl).toContain("human-in-the-loop");
    expect(hitl).not.toContain("running unattended");
  });

  it("orders the plan deliverable before the move guard", () => {
    const postamble = boardStepPostamble({
      humanInLoop: true,
      providerInstanceId: CODEX,
      role: "plan",
    });
    expect(postamble.indexOf(BOARD_ENVELOPE_PLAN_DELIVERABLE)).toBeGreaterThan(-1);
    expect(postamble.indexOf(BOARD_ENVELOPE_PLAN_DELIVERABLE)).toBeLessThan(
      postamble.indexOf(BOARD_ENVELOPE_MOVE_GUARD),
    );
  });
});

describe("boardStepPreamble", () => {
  it("orients on the card and points at board_get_card_context", () => {
    const preamble = boardStepPreamble({
      card: { key: "T3-9", title: "A card", stage: "building" },
      step: { stepLabel: "Build", maxAttempts: 5 },
      attempt: 2,
    });
    expect(preamble).toContain("T3-9");
    expect(preamble).toContain("attempt 2 of 5");
    expect(preamble).toContain("board_get_card_context");
  });
});

describe("review phase envelope", () => {
  it("wraps the editable phase prompt between the round preamble and the protocol", () => {
    const prompt = composeBoardReviewPhasePrompt({
      phase: "review",
      round: 1,
      rounds: 5,
      prompt: DEFAULT_BOARD_REVIEW_PHASE_PROMPT,
    });
    expect(prompt.indexOf("round 1 of up to 5")).toBeLessThan(
      prompt.indexOf(DEFAULT_BOARD_REVIEW_PHASE_PROMPT),
    );
    expect(prompt.indexOf(DEFAULT_BOARD_REVIEW_PHASE_PROMPT)).toBeLessThan(
      prompt.indexOf('board_complete_step with stepId "review@1"'),
    );
  });

  it("points every phase after the first review at the prior payloads", () => {
    expect(boardReviewPhasePreamble({ phase: "review", round: 1, rounds: 5 })).not.toContain(
      "board_get_card_context",
    );
    expect(boardReviewPhasePreamble({ phase: "triage", round: 1, rounds: 5 })).toContain(
      "board_get_card_context",
    );
    expect(boardReviewPhasePreamble({ phase: "review", round: 2, rounds: 5 })).toContain(
      "board_get_card_context",
    );
  });

  it("keeps the payload mechanics in the protocol even when the editable prompt is rewritten", () => {
    for (const phase of ["review", "triage", "adjudicate"] as const) {
      const prompt = composeBoardReviewPhasePrompt({
        phase,
        round: 2,
        rounds: 5,
        prompt: "Rewritten from scratch.",
      });
      expect(prompt).toContain(`board_complete_step with stepId "${phase}@2"`);
    }
    expect(boardReviewPhaseProtocol({ phase: "review", round: 1 })).toContain("reviewedSha");
    expect(boardReviewPhaseProtocol({ phase: "triage", round: 1 })).toContain("fixedSha");
    expect(boardReviewPhaseProtocol({ phase: "adjudicate", round: 1 })).toContain("fix-upheld");
  });
});

describe("upgradeLegacyBoardPrompt", () => {
  it("upgrades a stored pre-split default, verbatim or whitespace-padded, to the slimmed default", () => {
    const legacyBuild =
      "Implement the card's brief on its branch. Run the project's checks until they pass, then report completion through your completion tool. Ask any blocking question through your question tool rather than in prose.";
    expect(upgradeLegacyBoardPrompt(legacyBuild)).toBe(DEFAULT_BOARD_BUILD_PROMPT);
    expect(upgradeLegacyBoardPrompt(`  ${legacyBuild}\n`)).toBe(DEFAULT_BOARD_BUILD_PROMPT);
  });

  it("leaves an edited prompt untouched", () => {
    expect(upgradeLegacyBoardPrompt("My own build prompt.")).toBe("My own build prompt.");
    expect(upgradeLegacyBoardPrompt(DEFAULT_BOARD_PLANNING_PROMPT)).toBe(
      DEFAULT_BOARD_PLANNING_PROMPT,
    );
  });

  it("the current defaults no longer carry the force-appended contract sentences", () => {
    expect(DEFAULT_BOARD_BUILD_PROMPT).not.toContain("completion tool");
    expect(DEFAULT_BOARD_PLANNING_PROMPT).not.toContain("board_propose_plans");
    expect(DEFAULT_BOARD_REVIEW_PHASE_PROMPT).not.toContain("severity");
  });
});

describe("effective stage role (plan)", () => {
  it("maps the seeded ids to their roles and everything else to null", () => {
    expect(boardSeedStageRole(BOARD_SEED_STAGE_IDS.planning)).toBe("plan");
    expect(boardSeedStageRole(BOARD_SEED_STAGE_IDS.building)).toBe("build");
    expect(boardSeedStageRole(BOARD_SEED_STAGE_IDS.review)).toBe("review");
    expect(boardSeedStageRole(BOARD_SEED_STAGE_IDS.done)).toBe("done");
    expect(boardSeedStageRole(BOARD_SEED_STAGE_IDS.backlog)).toBe(null);
    expect(boardSeedStageRole("2f6c9c2a-custom")).toBe(null);
  });

  it("falls back to the seeded role for a legacy Planning definition (role null)", () => {
    expect(effectiveBoardStageRole({ stageId: BOARD_SEED_STAGE_IDS.planning, role: null })).toBe(
      "plan",
    );
    expect(
      effectiveBoardStageRole({ stageId: BoardStageId.make("2f6c9c2a-custom"), role: null }),
    ).toBe(null);
  });
});
