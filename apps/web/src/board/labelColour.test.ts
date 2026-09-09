/**
 * T3o label colour/geometry helpers. These are the visual rules the picker and
 * the card summary both depend on — how many chips fit before the row
 * collapses into `+N`, what a selected row looks like, and which foreground a
 * fill can carry — so they are asserted here rather than through a DOM.
 */
import { BoardLabelId, type BoardLabel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardLabelChipRows,
  boardLabelForeground,
  boardLabelRowStyle,
  indexBoardLabels,
} from "./labelColour";

const NOW = "2026-01-01T00:00:00.000Z";

function label(name: string, colour: string, deletedAt: string | null = null): BoardLabel {
  return {
    labelId: BoardLabelId.make(`label-${name}`),
    name,
    colour,
    deletedAt,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const id = (name: string) => BoardLabelId.make(`label-${name}`);

const catalogue = [
  label("Feature", "#3b82f6"),
  label("Bug", "#ef4444"),
  label("Chore", "#f59e0b"),
  label("Retired", "#a855f7", NOW),
];
const index = indexBoardLabels(catalogue);

describe("boardLabelChipRows", () => {
  it("shows every label and reports no overflow when the card is under the cap", () => {
    const rows = boardLabelChipRows([id("Feature")], index, 2);
    expect(rows.visible.map((row) => row.name)).toEqual(["Feature"]);
    expect(rows.overflow).toBe(0);
    expect(rows.overflowNames).toEqual([]);
  });

  it("shows exactly the cap without overflowing when the card sits on it", () => {
    const rows = boardLabelChipRows([id("Feature"), id("Bug")], index, 2);
    expect(rows.visible.map((row) => row.name)).toEqual(["Feature", "Bug"]);
    expect(rows.overflow).toBe(0);
  });

  it("collapses the rest into a counted overflow, in the card's own order", () => {
    const rows = boardLabelChipRows(
      [id("Chore"), id("Feature"), id("Bug"), id("Retired")],
      index,
      2,
    );
    expect(rows.visible.map((row) => row.name)).toEqual(["Chore", "Feature"]);
    expect(rows.overflow).toBe(2);
    // The names go to the `+N` tooltip, so a hidden label is counted and
    // nameable rather than invisible.
    expect(rows.overflowNames).toEqual(["Bug", "Retired"]);
  });

  it("keeps a deleted or unknown label in the row rather than dropping it", () => {
    const rows = boardLabelChipRows([id("Retired"), id("Ghost")], index, 2);
    expect(rows.visible[0]).toMatchObject({ name: "Retired", deleted: true, missing: false });
    expect(rows.visible[1]).toMatchObject({ name: "unknown label", missing: true, colour: null });
  });
});

describe("boardLabelRowStyle", () => {
  it("leaves an unselected row bare, so the hover class carries it", () => {
    expect(boardLabelRowStyle("#3b82f6", false)).toBeUndefined();
  });

  it("gives a selected row the tint, the colour-matched ring and the left bar", () => {
    const style = boardLabelRowStyle("#3b82f6", true);
    expect(style?.background).toBe("color-mix(in srgb, #3b82f6 16%, var(--popover))");
    expect(style?.boxShadow).toBe(
      "inset 0 0 0 1px color-mix(in srgb, #3b82f6 50%, transparent), inset 3px 0 0 #3b82f6",
    );
    // The bar is an INSET shadow, not a border, so selecting cannot shift the
    // row's text sideways.
    expect(style?.boxShadow).not.toContain("border");
  });

  it("has nothing to tint a colourless (unknown) label with", () => {
    expect(boardLabelRowStyle(null, true)).toBeUndefined();
  });
});

describe("boardLabelForeground", () => {
  it("computes the checkbox tick colour rather than assuming white", () => {
    // The yellow and lime swatches: a flat white tick all but disappears on
    // them, which is why the picker asks for a computed foreground.
    expect(boardLabelForeground("#eab308")).toBe("#26262b");
    expect(boardLabelForeground("#84cc16")).toBe("#26262b");
    expect(boardLabelForeground("#3b82f6")).toBe("#ffffff");
  });
});
