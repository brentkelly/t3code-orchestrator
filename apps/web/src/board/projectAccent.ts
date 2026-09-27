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
  /** The accent's fill, as authored. */
  readonly hex: string;
  /** Solid legend/status dot. */
  readonly dot: string;
  /** The key pill's fill: `hex` at half its HSL saturation, same hue and
      lightness, so the card ID reads quieter than the accent dot. Exposed so
      the test can derive it from `hex` and check the pill's foreground. */
  readonly pillHex: string;
  /**
   * Key pill: a SOLID fill of `pillHex`, so the card's identity reads as a
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
 * icon picker's swatch (`bg-<name>-500`) paints, so a card's dot matches the
 * project's swatch and its pill is a muted version of it.
 */
export const PROJECT_ICON_ACCENTS: Readonly<Record<ProjectIconColor, ProjectAccent>> = {
  gray: {
    hex: "#6a7282",
    dot: "bg-[#6a7282]",
    pillHex: "#70747c",
    pill: "bg-[#70747c] text-white",
  },
  red: { hex: "#fb2c36", dot: "bg-[#fb2c36]", pillHex: "#c76065", pill: "bg-[#c76065] text-white" },
  orange: {
    hex: "#ff6900",
    dot: "bg-[#ff6900]",
    pillHex: "#bf7440",
    pill: "bg-[#bf7440] text-white",
  },
  amber: {
    hex: "#fe9a00",
    dot: "bg-[#fe9a00]",
    pillHex: "#bf8d40",
    pill: "bg-[#bf8d40] text-white",
  },
  yellow: {
    hex: "#f0b100",
    dot: "bg-[#f0b100]",
    pillHex: "#b4943c",
    pill: "bg-[#b4943c] text-white",
  },
  lime: {
    hex: "#7ccf00",
    dot: "bg-[#7ccf00]",
    pillHex: "#729b34",
    pill: "bg-[#729b34] text-white",
  },
  green: {
    hex: "#00c950",
    dot: "bg-[#00c950]",
    pillHex: "#32975a",
    pill: "bg-[#32975a] text-white",
  },
  emerald: {
    hex: "#00bc7d",
    dot: "bg-[#00bc7d]",
    pillHex: "#2f8d6e",
    pill: "bg-[#2f8d6e] text-white",
  },
  teal: {
    hex: "#00bba7",
    dot: "bg-[#00bba7]",
    pillHex: "#2f8c82",
    pill: "bg-[#2f8c82] text-white",
  },
  cyan: {
    hex: "#00b8db",
    dot: "bg-[#00b8db]",
    pillHex: "#3793a4",
    pill: "bg-[#3793a4] text-white",
  },
  sky: { hex: "#00a6f4", dot: "bg-[#00a6f4]", pillHex: "#3d90b7", pill: "bg-[#3d90b7] text-white" },
  blue: {
    hex: "#2b7fff",
    dot: "bg-[#2b7fff]",
    pillHex: "#608aca",
    pill: "bg-[#608aca] text-white",
  },
  indigo: {
    hex: "#615fff",
    dot: "bg-[#615fff]",
    pillHex: "#8887d7",
    pill: "bg-[#8887d7] text-white",
  },
  violet: {
    hex: "#8e51ff",
    dot: "bg-[#8e51ff]",
    pillHex: "#9b7dd3",
    pill: "bg-[#9b7dd3] text-white",
  },
  purple: {
    hex: "#ad46ff",
    dot: "bg-[#ad46ff]",
    pillHex: "#a874d1",
    pill: "bg-[#a874d1] text-white",
  },
  fuchsia: {
    hex: "#e12afb",
    dot: "bg-[#e12afb]",
    pillHex: "#ba5ec7",
    pill: "bg-[#ba5ec7] text-white",
  },
  pink: {
    hex: "#f6339a",
    dot: "bg-[#f6339a]",
    pillHex: "#c56497",
    pill: "bg-[#c56497] text-white",
  },
  rose: {
    hex: "#ff2056",
    dot: "bg-[#ff2056]",
    pillHex: "#c75873",
    pill: "bg-[#c75873] text-white",
  },
};

/**
 * The hash fallback for a project with no icon colour. The first three are the
 * prototype's own project colours, in its order; the order is load-bearing, as
 * reordering it would recolour every such project.
 */
export const PROJECT_HASH_ACCENTS: ReadonlyArray<ProjectAccent> = [
  { hex: "#9400ff", dot: "bg-[#9400ff]", pillHex: "#8a40bf", pill: "bg-[#8a40bf] text-white" },
  { hex: "#38bdf8", dot: "bg-[#38bdf8]", pillHex: "#68abc8", pill: "bg-[#68abc8] text-white" },
  { hex: "#f59e0b", dot: "bg-[#f59e0b]", pillHex: "#bb8f46", pill: "bg-[#bb8f46] text-white" },
  // Same register — soft, mid-tone, none of them fully saturated.
  { hex: "#34d399", dot: "bg-[#34d399]", pillHex: "#5cab8e", pill: "bg-[#5cab8e] text-white" },
  { hex: "#fb7185", dot: "bg-[#fb7185]", pillHex: "#d8939e", pill: "bg-[#d8939e] text-white" },
  { hex: "#22d3ee", dot: "bg-[#22d3ee]", pillHex: "#55aebb", pill: "bg-[#55aebb] text-white" },
  { hex: "#fb923c", dot: "bg-[#fb923c]", pillHex: "#cb976c", pill: "bg-[#cb976c] text-white" },
  { hex: "#2dd4bf", dot: "bg-[#2dd4bf]", pillHex: "#57aaa0", pill: "bg-[#57aaa0] text-white" },
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
