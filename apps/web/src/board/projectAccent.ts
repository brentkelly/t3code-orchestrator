/**
 * T3o per-project accent colour (t3o-05).
 *
 * Per-project colours become a real setting in t3o-07; until then the colour
 * is a deterministic hash of the `ProjectId` into the app's existing
 * Tailwind hue palette. t3o-07 replaces the body of `projectAccent` with the
 * settings-backed lookup and nothing else changes — every consumer renders
 * from the returned class set.
 */
import type { ProjectId } from "@t3tools/contracts";

export interface ProjectAccent {
  /** Solid legend/status dot. */
  readonly dot: string;
  /** Tinted key pill (background + readable text in both appearances). */
  readonly pill: string;
}

const PROJECT_ACCENTS: ReadonlyArray<ProjectAccent> = [
  { dot: "bg-blue-500", pill: "bg-blue-500/15 text-blue-700 dark:text-blue-300" },
  { dot: "bg-emerald-500", pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  { dot: "bg-violet-500", pill: "bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  { dot: "bg-amber-500", pill: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  { dot: "bg-rose-500", pill: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
  { dot: "bg-cyan-500", pill: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300" },
  { dot: "bg-orange-500", pill: "bg-orange-500/15 text-orange-700 dark:text-orange-300" },
  { dot: "bg-teal-500", pill: "bg-teal-500/15 text-teal-700 dark:text-teal-300" },
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

export function projectAccent(projectId: ProjectId): ProjectAccent {
  return PROJECT_ACCENTS[stableHash(projectId) % PROJECT_ACCENTS.length]!;
}
