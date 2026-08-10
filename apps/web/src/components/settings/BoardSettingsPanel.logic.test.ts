import { ProviderInstanceId, type BoardProjectSettings, type BoardStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendBoardStep,
  makeNewBoardStep,
  minutesToMs,
  msToMinutes,
  normalizeKeyPrefixInput,
  parsePositiveIntInput,
  removeBoardStep,
  setBoardInstanceConcurrency,
  setBoardProjectSetting,
  setBoardStepField,
} from "./BoardSettingsPanel.logic";

const step = (id: string): BoardStep => ({
  id,
  label: id,
  promptTemplate: "",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "m",
  timeoutMs: 60_000,
  maxAttempts: 1,
});

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

describe("step mutations", () => {
  it("assigns a unique id to a new step", () => {
    const existing = [step("step-1")];
    const next = makeNewBoardStep(existing);
    expect(existing.some((s) => s.id === next.id)).toBe(false);
    expect(next.model.length).toBeGreaterThan(0);
  });

  it("edits, appends and removes without mutating the input", () => {
    const steps = [step("a"), step("b")];
    const edited = setBoardStepField(steps, 1, { label: "renamed" });
    expect(edited[1]!.label).toBe("renamed");
    expect(steps[1]!.label).toBe("b"); // original untouched

    const appended = appendBoardStep(steps, step("c"));
    expect(appended.map((s) => s.id)).toEqual(["a", "b", "c"]);

    const removed = removeBoardStep(steps, 0);
    expect(removed.map((s) => s.id)).toEqual(["b"]);
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
