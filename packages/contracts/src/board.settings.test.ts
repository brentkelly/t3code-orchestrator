/**
 * T3o board settings — the typed stage-execution pipeline (D4, t3o-07/t3o-15).
 * These lock the three things the spec's verification calls out: an empty
 * settings file produces a working pipeline, the pipeline round-trips (survives
 * a restart), and a stage absent from the pipeline resolves to the all-defaults
 * (auto-execute off) config rather than throwing.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import {
  assignBoardKeyPrefix,
  BOARD_SEED_STAGE_IDS,
  BoardSettings,
  boardProjectAcronym,
  DEFAULT_BOARD_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_BUILD_PROMPT,
  DEFAULT_BOARD_KEY_PREFIX,
  DEFAULT_BOARD_PIPELINE,
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_BOARD_STAGE_EXECUTION,
  resolveBoardKeyPrefix,
  resolveBoardProjectAccent,
  resolveBoardStageExecution,
  resolveBoardStageModelSelection,
} from "./board.ts";

const decodeSettings = Schema.decodeUnknownSync(BoardSettings);
const encodeSettings = Schema.encodeUnknownSync(BoardSettings);

const PROJECT = ProjectId.make("project-1");

describe("board settings defaults", () => {
  it("decodes an empty file to a working default pipeline", () => {
    const settings = decodeSettings({});
    // Building ships auto-executing in build mode (D4) — a working pipeline out
    // of an empty file.
    expect(settings.pipeline[BOARD_SEED_STAGE_IDS.building]).toEqual(
      DEFAULT_BOARD_PIPELINE[BOARD_SEED_STAGE_IDS.building],
    );
    expect(settings.pipeline[BOARD_SEED_STAGE_IDS.planning]).toEqual(
      DEFAULT_BOARD_PIPELINE[BOARD_SEED_STAGE_IDS.planning],
    );
    expect(settings.projects).toEqual({});
    expect(settings.concurrency.globalMaxConcurrent).toBeGreaterThan(0);
    expect(settings.lifecycle.archiveAfterDays).toBe(DEFAULT_BOARD_ARCHIVE_AFTER_DAYS);
    expect(settings.lifecycle.worktreeRetention).toBe("reclaim-on-archive");
    expect(settings).toEqual(DEFAULT_BOARD_SETTINGS);
  });

  it("the default Building stage is runnable (real instance + model), not a placeholder", () => {
    const building = resolveBoardStageExecution(
      DEFAULT_BOARD_SETTINGS,
      BOARD_SEED_STAGE_IDS.building,
    );
    expect(building.autoExecute).toBe(true);
    expect(building.mode).toBe("build");
    expect(building.prompt).toBe(DEFAULT_BOARD_BUILD_PROMPT);
    expect(building.maxAttempts).toBeGreaterThan(0);
    expect(building.timeoutMs).toBeGreaterThan(0);
    // Its `null` model resolves to a concrete, runnable instance + model (D12).
    const selection = resolveBoardStageModelSelection(building.model);
    expect(selection.instanceId).toBe("codex");
    expect(selection.model.length).toBeGreaterThan(0);
  });
});

describe("board settings round-trip", () => {
  it("survives encode/decode (a restart) unchanged, including a full pipeline", () => {
    const configured = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "T3", accentColor: "#39d" } },
      pipeline: {
        [BOARD_SEED_STAGE_IDS.building]: {
          autoExecute: true,
          prompt: DEFAULT_BOARD_BUILD_PROMPT,
          model: { instanceId: "codex", model: "custom-model" },
          mode: "build",
          humanInLoop: false,
          humanInLoopWithPlan: false,
          humanInLoopWithoutPlan: true,
          autoAdvance: true,
          timeoutMs: 600000,
          maxAttempts: 3,
        },
        [BOARD_SEED_STAGE_IDS.review]: {
          autoExecute: true,
          prompt: "Review the diff.",
          model: { instanceId: "codex", model: "review-model" },
          mode: "build",
          humanInLoop: false,
          humanInLoopWithPlan: false,
          humanInLoopWithoutPlan: true,
          autoAdvance: true,
          timeoutMs: 600000,
          maxAttempts: 2,
        },
      },
    });
    const roundTripped = decodeSettings(JSON.parse(JSON.stringify(encodeSettings(configured))));
    expect(roundTripped).toEqual(configured);
  });
});

describe("resolveBoard* helpers", () => {
  it("resolves a stage's execution config, or the all-defaults config when the stage has none", () => {
    expect(
      resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.building),
    ).toEqual(DEFAULT_BOARD_PIPELINE[BOARD_SEED_STAGE_IDS.building]);
    // A stage absent from the pipeline map runs nothing — the all-defaults
    // (auto-execute off) config.
    expect(resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.ready)).toEqual(
      DEFAULT_BOARD_STAGE_EXECUTION,
    );
    expect(DEFAULT_BOARD_STAGE_EXECUTION.autoExecute).toBe(false);
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

describe("stage execution resolution reflects edits (D4)", () => {
  it("resolveBoardStageExecution tracks the current settings, so an edit changes what a stage runs", () => {
    // Settings edited mid-flight to a different model for Building.
    const edited = decodeSettings({
      pipeline: {
        [BOARD_SEED_STAGE_IDS.building]: {
          autoExecute: true,
          prompt: DEFAULT_BOARD_BUILD_PROMPT,
          model: { instanceId: "codex", model: "a-newer-model" },
          mode: "build",
          humanInLoop: false,
          humanInLoopWithPlan: false,
          humanInLoopWithoutPlan: true,
          autoAdvance: true,
          timeoutMs: DEFAULT_BOARD_STAGE_EXECUTION.timeoutMs,
          maxAttempts: DEFAULT_BOARD_STAGE_EXECUTION.maxAttempts,
        },
      },
    });
    const before = resolveBoardStageExecution(
      DEFAULT_BOARD_SETTINGS,
      BOARD_SEED_STAGE_IDS.building,
    );
    const after = resolveBoardStageExecution(edited, BOARD_SEED_STAGE_IDS.building);
    // The default resolves to a null model (the global default); the edit
    // resolves to the concrete override — the two diverge exactly at the model.
    expect(before.model).toBe(null);
    expect(after.model).toEqual({ instanceId: "codex", model: "a-newer-model" });
    expect(after).not.toEqual(before);
  });
});
