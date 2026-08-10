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
  /** Tinted key pill (background + readable text in both appearances). */
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
  blue: { dot: "bg-blue-500", pill: "bg-blue-500/15 text-blue-700 dark:text-blue-300" },
  emerald: {
    dot: "bg-emerald-500",
    pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  violet: { dot: "bg-violet-500", pill: "bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  amber: { dot: "bg-amber-500", pill: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  rose: { dot: "bg-rose-500", pill: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
  cyan: { dot: "bg-cyan-500", pill: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300" },
  orange: { dot: "bg-orange-500", pill: "bg-orange-500/15 text-orange-700 dark:text-orange-300" },
  teal: { dot: "bg-teal-500", pill: "bg-teal-500/15 text-teal-700 dark:text-teal-300" },
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
