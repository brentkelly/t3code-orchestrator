/**
 * The accent palette is authored as literal Tailwind arbitrary values (Tailwind
 * scans source text, so an interpolated class would emit no CSS). That means
 * each pill's foreground is written by hand beside its fill, and a typo would
 * ship an unreadable pill. These tests pin the hand-written values to the same
 * luminance rule the label chips use.
 */
import { describe, expect, it } from "vite-plus/test";

import { boardLabelForeground } from "./labelColour";
import {
  PROJECT_ACCENTS_BY_NAME,
  PROJECT_ACCENT_NAMES,
  projectAccent,
  type ProjectAccentName,
} from "./projectAccent";
import { ProjectId } from "@t3tools/contracts";

describe("project accent palette", () => {
  it("computes every pill foreground from its own fill", () => {
    for (const name of PROJECT_ACCENT_NAMES) {
      const accent = PROJECT_ACCENTS_BY_NAME[name];
      const expected = boardLabelForeground(accent.hex);
      expect(accent.pill, `${name} pill foreground`).toBe(
        `bg-[${accent.hex}] text-${expected === "#ffffff" ? "white" : `[${expected}]`}`,
      );
    }
  });

  it("fills the dot and the pill from the same hex", () => {
    for (const name of PROJECT_ACCENT_NAMES) {
      const accent = PROJECT_ACCENTS_BY_NAME[name];
      expect(accent.dot).toBe(`bg-[${accent.hex}]`);
      expect(accent.pill.startsWith(`bg-[${accent.hex}] `)).toBe(true);
    }
  });

  it("leads with the first project's accent, then the prototype's, in order", () => {
    expect(PROJECT_ACCENT_NAMES.slice(0, 3)).toEqual(["violet", "blue", "amber"]);
    expect(
      ["violet", "blue", "amber"].map((n) => PROJECT_ACCENTS_BY_NAME[n as ProjectAccentName].hex),
    ).toEqual(["#9400ff", "#38bdf8", "#f59e0b"]);
  });

  it("honours a configured accent name and otherwise hashes deterministically", () => {
    const project = ProjectId.make("project-1");
    expect(projectAccent(project, "amber")).toBe(PROJECT_ACCENTS_BY_NAME.amber);
    // Unknown/unset falls back to the hash, which must be stable.
    expect(projectAccent(project, "not-a-name")).toBe(projectAccent(project, null));
    expect(projectAccent(project)).toBe(projectAccent(project));
  });
});
