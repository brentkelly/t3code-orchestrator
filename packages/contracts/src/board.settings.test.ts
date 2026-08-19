/**
 * T3o board settings — the typed pipeline recipe (D10, t3o-07). These lock the
 * three things the spec's verification calls out: an empty settings file
 * produces a working pipeline, the recipe round-trips (survives a restart), and
 * a settings edit mid-stage diverges from a card's captured snapshot rather
 * than silently mutating what that card runs.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  assignBoardKeyPrefix,
  boardPlanningThreadTitle,
  composeBoardPlanningPrompt,
  BoardCardRecipeSnapshot,
  BoardSettings,
  boardProjectAcronym,
  boardRecipeSnapshotDiffersFromCurrent,
  DEFAULT_BOARD_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_BUILD_STEP,
  DEFAULT_BOARD_KEY_PREFIX,
  DEFAULT_BOARD_PLANNING_STEP,
  DEFAULT_BOARD_SETTINGS,
  resolveBoardKeyPrefix,
  resolveBoardProjectAccent,
  resolveBoardPlanningStep,
  resolveBoardRecipeForStage,
  resolveBoardStageSteps,
  type BoardResolvedRecipe,
  type BoardStep,
} from "./board.ts";

const decodeSettings = Schema.decodeUnknownSync(BoardSettings);
const encodeSettings = Schema.encodeUnknownSync(BoardSettings);
const decodeSnapshot = Schema.decodeUnknownSync(BoardCardRecipeSnapshot);
const encodeSnapshot = Schema.encodeUnknownSync(BoardCardRecipeSnapshot);

const PROJECT = ProjectId.make("project-1");

describe("board settings defaults", () => {
  it("decodes an empty file to a working default pipeline", () => {
    const settings = decodeSettings({});
    expect(settings.pipeline.building).toEqual([DEFAULT_BOARD_BUILD_STEP]);
    expect(settings.projects).toEqual({});
    expect(settings.concurrency.globalMaxConcurrent).toBeGreaterThan(0);
    expect(settings.lifecycle.archiveAfterDays).toBe(DEFAULT_BOARD_ARCHIVE_AFTER_DAYS);
    expect(settings.lifecycle.worktreeRetention).toBe("reclaim-on-archive");
    expect(settings).toEqual(DEFAULT_BOARD_SETTINGS);
  });

  it("the default Building step is runnable (real instance + model), not a placeholder", () => {
    expect(DEFAULT_BOARD_BUILD_STEP.providerInstanceId).toBe("codex");
    expect(DEFAULT_BOARD_BUILD_STEP.model.length).toBeGreaterThan(0);
    expect(DEFAULT_BOARD_BUILD_STEP.maxAttempts).toBeGreaterThan(0);
    expect(DEFAULT_BOARD_BUILD_STEP.timeoutMs).toBeGreaterThan(0);
  });
});

describe("board settings round-trip", () => {
  it("survives encode/decode (a restart) unchanged, including a full recipe", () => {
    const configured = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "T3", accentColor: "#39d" } },
      pipeline: {
        building: [{ ...DEFAULT_BOARD_BUILD_STEP, model: "custom-model" }],
        review: [
          {
            id: "r1",
            label: "Fresh eyes",
            promptTemplate: "Review the diff.",
            providerInstanceId: "codex",
            model: "review-model",
            timeoutMs: 600000,
            maxAttempts: 2,
          },
        ],
      },
    });
    const roundTripped = decodeSettings(JSON.parse(JSON.stringify(encodeSettings(configured))));
    expect(roundTripped).toEqual(configured);
  });
});

describe("resolveBoard* helpers", () => {
  it("resolves a stage's recipe, or [] when the stage has no steps", () => {
    expect(resolveBoardRecipeForStage(DEFAULT_BOARD_SETTINGS, "building")).toEqual({
      stage: "building",
      steps: [DEFAULT_BOARD_BUILD_STEP],
    });
    // Planning ships a step too (t3o-14) — it is the prompt the planning
    // thread opens with, editable at Settings → Board → Pipeline.
    expect(resolveBoardRecipeForStage(DEFAULT_BOARD_SETTINGS, "planning")).toEqual({
      stage: "planning",
      steps: [DEFAULT_BOARD_PLANNING_STEP],
    });
    expect(resolveBoardRecipeForStage(DEFAULT_BOARD_SETTINGS, "ready")).toEqual({
      stage: "ready",
      steps: [],
    });
  });

  it("resolves the planning step from the first step of the planning recipe", () => {
    expect(resolveBoardPlanningStep(DEFAULT_BOARD_SETTINGS)).toEqual(DEFAULT_BOARD_PLANNING_STEP);
    expect(resolveBoardPlanningStep(decodeSettings({ pipeline: { planning: [] } }))).toBe(null);
  });

  // The compiled-in pipeline applies PER STAGE. `withDecodingDefault` fires only
  // when the whole `pipeline` key is absent, and settings are stripped per key —
  // so anyone who has ever edited one stage has a pipeline containing only that
  // stage. Defaulting per object would silently switch the other stage off for
  // exactly the users who tuned the board.
  it("defaults a stage the settings file has never mentioned, in both directions", () => {
    const customBuild: BoardStep = { ...DEFAULT_BOARD_BUILD_STEP, promptTemplate: "custom" };
    const editedBuildingOnly = decodeSettings({ pipeline: { building: [customBuild] } });
    expect(resolveBoardStageSteps(editedBuildingOnly, "building")).toEqual([customBuild]);
    expect(resolveBoardStageSteps(editedBuildingOnly, "planning")).toEqual([
      DEFAULT_BOARD_PLANNING_STEP,
    ]);
    expect(resolveBoardPlanningStep(editedBuildingOnly)).toEqual(DEFAULT_BOARD_PLANNING_STEP);

    const editedPlanningOnly = decodeSettings({
      pipeline: { planning: [{ ...DEFAULT_BOARD_PLANNING_STEP, promptTemplate: "mine" }] },
    });
    expect(resolveBoardStageSteps(editedPlanningOnly, "building")).toEqual([
      DEFAULT_BOARD_BUILD_STEP,
    ]);
  });

  it("honours an explicitly emptied stage as off, which is how a stage is switched off", () => {
    // An absent key means "never configured"; a stored `[]` means "I cleared it".
    // The settings UI persists `[]` when you remove a stage's last step, so this
    // is the difference between an upgrade default and a user's decision.
    const off = decodeSettings({ pipeline: { planning: [], building: [] } });
    expect(resolveBoardStageSteps(off, "planning")).toEqual([]);
    expect(resolveBoardStageSteps(off, "building")).toEqual([]);
    expect(resolveBoardPlanningStep(off)).toBe(null);
  });

  it("a stage with no compiled-in default resolves to no steps", () => {
    expect(resolveBoardStageSteps(DEFAULT_BOARD_SETTINGS, "ready")).toEqual([]);
  });

  it("falls back to the default key prefix, or uses the configured one and accent", () => {
    expect(resolveBoardKeyPrefix(DEFAULT_BOARD_SETTINGS, PROJECT)).toBe(DEFAULT_BOARD_KEY_PREFIX);
    expect(resolveBoardProjectAccent(DEFAULT_BOARD_SETTINGS, PROJECT)).toBe(null);
    const configured = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "T3", accentColor: "#39d" } },
    });
    expect(resolveBoardKeyPrefix(configured, PROJECT)).toBe("T3");
    expect(resolveBoardProjectAccent(configured, PROJECT)).toBe("#39d");
  });
});

describe("project key acronyms (D14)", () => {
  it("reads a name as words — separators and camelCase humps both split", () => {
    expect(boardProjectAcronym("core.agent.advisor")).toBe("CAA");
    expect(boardProjectAcronym("mesh.web")).toBe("MW");
    expect(boardProjectAcronym("mesh-relay")).toBe("MR");
    expect(boardProjectAcronym("meshRelay")).toBe("MR");
    expect(boardProjectAcronym("t3o-test")).toBe("TT");
    // One word gives its opening letters, digits included.
    expect(boardProjectAcronym("backend")).toBe("BAC");
    expect(boardProjectAcronym("t3o")).toBe("T3O");
    // Nothing to read: the compiled-in default, never an empty prefix.
    expect(boardProjectAcronym("···")).toBe(DEFAULT_BOARD_KEY_PREFIX);
  });

  it("never hands two projects the same prefix", () => {
    expect(boardProjectAcronym("mesh.web", ["MW"])).toBe("MES");
    expect(boardProjectAcronym("mesh.web", ["MW", "MES"])).toBe("MW2");
    // Case never smuggles a collision through.
    expect(boardProjectAcronym("mesh.web", ["mw"])).toBe("MES");
  });

  it("assigns an acronym once, then leaves the stored prefix alone", () => {
    const first = assignBoardKeyPrefix({
      board: DEFAULT_BOARD_SETTINGS,
      projectId: PROJECT,
      projectTitle: "mesh.web",
    });
    expect(first).toEqual({ prefix: "MW", assigned: true });

    // Persisted — a later card (even after a rename) keeps the same keys.
    const stored = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "MW", accentColor: null } },
    });
    expect(
      assignBoardKeyPrefix({ board: stored, projectId: PROJECT, projectTitle: "mesh.gateway" }),
    ).toEqual({ prefix: "MW", assigned: false });

    // A second project with the same initials gets its own namespace.
    const other = ProjectId.make("project-2");
    expect(
      assignBoardKeyPrefix({ board: stored, projectId: other, projectTitle: "mesh-worker" }),
    ).toEqual({ prefix: "MES", assigned: true });
  });
});

describe("recipe snapshot divergence (D10)", () => {
  const step: BoardStep = DEFAULT_BOARD_BUILD_STEP;
  const current: BoardResolvedRecipe = { stage: "building", steps: [step] };

  it("a null snapshot has not diverged — the card is not running a recipe", () => {
    expect(boardRecipeSnapshotDiffersFromCurrent(null, current)).toBe(false);
  });

  it("an identical snapshot has not diverged", () => {
    const snapshot = decodeSnapshot(encodeSnapshot({ stage: "building", steps: [step] }));
    expect(boardRecipeSnapshotDiffersFromCurrent(snapshot, current)).toBe(false);
  });

  it("editing settings mid-stage leaves the card's captured snapshot, and the divergence is visible", () => {
    // The card captured the recipe on stage entry...
    const captured: BoardResolvedRecipe = { stage: "building", steps: [step] };
    // ...then settings were edited to a different model.
    const editedSettings = decodeSettings({
      pipeline: { building: [{ ...step, model: "a-newer-model" }] },
    });
    const nowResolves = resolveBoardRecipeForStage(editedSettings, "building");
    // The card still runs its captured recipe (its stored model is unchanged),
    // and that captured recipe now differs from current settings.
    expect(captured.steps[0]!.model).toBe(step.model);
    expect(boardRecipeSnapshotDiffersFromCurrent(captured, nowResolves)).toBe(true);
  });

  it("detects step-count and stage differences", () => {
    expect(boardRecipeSnapshotDiffersFromCurrent({ stage: "building", steps: [] }, current)).toBe(
      true,
    );
    expect(boardRecipeSnapshotDiffersFromCurrent({ stage: "review", steps: [step] }, current)).toBe(
      true,
    );
  });
});

describe("planning prompt envelope (t3o-14)", () => {
  const card = { key: "MW-12", title: "Auto-spawn planning threads" };

  it("wraps the settings prompt with the card identity and the planning contract", () => {
    const prompt = composeBoardPlanningPrompt({ card, step: DEFAULT_BOARD_PLANNING_STEP });

    // The preamble is what makes "the agent knows its own card" true: it never
    // passes a card id, the MCP toolkit resolves it from the calling thread.
    expect(prompt).toContain('You are planning card MW-12 — "Auto-spawn planning threads".');
    expect(prompt).toContain("Call board_get_card_context");
    // The editable body rides between the two halves, verbatim.
    expect(prompt).toContain(DEFAULT_BOARD_PLANNING_STEP.promptTemplate);
    // The planning output is a proposal, and the human still gates the stage.
    expect(prompt).toContain("board_propose_plans");
    expect(prompt).toContain("do not move it yourself");
    // NEVER the build contract: no step state exists for a planning thread, so
    // board_complete_step would fail on an unknown stepId.
    expect(prompt).not.toContain("board_complete_step");
  });

  it("words the question rule for the step's own provider", () => {
    const claude = composeBoardPlanningPrompt({
      card,
      step: {
        ...DEFAULT_BOARD_PLANNING_STEP,
        providerInstanceId: ProviderInstanceId.make("claude"),
      },
    });
    expect(claude).toContain("raise it as a Claude Code question");
    expect(composeBoardPlanningPrompt({ card, step: DEFAULT_BOARD_PLANNING_STEP })).toContain(
      "raise it through Codex's ask-for-input request",
    );
  });

  it("titles the thread the way build threads are titled", () => {
    expect(boardPlanningThreadTitle(card, DEFAULT_BOARD_PLANNING_STEP)).toBe("MW-12 · Plan");
  });
});
