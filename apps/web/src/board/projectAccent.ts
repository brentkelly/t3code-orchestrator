/**
 * T3o per-project accent colour (t3o-05, settings-backed in t3o-07).
 *
 * The accent is a named hue from the app's Tailwind palette. When a project
 * has a configured accent (Settings → Board, `BoardSettings.projects`), that
 * name is used; otherwise the colour is a deterministic hash of the
 * `ProjectId` so an unconfigured project still gets a stable, distinct colour.
 * Every consumer renders from the returned class set, so wiring the setting was
 * a matter of passing the configured name in — the shape here is unchanged.
 */
import type { ProjectId } from "@t3tools/contracts";

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
   * rather than being white everywhere — these are deliberately desaturated
   * fills, and white on the lighter ones would be unreadable.
   */
  readonly pill: string;
}

/**
 * The palette names, in menu order — the accent-picker options in Settings.
 * The first three are the prototype's own project colours, in its order, so a
 * fresh board looks like the mockup. The names are unchanged from the original
 * set so an already-configured `BoardSettings.accentColor` never orphans.
 */
export const PROJECT_ACCENT_NAMES = [
  "violet",
  "blue",
  "amber",
  "emerald",
  "rose",
  "cyan",
  "orange",
  "teal",
] as const;
export type ProjectAccentName = (typeof PROJECT_ACCENT_NAMES)[number];

/**
 * Fills are literal arbitrary values, never interpolated: Tailwind generates
 * utilities by scanning source text, so a `bg-[${hex}]` built at runtime would
 * emit no CSS at all. Foregrounds are the luminance split applied to the fill
 * beside them — the test asserts each one against `boardLabelForeground`, so a
 * hand-written mismatch cannot survive.
 */
export const PROJECT_ACCENTS_BY_NAME: Readonly<Record<ProjectAccentName, ProjectAccent>> = {
  // The prototype's three, in its order.
  violet: { hex: "#8b8bf5", dot: "bg-[#8b8bf5]", pill: "bg-[#8b8bf5] text-white" },
  blue: { hex: "#38bdf8", dot: "bg-[#38bdf8]", pill: "bg-[#38bdf8] text-white" },
  amber: { hex: "#f59e0b", dot: "bg-[#f59e0b]", pill: "bg-[#f59e0b] text-white" },
  // Same register — soft, mid-tone, none of them fully saturated.
  emerald: { hex: "#34d399", dot: "bg-[#34d399]", pill: "bg-[#34d399] text-[#26262b]" },
  rose: { hex: "#fb7185", dot: "bg-[#fb7185]", pill: "bg-[#fb7185] text-white" },
  cyan: { hex: "#22d3ee", dot: "bg-[#22d3ee]", pill: "bg-[#22d3ee] text-[#26262b]" },
  orange: { hex: "#fb923c", dot: "bg-[#fb923c]", pill: "bg-[#fb923c] text-white" },
  teal: { hex: "#2dd4bf", dot: "bg-[#2dd4bf]", pill: "bg-[#2dd4bf] text-[#26262b]" },
};

const PROJECT_ACCENTS: ReadonlyArray<ProjectAccent> = PROJECT_ACCENT_NAMES.map(
  (name) => PROJECT_ACCENTS_BY_NAME[name],
);

export function isProjectAccentName(value: string | null | undefined): value is ProjectAccentName {
  return value != null && value in PROJECT_ACCENTS_BY_NAME;
}

/** FNV-1a over the id: stable across sessions and clients, no stored state. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The accent for a project: the configured palette name when one is set and
 * recognised, else the deterministic hash fallback. `configuredAccent` is the
 * value of `BoardSettings.projects[projectId].accentColor` (callers resolve it
 * with `resolveBoardProjectAccent`); passing nothing keeps the pre-settings
 * hash behaviour.
 */
export function projectAccent(
  projectId: ProjectId,
  configuredAccent?: string | null,
): ProjectAccent {
  if (isProjectAccentName(configuredAccent)) {
    return PROJECT_ACCENTS_BY_NAME[configuredAccent];
  }
  return PROJECT_ACCENTS[stableHash(projectId) % PROJECT_ACCENTS.length]!;
}
