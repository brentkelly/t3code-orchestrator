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
  boardRunLabel,
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
  BOARD_ENVELOPE_QUESTION_MECHANISM,
  boardReviewPhasePreamble,
  boardReviewPhaseProtocol,
  boardStepPostamble,
  boardStepPreamble,
  composeBoardReviewPhasePrompt,
  composeStepPrompt,
} from "./boardEnvelope.ts";
const promptFor = (input: {
  readonly role: "plan" | "build" | null;
  readonly humanInLoop: boolean;
  readonly prompt?: string;
  /** Default null: every stage but the review loop has no steps (t3o-19, D4). */
  readonly stepLabel?: string | null;
}): string =>
  composeStepPrompt({
    card: { key: "T3-1", title: "Ship it", stage: "planning" },
    stageLabel: "Planning",
    step: {
      stepId: "planning",
      stepLabel: input.stepLabel ?? null,
      prompt: input.prompt ?? "Whatever the user typed.",
      humanInLoop: input.humanInLoop,
    },
    role: input.role,
  });

/** The step identity a postamble assertion needs; null = an unstepped stage. */
const stepOf = (stepLabel: string | null) => ({ stepId: "planning", stepLabel });

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
      role: null,
      step: stepOf(null),
    });
    expect(unattended).toContain("running unattended");
    expect(unattended).toContain("never end a turn with an unanswered question in prose");
    const hitl = boardStepPostamble({ humanInLoop: true, role: null, step: stepOf(null) });
    expect(hitl).toContain("human-in-the-loop");
    expect(hitl).not.toContain("running unattended");
  });

  it("names no provider: the question mechanism is neutral wording every runtime can follow", () => {
    const postamble = boardStepPostamble({
      humanInLoop: false,
      role: null,
      step: stepOf(null),
    });
    expect(postamble).toContain(BOARD_ENVELOPE_QUESTION_MECHANISM);
    for (const vendor of ["Codex", "Claude", "Cursor", "Gemini", "Grok", "OpenCode"]) {
      expect(postamble).not.toContain(vendor);
    }
  });

  it("orders the plan deliverable before the move guard", () => {
    const postamble = boardStepPostamble({ humanInLoop: true, role: "plan", step: stepOf(null) });
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
      stageLabel: "Building",
      step: { stepLabel: "Build · round 1" },
    });
    expect(preamble).toContain("T3-9");
    expect(preamble).toContain("Stage: Building. Step: Build · round 1.");
    expect(preamble).toContain("board_get_card_context");
  });

  it("carries no attempt counter — the retry ladder is supervisor bookkeeping", () => {
    const preamble = boardStepPreamble({
      card: { key: "T3-9", title: "A card", stage: "building" },
      stageLabel: "Building",
      step: { stepLabel: null },
    });
    expect(preamble).not.toContain("attempt");
  });

  // t3o-19 AC 2: a stage with no steps says nothing about steps. The old
  // preamble rendered `Stage: building. Step: Building.` — a tautology, since
  // a single-step stage's step label WAS its stage label.
  it("renders no Step: line for a stage with no steps", () => {
    const preamble = boardStepPreamble({
      card: { key: "T3-9", title: "A card", stage: "building" },
      stageLabel: "Building",
      step: { stepLabel: null },
    });
    expect(preamble).toContain("Stage: Building.");
    expect(preamble).not.toContain("Step:");
  });

  // t3o-19 AC 2/3: names the stage by its LABEL. A custom stage's id is a
  // UUID, so printing the id put `Stage: 3f2a1b9c-…` into its system prompt.
  it("names the stage by its label, not its id", () => {
    const preamble = boardStepPreamble({
      card: { key: "T3-9", title: "A card", stage: "3f2a1b9c-6d4e-4a2b-9f11-0c7d5e2a8b34" },
      stageLabel: "Spike",
      step: { stepLabel: null },
    });
    expect(preamble).toContain("Stage: Spike.");
    expect(preamble).not.toContain("3f2a1b9c");
  });

  // A row written before the stage label was frozen (t3o-19, D7: history is
  // never rewritten) has only the stage id to fall back on.
  it("falls back to the stage id when no stage label was frozen", () => {
    const preamble = boardStepPreamble({
      card: { key: "T3-9", title: "A card", stage: "building" },
      stageLabel: null,
      step: { stepLabel: null },
    });
    expect(preamble).toContain("Stage: building.");
  });
});

describe("step vocabulary is conditional (t3o-19)", () => {
  // AC 1: the whole point. `board_complete_step` is the tool's NAME, so it is
  // the one permitted occurrence.
  it("a stage with no steps never says the word step outside the tool name", () => {
    for (const role of ["plan", "build", null] as const) {
      for (const humanInLoop of [true, false]) {
        const prompt = promptFor({ role, humanInLoop });
        const residue = prompt.replaceAll("board_complete_step", "");
        expect(residue.toLowerCase()).not.toContain("step");
      }
    }
  });

  // AC 6: with no step to name, the agent is not asked to name one — which is
  // what it could never do, having never been told its id.
  it("a stage with no steps names no stepId on the completion call", () => {
    for (const humanInLoop of [true, false]) {
      const prompt = promptFor({ role: "build", humanInLoop });
      expect(prompt).toContain("board_complete_step");
      expect(prompt).not.toContain("stepId");
    }
  });

  // AC 4/5: a stepped stage keeps the full vocabulary AND is told its id.
  it("a stepped stage states its stepId exactly once", () => {
    const prompt = composeStepPrompt({
      card: { key: "T3-1", title: "Ship it", stage: "review" },
      stageLabel: "Code review",
      step: {
        stepId: "review@1",
        stepLabel: "Review · round 1",
        prompt: "Review the branch.",
        humanInLoop: false,
      },
      role: "review",
    });
    expect(prompt).toContain("Stage: Code review. Step: Review · round 1.");
    expect(prompt.split('board_complete_step with stepId "review@1"')).toHaveLength(2);
  });

  it("the move guard is step-neutral, so it reads correctly with no steps", () => {
    expect(BOARD_ENVELOPE_MOVE_GUARD.toLowerCase()).not.toContain("step");
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
      prompt.indexOf("reviewedSha"),
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
      // The protocol owns the PAYLOAD; the envelope owns the tool call and the
      // step id (t3o-19, D6), so a review agent is not told the id twice.
      expect(prompt).not.toContain("board_complete_step");
      expect(prompt).toContain("succeeded outcome");
    }
    expect(boardReviewPhaseProtocol({ phase: "review", round: 1 })).toContain("reviewedSha");
    expect(boardReviewPhaseProtocol({ phase: "triage", round: 1 })).toContain("fixedSha");
    expect(boardReviewPhaseProtocol({ phase: "adjudicate", round: 1 })).toContain("fix-upheld");
  });
});

describe("boardRunLabel (t3o-19 AC 11)", () => {
  // The thread title, the activity rail and the detail views all name a run.
  // One rule, so a card never shows two names for the same run.
  it("prefers the step's label, falls back to the stage's, and is null with neither", () => {
    expect(boardRunLabel({ stepLabel: "Review · round 1", stageLabel: "Code review" })).toBe(
      "Review · round 1",
    );
    // The unstepped case: no step to name, so the stage names the run.
    expect(boardRunLabel({ stepLabel: null, stageLabel: "Planning" })).toBe("Planning");
    // A pre-020 row (D7: history is not rewritten) kept its label and froze no
    // stage label — it still renders exactly what it always did.
    expect(boardRunLabel({ stepLabel: "Building", stageLabel: null })).toBe("Building");
    expect(boardRunLabel({ stepLabel: null, stageLabel: null })).toBe(null);
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
