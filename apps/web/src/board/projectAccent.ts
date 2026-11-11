/**
 * Per-project accent colour: the project's icon colour when it has a Lucide icon
 * or monogram, otherwise a deterministic hash of the `ProjectId`.
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
   * Key pill: a solid fill of `mutedHex`, with the foreground from the
   * luminance split (white would be unreadable on the lighter fills).
   */
  readonly pill: string;
}

/*
 * Fills are literal `board-accent-*` classes, never interpolated: Tailwind scans
 * source text, so a runtime-built class emits no CSS. Each token's value lives in
 * board-theme.css; the test checks it equals `mutedHex`, and each foreground
 * against `boardLabelForeground`.
 */

/**
 * One accent per project icon colour: the Tailwind 500 shade, which is what the
 * icon picker's swatch (`bg-<name>-500`) paints. That swatch is `hex`; the
 * Board's dot and pill both use a muted version of it.
 */
export const PROJECT_ICON_ACCENTS: Readonly<Record<ProjectIconColor, ProjectAccent>> = {
  gray: {
    hex: "#6a7282",
    dot: "bg-board-accent-gray",
    mutedHex: "#70747c",
    pill: "bg-board-accent-gray text-white",
  },
  red: {
    hex: "#fb2c36",
    dot: "bg-board-accent-red",
    mutedHex: "#c76065",
    pill: "bg-board-accent-red text-white",
  },
  orange: {
    hex: "#ff6900",
    dot: "bg-board-accent-orange",
    mutedHex: "#bf7440",
    pill: "bg-board-accent-orange text-white",
  },
  amber: {
    hex: "#fe9a00",
    dot: "bg-board-accent-amber",
    mutedHex: "#bf8d40",
    pill: "bg-board-accent-amber text-white",
  },
  yellow: {
    hex: "#f0b100",
    dot: "bg-board-accent-yellow",
    mutedHex: "#b4943c",
    pill: "bg-board-accent-yellow text-white",
  },
  lime: {
    hex: "#7ccf00",
    dot: "bg-board-accent-lime",
    mutedHex: "#729b34",
    pill: "bg-board-accent-lime text-white",
  },
  green: {
    hex: "#00c950",
    dot: "bg-board-accent-green",
    mutedHex: "#32975a",
    pill: "bg-board-accent-green text-white",
  },
  emerald: {
    hex: "#00bc7d",
    dot: "bg-board-accent-emerald",
    mutedHex: "#2f8d6e",
    pill: "bg-board-accent-emerald text-white",
  },
  teal: {
    hex: "#00bba7",
    dot: "bg-board-accent-teal",
    mutedHex: "#2f8c82",
    pill: "bg-board-accent-teal text-white",
  },
  cyan: {
    hex: "#00b8db",
    dot: "bg-board-accent-cyan",
    mutedHex: "#3793a4",
    pill: "bg-board-accent-cyan text-white",
  },
  sky: {
    hex: "#00a6f4",
    dot: "bg-board-accent-sky",
    mutedHex: "#3d90b7",
    pill: "bg-board-accent-sky text-white",
  },
  blue: {
    hex: "#2b7fff",
    dot: "bg-board-accent-blue",
    mutedHex: "#608aca",
    pill: "bg-board-accent-blue text-white",
  },
  indigo: {
    hex: "#615fff",
    dot: "bg-board-accent-indigo",
    mutedHex: "#8887d7",
    pill: "bg-board-accent-indigo text-white",
  },
  violet: {
    hex: "#8e51ff",
    dot: "bg-board-accent-violet",
    mutedHex: "#9b7dd3",
    pill: "bg-board-accent-violet text-white",
  },
  purple: {
    hex: "#ad46ff",
    dot: "bg-board-accent-purple",
    mutedHex: "#a874d1",
    pill: "bg-board-accent-purple text-white",
  },
  fuchsia: {
    hex: "#e12afb",
    dot: "bg-board-accent-fuchsia",
    mutedHex: "#ba5ec7",
    pill: "bg-board-accent-fuchsia text-white",
  },
  pink: {
    hex: "#f6339a",
    dot: "bg-board-accent-pink",
    mutedHex: "#c56497",
    pill: "bg-board-accent-pink text-white",
  },
  rose: {
    hex: "#ff2056",
    dot: "bg-board-accent-rose",
    mutedHex: "#c75873",
    pill: "bg-board-accent-rose text-white",
  },
};

/**
 * The hash fallback for a project with no icon colour. The first three are the
 * prototype's own project colours, in its order; the order is load-bearing, as
 * reordering it would recolour every such project.
 */
export const PROJECT_HASH_ACCENTS: ReadonlyArray<ProjectAccent> = [
  {
    hex: "#9400ff",
    dot: "bg-board-accent-hash-0",
    mutedHex: "#8a40bf",
    pill: "bg-board-accent-hash-0 text-white",
  },
  {
    hex: "#38bdf8",
    dot: "bg-board-accent-hash-1",
    mutedHex: "#68abc8",
    pill: "bg-board-accent-hash-1 text-white",
  },
  {
    hex: "#f59e0b",
    dot: "bg-board-accent-hash-2",
    mutedHex: "#bb8f46",
    pill: "bg-board-accent-hash-2 text-white",
  },
  // Same register — soft, mid-tone, none of them fully saturated.
  {
    hex: "#34d399",
    dot: "bg-board-accent-hash-3",
    mutedHex: "#5cab8e",
    pill: "bg-board-accent-hash-3 text-white",
  },
  {
    hex: "#fb7185",
    dot: "bg-board-accent-hash-4",
    mutedHex: "#d8939e",
    pill: "bg-board-accent-hash-4 text-white",
  },
  {
    hex: "#22d3ee",
    dot: "bg-board-accent-hash-5",
    mutedHex: "#55aebb",
    pill: "bg-board-accent-hash-5 text-white",
  },
  {
    hex: "#fb923c",
    dot: "bg-board-accent-hash-6",
    mutedHex: "#cb976c",
    pill: "bg-board-accent-hash-6 text-white",
  },
  {
    hex: "#2dd4bf",
    dot: "bg-board-accent-hash-7",
    mutedHex: "#57aaa0",
    pill: "bg-board-accent-hash-7 text-white",
  },
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
  return icon?.kind === "lucide" || icon?.kind === "monogram" ? icon.color : null;
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
