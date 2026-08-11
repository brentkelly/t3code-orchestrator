/**
 * T3o label chip colour helpers (t3o-06a), board-owned.
 *
 * Contrast is COMPUTED, never chosen: a user picks any swatch (or arbitrary
 * hex) and the foreground is derived from the colour's WCAG relative
 * luminance, so a chip stays readable in light and dark. Ported from the
 * prototype's `keyPillStyle`. Chips read names and colours from the board's
 * single label catalogue by id — never from data denormalised onto the card.
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
 * A card label chip's fill and text. Unlike the key pill — a SOLID swatch that
 * needs the black/white luminance split above — a chip is a soft tint of the
 * label colour, so it reads as a tag rather than a badge and several chips on
 * one card stay quiet. Contrast is still computed rather than chosen: the text
 * is the label colour carried most of the way toward the surface foreground,
 * which stays legible over the 14% fill in either theme. (The prototype's
 * `typeStyle`.)
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

/** What a chip needs to render one label id: the resolved label plus its
    display state. `missing` — the id is not in the catalogue at all (a hard
    edge) — renders a muted placeholder, as does a tombstoned (`deleted`)
    label, so a card's history stays honest rather than silently dropping a
    reference. */
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
