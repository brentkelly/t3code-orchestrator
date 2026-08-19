import {
  DEFAULT_BOARD_STAGE_EXECUTION,
  ProviderInstanceId,
  type BoardProjectSettings,
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
  it("materialises a full entry from defaults when editing a never-configured stage", () => {
    // Editing one field of a stage absent from the map starts from the
    // all-defaults config and produces a complete entry (t3o-15).
    const next = setBoardStageExecution({}, "building", { autoExecute: true });
    expect(next.building).toEqual({ ...DEFAULT_BOARD_STAGE_EXECUTION, autoExecute: true });
  });

  it("patches one field without mutating the input, keyed by stage id", () => {
    const pipeline = { building: { ...DEFAULT_BOARD_STAGE_EXECUTION, prompt: "old" } };
    const edited = setBoardStageExecution(pipeline, "building", { prompt: "new" });
    expect(edited.building!.prompt).toBe("new");
    expect(pipeline.building.prompt).toBe("old"); // original untouched

    // A different stage id gets its own entry; existing ones are preserved, so
    // a rename (a new key) never orphans another stage's config.
    const withReview = setBoardStageExecution(edited, "review", { maxAttempts: 3 });
    expect(withReview.review!.maxAttempts).toBe(3);
    expect(withReview.building!.prompt).toBe("new");
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
