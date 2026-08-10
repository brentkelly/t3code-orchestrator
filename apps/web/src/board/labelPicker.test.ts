/**
 * T3o label chip colour + picker model (t3o-06a). Pure logic, no DOM: contrast
 * is computed from luminance, unknown/tombstoned labels resolve to a muted
 * placeholder, and the picker toggles membership / offers inline create.
 */
import type { BoardLabel } from "@t3tools/contracts";
import { BoardLabelId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardLabelForeground, resolveBoardLabels } from "./labelColour";
import { boardLabelPickerModel } from "./labelPickerModel";

const NOW = "2026-01-01T00:00:00.000Z";
const label = (id: string, overrides?: Partial<BoardLabel>): BoardLabel => ({
  labelId: BoardLabelId.make(id),
  name: id,
  colour: "#3b82f6",
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("boardLabelForeground", () => {
  it("picks white on a dark fill and near-black on a light fill", () => {
    expect(boardLabelForeground("#1e40af")).toBe("#ffffff");
    expect(boardLabelForeground("#eab308")).toBe("#26262b");
  });
  it("handles 3-digit hex", () => {
    expect(boardLabelForeground("#fff")).toBe("#26262b");
    expect(boardLabelForeground("#000")).toBe("#ffffff");
  });
});

describe("resolveBoardLabels", () => {
  const index = new Map([
    [BoardLabelId.make("live"), label("live", { name: "feature" })],
    [BoardLabelId.make("gone"), label("gone", { name: "legacy", deletedAt: NOW })],
  ]);

  it("resolves a live label to its name and colour", () => {
    const [resolved] = resolveBoardLabels([BoardLabelId.make("live")], index);
    expect(resolved).toMatchObject({
      name: "feature",
      colour: "#3b82f6",
      deleted: false,
      missing: false,
    });
  });

  it("flags a tombstoned label as deleted, keeping it visible", () => {
    const [resolved] = resolveBoardLabels([BoardLabelId.make("gone")], index);
    expect(resolved?.deleted).toBe(true);
    expect(resolved?.missing).toBe(false);
  });

  it("resolves an unknown id to a muted placeholder rather than dropping it", () => {
    const [resolved] = resolveBoardLabels([BoardLabelId.make("ghost")], index);
    expect(resolved).toMatchObject({ colour: null, missing: true });
  });
});

describe("boardLabelPickerModel", () => {
  const catalogue = [
    label("l-feature", { name: "feature" }),
    label("l-bug", { name: "bug" }),
    label("l-old", { name: "retired", deletedAt: NOW }),
  ];

  it("filters live labels case-insensitively and marks membership", () => {
    const model = boardLabelPickerModel({
      catalogue,
      selectedLabelIds: [BoardLabelId.make("l-feature")],
      query: "Feature",
    });
    expect(model.matches.map((row) => row.label.name)).toEqual(["feature"]);
    expect(model.matches[0]?.selected).toBe(true);
    // An exact (case-insensitive) name match offers no inline create.
    expect(model.canCreate).toBe(false);
  });

  it("offers an inline create when the query names no live label", () => {
    const model = boardLabelPickerModel({ catalogue, selectedLabelIds: [], query: "urgent" });
    expect(model.canCreate).toBe(true);
    expect(model.createName).toBe("urgent");
  });

  it("does not offer create for a name that collides case-insensitively", () => {
    const model = boardLabelPickerModel({ catalogue, selectedLabelIds: [], query: "  BUG " });
    expect(model.canCreate).toBe(false);
  });

  it("surfaces tombstoned labels in a separate restore section", () => {
    const model = boardLabelPickerModel({ catalogue, selectedLabelIds: [], query: "" });
    expect(model.deleted.map((label) => label.name)).toEqual(["retired"]);
    expect(model.matches.map((row) => row.label.name)).toEqual(["feature", "bug"]);
  });
});
