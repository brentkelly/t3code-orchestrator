import { describe, expect, it } from "vite-plus/test";
import {
  filterProjectIconNames,
  firstEmoji,
  isPaletteColor,
  parseHexColor,
  PROJECT_ICON_COLORS,
  resolveProjectIconColor,
} from "./projectIconOptions";

describe("projectIconOptions", () => {
  it("searches across the full Lucide set", () => {
    expect(filterProjectIconNames("alarm clock")).toContain("alarm-clock");
    expect(filterProjectIconNames("alarm  \tclock")).toContain("alarm-clock");
  });

  it("extracts one complete emoji grapheme", () => {
    expect(firstEmoji("  👩🏽‍💻 hello")).toBe("👩🏽‍💻");
    expect(firstEmoji("🇺🇸 project")).toBe("🇺🇸");
    expect(firstEmoji("1️⃣ project")).toBe("1️⃣");
    expect(firstEmoji("plain text")).toBeNull();
  });

  it("offers the ten palette colors from the brief, in order", () => {
    expect(PROJECT_ICON_COLORS.map((option) => option.hex)).toEqual([
      "#c2544f",
      "#d08a45",
      "#c9b34e",
      "#7e9a4b",
      "#3f9a8c",
      "#4f7db3",
      "#7b5fa8",
      "#b35f8f",
      "#8a5a3c",
      "#6b7280",
    ]);
    expect(PROJECT_ICON_COLORS.map((option) => option.label)).toEqual([
      "Brick red",
      "Burnt orange",
      "Mustard",
      "Olive green",
      "Teal",
      "Steel blue",
      "Muted violet",
      "Dusty magenta",
      "Walnut brown",
      "Slate grey",
    ]);
  });
});

describe("resolveProjectIconColor", () => {
  it.each([
    ["gray", "#6b7280"],
    ["red", "#c2544f"],
    ["orange", "#d08a45"],
    ["amber", "#d08a45"],
    ["yellow", "#c9b34e"],
    ["lime", "#7e9a4b"],
    ["green", "#7e9a4b"],
    ["emerald", "#3f9a8c"],
    ["teal", "#3f9a8c"],
    ["cyan", "#3f9a8c"],
    ["sky", "#4f7db3"],
    ["blue", "#4f7db3"],
    ["indigo", "#7b5fa8"],
    ["violet", "#7b5fa8"],
    ["purple", "#7b5fa8"],
    ["fuchsia", "#b35f8f"],
    ["pink", "#b35f8f"],
    ["rose", "#c2544f"],
  ])("maps the retired name %s onto %s", (legacy, expected) => {
    expect(resolveProjectIconColor(legacy)).toBe(expected);
  });

  it("resolves every retired name to a color still in the palette", () => {
    const legacyNames = [
      "gray",
      "red",
      "orange",
      "amber",
      "yellow",
      "lime",
      "green",
      "emerald",
      "teal",
      "cyan",
      "sky",
      "blue",
      "indigo",
      "violet",
      "purple",
      "fuchsia",
      "pink",
      "rose",
    ];
    for (const name of legacyNames) {
      expect(isPaletteColor(resolveProjectIconColor(name))).toBe(true);
    }
  });

  it("passes a stored hex through, normalized to lowercase", () => {
    expect(resolveProjectIconColor("#8a5a3c")).toBe("#8a5a3c");
    expect(resolveProjectIconColor("#A1B2C3")).toBe("#a1b2c3");
  });

  it("falls back to steel blue for anything it cannot resolve", () => {
    expect(resolveProjectIconColor("chartreuse")).toBe("#4f7db3");
    expect(resolveProjectIconColor("")).toBe("#4f7db3");
  });
});

describe("parseHexColor", () => {
  it.each([
    ["#aabbcc", "#aabbcc"],
    ["aabbcc", "#aabbcc"],
    ["#AABBCC", "#aabbcc"],
    ["  #AaBbCc  ", "#aabbcc"],
    ["#abc", "#aabbcc"],
    ["abc", "#aabbcc"],
    ["#ABC", "#aabbcc"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(parseHexColor(input)).toBe(expected);
  });

  it.each([[""], ["#"], ["#xyz"], ["#ab"], ["#abcd"], ["#aabbccdd"], ["red-500"], ["rgb(1,2,3)"]])(
    "rejects %s",
    (input) => {
      expect(parseHexColor(input)).toBeNull();
    },
  );
});

describe("isPaletteColor", () => {
  it("recognizes a palette entry regardless of casing", () => {
    expect(isPaletteColor("#7b5fa8")).toBe(true);
    expect(isPaletteColor("#7B5FA8")).toBe(true);
  });

  it("rejects a custom hex and junk", () => {
    expect(isPaletteColor("#123456")).toBe(false);
    expect(isPaletteColor("violet")).toBe(false);
  });
});
