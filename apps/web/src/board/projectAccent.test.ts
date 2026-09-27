/**
 * The accent palette is authored as literal Tailwind arbitrary values (Tailwind
 * scans source text, so an interpolated class would emit no CSS). That means
 * each pill's foreground is written by hand beside its fill, and a typo would
 * ship an unreadable pill. These tests pin the hand-written values to the same
 * luminance rule the label chips use.
 */
import { describe, expect, it } from "vite-plus/test";

import { ProjectIconColor, ProjectId } from "@t3tools/contracts";
import { boardLabelForeground } from "./labelColour";
import {
  PROJECT_HASH_ACCENTS,
  PROJECT_ICON_ACCENTS,
  projectAccent,
  projectIconColorOf,
  type ProjectAccent,
} from "./projectAccent";

const ICON_COLORS = ProjectIconColor.literals;

const ALL_ACCENTS: ReadonlyArray<readonly [string, ProjectAccent]> = [
  ...ICON_COLORS.map((name) => [name, PROJECT_ICON_ACCENTS[name]] as const),
  ...PROJECT_HASH_ACCENTS.map((accent, index) => [`hash #${index}`, accent] as const),
];

describe("project accent palette", () => {
  it("has an accent for every project icon colour", () => {
    expect(Object.keys(PROJECT_ICON_ACCENTS).toSorted()).toEqual([...ICON_COLORS].toSorted());
  });

  it("computes every pill foreground from its own fill", () => {
    for (const [name, accent] of ALL_ACCENTS) {
      const expected = boardLabelForeground(accent.hex);
      expect(accent.pill, `${name} pill foreground`).toBe(
        `bg-[${accent.hex}] text-${expected === "#ffffff" ? "white" : `[${expected}]`}`,
      );
    }
  });

  it("fills the dot and the pill from the same hex", () => {
    for (const [, accent] of ALL_ACCENTS) {
      expect(accent.dot).toBe(`bg-[${accent.hex}]`);
      expect(accent.pill.startsWith(`bg-[${accent.hex}] `)).toBe(true);
    }
  });

  it("keeps the hash fallback's colours and order, so unconfigured projects keep their colour", () => {
    expect(PROJECT_HASH_ACCENTS.map((accent) => accent.hex)).toEqual([
      "#9400ff",
      "#38bdf8",
      "#f59e0b",
      "#34d399",
      "#fb7185",
      "#22d3ee",
      "#fb923c",
      "#2dd4bf",
    ]);
  });
});

describe("projectAccent", () => {
  const project = ProjectId.make("project-1");

  it("uses the project's icon colour when it has one", () => {
    expect(projectAccent(project, "sky")).toBe(PROJECT_ICON_ACCENTS.sky);
    expect(projectAccent(project, "gray")).toBe(PROJECT_ICON_ACCENTS.gray);
  });

  it("falls back to a stable hash colour without an icon colour", () => {
    const fallback = projectAccent(project, null);
    expect(PROJECT_HASH_ACCENTS).toContain(fallback);
    expect(projectAccent(project)).toBe(fallback);
    expect(projectAccent(ProjectId.make("project-1"), undefined)).toBe(fallback);
  });

  it("falls back to the hash for a colour name it does not know", () => {
    // A cached snapshot could carry a value this client's contract lacks.
    expect(projectAccent(project, "chartreuse" as ProjectIconColor)).toBe(
      projectAccent(project, null),
    );
  });
});

describe("projectIconColorOf", () => {
  it("reads the colour of a Lucide or monogram icon", () => {
    expect(
      projectIconColorOf({ projectIcon: { kind: "lucide", name: "rocket", color: "teal" } }),
    ).toBe("teal");
    expect(
      projectIconColorOf({
        projectIcon: { kind: "lucide", name: "rocket", color: "rose", monogram: "T3" },
      }),
    ).toBe("rose");
  });

  it("has no colour for an emoji, a missing override, or a missing project", () => {
    expect(projectIconColorOf({ projectIcon: { kind: "emoji", emoji: "🚀" } })).toBe(null);
    expect(projectIconColorOf({ projectIcon: null })).toBe(null);
    expect(projectIconColorOf({})).toBe(null);
    expect(projectIconColorOf(undefined)).toBe(null);
  });
});
