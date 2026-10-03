/**
 * T3o per-project accent colour (t3o-05; follows the project icon since T3O-4).
 *
 * A project has one colour, set in one place: its icon colour in project
 * settings. When the project's icon is a Lucide icon or monogram, its colour
 * name is the Board accent; otherwise (no icon override, a favicon, an emoji)
 * the colour is a deterministic hash of the `ProjectId` so the project still
 * gets a stable, distinct colour. Every consumer renders from the returned
 * class set, reading the icon from the project read model, so an icon colour
 * change recolours the Board live.
 */
import type { ProjectIconColor, ProjectIconOverride, ProjectId } from "@t3tools/contracts";

export interface ProjectAccent {
  /** The source swatch, as authored: the project icon colour's full shade. */
  readonly hex: string;
  /** Solid legend/status dot, filled with `mutedHex` so it matches the pill. */
  readonly dot: string;
  /** The Board's fill for this project: `hex` at half its HSL saturation, same
      hue and lightness. The dot and the key pill share it, so a project reads
      as one colour across the Board. Exposed so the test can derive it from
      `hex` and check the pill's foreground. */
  readonly mutedHex: string;
  /**
   * Key pill: a SOLID fill of `mutedHex`, so the card's identity reads as a
   * badge and stays distinct from the soft label chips beside it. The
   * foreground follows the prototype's luminance split (`boardLabelForeground`)
   * rather than being white everywhere — white on the lighter fills would be
   * unreadable.
   */
  readonly pill: string;
}

/*
 * Fills are literal arbitrary values, never interpolated: Tailwind generates
 * utilities by scanning source text, so a `bg-[${hex}]` built at runtime would
 * emit no CSS at all. Foregrounds are the luminance split applied to the fill
 * beside them — the test asserts each one against `boardLabelForeground`, so a
 * hand-written mismatch cannot survive.
 */

/**
 * One accent per project icon colour: the Tailwind 500 shade, which is what the
 * icon picker's swatch (`bg-<name>-500`) paints. That swatch is `hex`; the
 * Board's dot and pill both use a muted version of it.
 */
export const PROJECT_ICON_ACCENTS: Readonly<Record<ProjectIconColor, ProjectAccent>> = {
  gray: {
    hex: "#6a7282",
    dot: "bg-[#70747c]",
    mutedHex: "#70747c",
    pill: "bg-[#70747c] text-white",
  },
  red: {
    hex: "#fb2c36",
    dot: "bg-[#c76065]",
    mutedHex: "#c76065",
    pill: "bg-[#c76065] text-white",
  },
  orange: {
    hex: "#ff6900",
    dot: "bg-[#bf7440]",
    mutedHex: "#bf7440",
    pill: "bg-[#bf7440] text-white",
  },
  amber: {
    hex: "#fe9a00",
    dot: "bg-[#bf8d40]",
    mutedHex: "#bf8d40",
    pill: "bg-[#bf8d40] text-white",
  },
  yellow: {
    hex: "#f0b100",
    dot: "bg-[#b4943c]",
    mutedHex: "#b4943c",
    pill: "bg-[#b4943c] text-white",
  },
  lime: {
    hex: "#7ccf00",
    dot: "bg-[#729b34]",
    mutedHex: "#729b34",
    pill: "bg-[#729b34] text-white",
  },
  green: {
    hex: "#00c950",
    dot: "bg-[#32975a]",
    mutedHex: "#32975a",
    pill: "bg-[#32975a] text-white",
  },
  emerald: {
    hex: "#00bc7d",
    dot: "bg-[#2f8d6e]",
    mutedHex: "#2f8d6e",
    pill: "bg-[#2f8d6e] text-white",
  },
  teal: {
    hex: "#00bba7",
    dot: "bg-[#2f8c82]",
    mutedHex: "#2f8c82",
    pill: "bg-[#2f8c82] text-white",
  },
  cyan: {
    hex: "#00b8db",
    dot: "bg-[#3793a4]",
    mutedHex: "#3793a4",
    pill: "bg-[#3793a4] text-white",
  },
  sky: {
    hex: "#00a6f4",
    dot: "bg-[#3d90b7]",
    mutedHex: "#3d90b7",
    pill: "bg-[#3d90b7] text-white",
  },
  blue: {
    hex: "#2b7fff",
    dot: "bg-[#608aca]",
    mutedHex: "#608aca",
    pill: "bg-[#608aca] text-white",
  },
  indigo: {
    hex: "#615fff",
    dot: "bg-[#8887d7]",
    mutedHex: "#8887d7",
    pill: "bg-[#8887d7] text-white",
  },
  violet: {
    hex: "#8e51ff",
    dot: "bg-[#9b7dd3]",
    mutedHex: "#9b7dd3",
    pill: "bg-[#9b7dd3] text-white",
  },
  purple: {
    hex: "#ad46ff",
    dot: "bg-[#a874d1]",
    mutedHex: "#a874d1",
    pill: "bg-[#a874d1] text-white",
  },
  fuchsia: {
    hex: "#e12afb",
    dot: "bg-[#ba5ec7]",
    mutedHex: "#ba5ec7",
    pill: "bg-[#ba5ec7] text-white",
  },
  pink: {
    hex: "#f6339a",
    dot: "bg-[#c56497]",
    mutedHex: "#c56497",
    pill: "bg-[#c56497] text-white",
  },
  rose: {
    hex: "#ff2056",
    dot: "bg-[#c75873]",
    mutedHex: "#c75873",
    pill: "bg-[#c75873] text-white",
  },
};

/**
 * The hash fallback for a project with no icon colour. The first three are the
 * prototype's own project colours, in its order; the order is load-bearing, as
 * reordering it would recolour every such project.
 */
export const PROJECT_HASH_ACCENTS: ReadonlyArray<ProjectAccent> = [
  { hex: "#9400ff", dot: "bg-[#8a40bf]", mutedHex: "#8a40bf", pill: "bg-[#8a40bf] text-white" },
  { hex: "#38bdf8", dot: "bg-[#68abc8]", mutedHex: "#68abc8", pill: "bg-[#68abc8] text-white" },
  { hex: "#f59e0b", dot: "bg-[#bb8f46]", mutedHex: "#bb8f46", pill: "bg-[#bb8f46] text-white" },
  // Same register — soft, mid-tone, none of them fully saturated.
  { hex: "#34d399", dot: "bg-[#5cab8e]", mutedHex: "#5cab8e", pill: "bg-[#5cab8e] text-white" },
  { hex: "#fb7185", dot: "bg-[#d8939e]", mutedHex: "#d8939e", pill: "bg-[#d8939e] text-white" },
  { hex: "#22d3ee", dot: "bg-[#55aebb]", mutedHex: "#55aebb", pill: "bg-[#55aebb] text-white" },
  { hex: "#fb923c", dot: "bg-[#cb976c]", mutedHex: "#cb976c", pill: "bg-[#cb976c] text-white" },
  { hex: "#2dd4bf", dot: "bg-[#57aaa0]", mutedHex: "#57aaa0", pill: "bg-[#57aaa0] text-white" },
];

/** FNV-1a over the id: stable across sessions and clients, no stored state. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The colour a project's icon carries, or null when its icon has none
    (no override, a favicon, or an emoji). */
export function projectIconColorOf(
  project: { readonly projectIcon?: ProjectIconOverride | null | undefined } | null | undefined,
): ProjectIconColor | null {
  const icon = project?.projectIcon;
  return icon?.kind === "lucide" ? icon.color : null;
}

/**
 * The accent for a project: its icon colour when it has one, else the
 * deterministic hash fallback. Callers resolve `iconColor` from the project
 * read model with `projectIconColorOf`.
 */
export function projectAccent(
  projectId: ProjectId,
  iconColor?: ProjectIconColor | null,
): ProjectAccent {
  if (iconColor != null && Object.hasOwn(PROJECT_ICON_ACCENTS, iconColor)) {
    return PROJECT_ICON_ACCENTS[iconColor];
  }
  return PROJECT_HASH_ACCENTS[stableHash(projectId) % PROJECT_HASH_ACCENTS.length]!;
}
