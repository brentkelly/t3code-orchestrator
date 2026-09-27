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
  /** The accent's fill, as authored. Exposed so the pill's computed
      foreground can be asserted against it (see projectAccent.test.ts). */
  readonly hex: string;
  /** Solid legend/status dot. */
  readonly dot: string;
  /**
   * Key pill: a SOLID fill of the accent, so the card's identity reads as a
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
 * icon picker's swatch (`bg-<name>-500`) paints, so a card's pill matches the
 * project's swatch.
 */
export const PROJECT_ICON_ACCENTS: Readonly<Record<ProjectIconColor, ProjectAccent>> = {
  gray: { hex: "#6a7282", dot: "bg-[#6a7282]", pill: "bg-[#6a7282] text-white" },
  red: { hex: "#fb2c36", dot: "bg-[#fb2c36]", pill: "bg-[#fb2c36] text-white" },
  orange: { hex: "#ff6900", dot: "bg-[#ff6900]", pill: "bg-[#ff6900] text-white" },
  amber: { hex: "#fe9a00", dot: "bg-[#fe9a00]", pill: "bg-[#fe9a00] text-white" },
  yellow: { hex: "#f0b100", dot: "bg-[#f0b100]", pill: "bg-[#f0b100] text-[#26262b]" },
  lime: { hex: "#7ccf00", dot: "bg-[#7ccf00]", pill: "bg-[#7ccf00] text-[#26262b]" },
  green: { hex: "#00c950", dot: "bg-[#00c950]", pill: "bg-[#00c950] text-white" },
  emerald: { hex: "#00bc7d", dot: "bg-[#00bc7d]", pill: "bg-[#00bc7d] text-white" },
  teal: { hex: "#00bba7", dot: "bg-[#00bba7]", pill: "bg-[#00bba7] text-white" },
  cyan: { hex: "#00b8db", dot: "bg-[#00b8db]", pill: "bg-[#00b8db] text-white" },
  sky: { hex: "#00a6f4", dot: "bg-[#00a6f4]", pill: "bg-[#00a6f4] text-white" },
  blue: { hex: "#2b7fff", dot: "bg-[#2b7fff]", pill: "bg-[#2b7fff] text-white" },
  indigo: { hex: "#615fff", dot: "bg-[#615fff]", pill: "bg-[#615fff] text-white" },
  violet: { hex: "#8e51ff", dot: "bg-[#8e51ff]", pill: "bg-[#8e51ff] text-white" },
  purple: { hex: "#ad46ff", dot: "bg-[#ad46ff]", pill: "bg-[#ad46ff] text-white" },
  fuchsia: { hex: "#e12afb", dot: "bg-[#e12afb]", pill: "bg-[#e12afb] text-white" },
  pink: { hex: "#f6339a", dot: "bg-[#f6339a]", pill: "bg-[#f6339a] text-white" },
  rose: { hex: "#ff2056", dot: "bg-[#ff2056]", pill: "bg-[#ff2056] text-white" },
};

/**
 * The hash fallback for a project with no icon colour. The first three are the
 * prototype's own project colours, in its order; the order is load-bearing, as
 * reordering it would recolour every such project.
 */
export const PROJECT_HASH_ACCENTS: ReadonlyArray<ProjectAccent> = [
  { hex: "#9400ff", dot: "bg-[#9400ff]", pill: "bg-[#9400ff] text-white" },
  { hex: "#38bdf8", dot: "bg-[#38bdf8]", pill: "bg-[#38bdf8] text-white" },
  { hex: "#f59e0b", dot: "bg-[#f59e0b]", pill: "bg-[#f59e0b] text-white" },
  // Same register — soft, mid-tone, none of them fully saturated.
  { hex: "#34d399", dot: "bg-[#34d399]", pill: "bg-[#34d399] text-[#26262b]" },
  { hex: "#fb7185", dot: "bg-[#fb7185]", pill: "bg-[#fb7185] text-white" },
  { hex: "#22d3ee", dot: "bg-[#22d3ee]", pill: "bg-[#22d3ee] text-[#26262b]" },
  { hex: "#fb923c", dot: "bg-[#fb923c]", pill: "bg-[#fb923c] text-white" },
  { hex: "#2dd4bf", dot: "bg-[#2dd4bf]", pill: "bg-[#2dd4bf] text-[#26262b]" },
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
