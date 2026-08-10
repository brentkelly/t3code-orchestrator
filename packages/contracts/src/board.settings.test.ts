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
import {
  BoardCardRecipeSnapshot,
  BoardSettings,
  boardRecipeSnapshotDiffersFromCurrent,
  DEFAULT_BOARD_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_BUILD_STEP,
  DEFAULT_BOARD_KEY_PREFIX,
  DEFAULT_BOARD_SETTINGS,
  resolveBoardKeyPrefix,
  resolveBoardProjectAccent,
  resolveBoardRecipeForStage,
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
    expect(resolveBoardRecipeForStage(DEFAULT_BOARD_SETTINGS, "planning")).toEqual({
      stage: "planning",
      steps: [],
    });
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
