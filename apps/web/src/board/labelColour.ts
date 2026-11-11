/**
 * Label chip colours. Contrast is computed from the colour's WCAG luminance,
 * never chosen, so any swatch stays readable in light and dark.
 */
import type { BoardLabel, BoardLabelId } from "@t3tools/contracts";

/**
 * Readable foreground (near-black or white) for a chip filled with `hex`,
 * from the colour's sRGB relative luminance. `#26262b` above the 0.45
 * threshold (light fills), `#ffffff` below (dark fills) — the prototype's
 * exact split.
 */
export function boardLabelForeground(hex: string): string {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((component) => component + component)
          .join("")
      : raw;
  const channel = (start: number) => parseInt(full.slice(start, start + 2), 16) / 255;
  const linearise = (value: number) =>
    value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  const luminance =
    0.2126 * linearise(channel(0)) +
    0.7152 * linearise(channel(2)) +
    0.0722 * linearise(channel(4));
  return luminance > 0.45 ? "#26262b" : "#ffffff";
}

/**
 * A label chip's fill and text: a soft tint of the label colour, with text
 * carried most of the way toward the surface foreground so it stays legible
 * over the 14% fill in either theme.
 */
export function boardLabelChipStyle(hex: string): { background: string; color: string } {
  return {
    background: `color-mix(in srgb, ${hex} 14%, transparent)`,
    color: `color-mix(in srgb, ${hex} 78%, var(--foreground))`,
  };
}

/** Index the catalogue by id for O(1) chip resolution. */
export function indexBoardLabels(
  labels: ReadonlyArray<BoardLabel>,
): ReadonlyMap<BoardLabelId, BoardLabel> {
  return new Map(labels.map((label) => [label.labelId, label]));
}

/** A label id resolved for a chip. `missing` and `deleted` labels render a muted
    placeholder so a card's history keeps the reference. */
export interface ResolvedBoardLabel {
  readonly labelId: BoardLabelId;
  readonly name: string;
  readonly colour: string | null;
  readonly deleted: boolean;
  readonly missing: boolean;
}

export function resolveBoardLabels(
  labelIds: ReadonlyArray<BoardLabelId>,
  index: ReadonlyMap<BoardLabelId, BoardLabel>,
): ReadonlyArray<ResolvedBoardLabel> {
  return labelIds.map((labelId) => {
    const label = index.get(labelId);
    if (label === undefined) {
      return { labelId, name: "unknown label", colour: null, deleted: false, missing: true };
    }
    return {
      labelId,
      name: label.name,
      colour: label.colour,
      deleted: label.deletedAt !== null,
      missing: false,
    };
  });
}

/** What the chip row renders for one card (or one picker trigger): the first
    `cap` labels, plus a count of the rest and their names for the `+N`
    tooltip. Shared by `BoardLabelChips` and the label picker's trigger so the
    two cannot drift on how many chips fit before the row grows. */
export interface BoardLabelChipRows {
  readonly visible: ReadonlyArray<ResolvedBoardLabel>;
  readonly overflow: number;
  readonly overflowNames: ReadonlyArray<string>;
}

export function boardLabelChipRows(
  labelIds: ReadonlyArray<BoardLabelId>,
  index: ReadonlyMap<BoardLabelId, BoardLabel>,
  cap: number,
): BoardLabelChipRows {
  const resolved = resolveBoardLabels(labelIds, index);
  const visible = resolved.slice(0, cap);
  const hidden = resolved.slice(visible.length);
  return {
    visible,
    overflow: hidden.length,
    overflowNames: hidden.map((label) => label.name),
  };
}

/**
 * A picker row's selected style: tint, ring and a 3px left bar, since the list
 * stays open across picks. The bar rides in the box-shadow so selecting cannot
 * shift the label. Unselected rows get no style.
 */
export function boardLabelRowStyle(
  colour: string | null,
  selected: boolean,
): { background: string; boxShadow: string } | undefined {
  if (!selected || colour === null) return undefined;
  return {
    background: `color-mix(in srgb, ${colour} 16%, var(--popover))`,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${colour} 50%, transparent), inset 3px 0 0 ${colour}`,
  };
}
