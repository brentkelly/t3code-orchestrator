import {
  BOARD_SEED_STAGE_IDS,
  BoardStageId,
  DEFAULT_BOARD_PIPELINE,
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_BOARD_STAGE_EXECUTION,
  isBoardReviewStageExecution,
  ProviderInstanceId,
  type BoardProjectSettings,
  type BoardSettings,
  type BoardStageExecution,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  minutesToMs,
  msToMinutes,
  normalizeKeyPrefixInput,
  parsePositiveIntInput,
  setBoardInstanceConcurrency,
  setBoardProjectSetting,
  setBoardStageExecution,
} from "./BoardSettingsPanel.logic";

describe("number parsing", () => {
  it("parses positive ints and falls back on invalid input", () => {
    expect(parsePositiveIntInput("3", 1)).toBe(3);
    expect(parsePositiveIntInput("  ", 7)).toBe(7);
    expect(parsePositiveIntInput("0", 7)).toBe(7);
    expect(parsePositiveIntInput("-2", 7)).toBe(7);
    expect(parsePositiveIntInput("abc", 7)).toBe(7);
  });

  it("round-trips minutes/ms with a 1-minute floor", () => {
    expect(msToMinutes(1_800_000)).toBe(30);
    expect(minutesToMs(30)).toBe(1_800_000);
    expect(msToMinutes(0)).toBe(1);
    expect(minutesToMs(0)).toBe(60_000);
  });
});

describe("stage execution mutations", () => {
  const boardWith = (pipeline: Record<string, BoardStageExecution>): BoardSettings => ({
    ...DEFAULT_BOARD_SETTINGS,
    pipeline,
  });
  const CUSTOM = BoardStageId.make("2f6c9c2a-custom");

  it("materialises a full entry from the RESOLVED config of a never-configured stage", () => {
    // Editing one field of a stage absent from the map starts from what that
    // stage resolves to — its seeded config for a seeded stage, the empty
    // all-defaults one for a custom stage — and produces a complete entry.
    const custom = setBoardStageExecution(boardWith({}), CUSTOM, { autoExecute: true });
    // The resolved config now carries the effective access level (t3o-21): a
    // custom stage is plan-mode by default, so `approval-required`.
    expect(custom[CUSTOM]).toEqual({
      ...DEFAULT_BOARD_STAGE_EXECUTION,
      runtimeMode: "approval-required",
      autoExecute: true,
    });

    const building = setBoardStageExecution(boardWith({}), BOARD_SEED_STAGE_IDS.building, {
      maxAttempts: 9,
    });
    // Building is build-mode → resolves to `auto` (never the old full-access).
    expect(building[BOARD_SEED_STAGE_IDS.building]).toEqual({
      ...DEFAULT_BOARD_PIPELINE[BOARD_SEED_STAGE_IDS.building],
      runtimeMode: "auto",
      maxAttempts: 9,
    });
  });

  it("keeps an absent review stage a REVIEW member, rounds and phases intact", () => {
    // The regression this guards: starting from the all-defaults SIMPLE config
    // produced a `kind: "simple"` entry, and the patch encoder then dropped the
    // `rounds` / `phases` that make the stage a review loop at all.
    const next = setBoardStageExecution(boardWith({}), BOARD_SEED_STAGE_IDS.review, { rounds: 6 });
    const review = next[BOARD_SEED_STAGE_IDS.review];
    expect(review?.kind).toBe("review");
    expect(review).toMatchObject({ rounds: 6 });
    expect(isBoardReviewStageExecution(review!) && review.phases.triage.prompt.length > 0).toBe(
      true,
    );
  });

  it("patches one field without mutating the input, keyed by stage id", () => {
    const pipeline = { [CUSTOM]: { ...DEFAULT_BOARD_STAGE_EXECUTION, prompt: "old" } };
    const edited = setBoardStageExecution(boardWith(pipeline), CUSTOM, { prompt: "new" });
    expect(edited[CUSTOM]!.prompt).toBe("new");
    expect(pipeline[CUSTOM]!.prompt).toBe("old"); // original untouched

    // A different stage id gets its own entry; existing ones are preserved, so
    // a rename (a new key) never orphans another stage's config.
    const other = BoardStageId.make("9a1b-other");
    const withOther = setBoardStageExecution(boardWith(edited), other, { maxAttempts: 3 });
    expect(withOther[other]!.maxAttempts).toBe(3);
    expect(withOther[CUSTOM]!.prompt).toBe("new");
  });
});

describe("project settings map", () => {
  const project = "project-1";

  it("adds and updates an override", () => {
    const withPrefix = setBoardProjectSetting({}, project, { keyPrefix: "T3" });
    expect(withPrefix[project]).toEqual({ keyPrefix: "T3", accentColor: null });
    const withAccent = setBoardProjectSetting(withPrefix, project, { accentColor: "violet" });
    expect(withAccent[project]).toEqual({ keyPrefix: "T3", accentColor: "violet" });
  });

  it("keeps a null-valued entry when an override reverts to defaults (deepMerge cannot delete keys)", () => {
    const configured: Record<string, BoardProjectSettings> = {
      [project]: { keyPrefix: "T3", accentColor: "violet" },
    };
    const clearedAccent = setBoardProjectSetting(configured, project, { accentColor: null });
    expect(clearedAccent[project]).toEqual({ keyPrefix: "T3", accentColor: null });
    const clearedBoth = setBoardProjectSetting(clearedAccent, project, { keyPrefix: null });
    // Retained with null fields, NOT deleted: an omitted key would silently
    // keep the old override through deepMerge; a null entry resolves to the
    // defaults and actually persists the clear.
    expect(clearedBoth[project]).toEqual({ keyPrefix: null, accentColor: null });
  });

  it("normalizes a blank prefix input to null", () => {
    expect(normalizeKeyPrefixInput("  T3 ")).toBe("T3");
    expect(normalizeKeyPrefixInput("   ")).toBe(null);
  });
});

describe("per-instance concurrency map", () => {
  const instance = ProviderInstanceId.make("codex");

  it("sets a ceiling, and stores null (not a deleted key) when cleared", () => {
    const set = setBoardInstanceConcurrency({}, instance, 2);
    expect(set[instance]).toBe(2);
    // Cleared caps persist as null, since deepMerge cannot delete map keys.
    expect(setBoardInstanceConcurrency(set, instance, null)[instance]).toBe(null);
    expect(setBoardInstanceConcurrency(set, instance, 0)[instance]).toBe(null);
  });
});
