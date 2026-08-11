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
  /** Solid legend/status dot. */
  readonly dot: string;
  /**
   * Key pill: a SOLID, saturated fill with white text, so the card's identity
   * reads as a badge and stays distinct from the soft label chips beside it.
   * The `-600` step is deliberate — white on the `-500` step falls to roughly
   * 2:1 on the lighter hues (amber, cyan), which is unreadable at pill size.
   */
  readonly pill: string;
}

/** The palette names, in menu order — the accent-picker options in Settings. */
export const PROJECT_ACCENT_NAMES = [
  "blue",
  "emerald",
  "violet",
  "amber",
  "rose",
  "cyan",
  "orange",
  "teal",
] as const;
export type ProjectAccentName = (typeof PROJECT_ACCENT_NAMES)[number];

export const PROJECT_ACCENTS_BY_NAME: Readonly<Record<ProjectAccentName, ProjectAccent>> = {
  blue: { dot: "bg-blue-500", pill: "bg-blue-600 text-white" },
  emerald: { dot: "bg-emerald-500", pill: "bg-emerald-600 text-white" },
  violet: { dot: "bg-violet-500", pill: "bg-violet-600 text-white" },
  amber: { dot: "bg-amber-500", pill: "bg-amber-600 text-white" },
  rose: { dot: "bg-rose-500", pill: "bg-rose-600 text-white" },
  cyan: { dot: "bg-cyan-500", pill: "bg-cyan-600 text-white" },
  orange: { dot: "bg-orange-500", pill: "bg-orange-600 text-white" },
  teal: { dot: "bg-teal-500", pill: "bg-teal-600 text-white" },
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
