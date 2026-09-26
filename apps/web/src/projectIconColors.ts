import type { ProjectIconColor } from "@t3tools/contracts";

/**
 * The colours offered for a project icon. Labels are UI text only: the hex is
 * what gets persisted, so re-tuning an entry here cannot silently re-tint a
 * project that already picked it.
 */
export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly hex: string;
  readonly label: string;
}> = [
  { hex: "#c2544f", label: "Brick red" },
  { hex: "#d08a45", label: "Burnt orange" },
  { hex: "#c9b34e", label: "Mustard" },
  { hex: "#7e9a4b", label: "Olive green" },
  { hex: "#3f9a8c", label: "Teal" },
  { hex: "#4f7db3", label: "Steel blue" },
  { hex: "#7b5fa8", label: "Muted violet" },
  { hex: "#b35f8f", label: "Dusty magenta" },
  { hex: "#8a5a3c", label: "Walnut brown" },
  { hex: "#6b7280", label: "Slate grey" },
];

/** The colour a value that cannot be resolved renders as. */
export const DEFAULT_PROJECT_ICON_COLOR = "#4f7db3";

/**
 * The Tailwind palette names projects were saved with before the hex palette.
 * Lossy and deterministic by design: this runs at render time rather than as a
 * migration, because the colour lives in immutable events and a rewritten
 * projection would be undone by the next replay.
 */
const LEGACY_COLOR_HEXES: Record<string, string> = {
  gray: "#6b7280",
  red: "#c2544f",
  orange: "#d08a45",
  amber: "#d08a45",
  yellow: "#c9b34e",
  lime: "#7e9a4b",
  green: "#7e9a4b",
  emerald: "#3f9a8c",
  teal: "#3f9a8c",
  cyan: "#3f9a8c",
  sky: "#4f7db3",
  blue: "#4f7db3",
  indigo: "#7b5fa8",
  violet: "#7b5fa8",
  purple: "#7b5fa8",
  fuchsia: "#b35f8f",
  pink: "#b35f8f",
  rose: "#c2544f",
};

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Normalises typed input into a lowercase six-digit hex, accepting shorthand and
 * a missing `#`. Returns null for anything that is not a hex colour, which is
 * what the picker uses to mark its field invalid and block saving.
 */
export function parseHexColor(input: string): string | null {
  const match = HEX_PATTERN.exec(input.trim());
  const digits = match?.[1]?.toLowerCase();
  if (!digits) return null;
  return `#${digits.length === 3 ? Array.from(digits, (digit) => digit + digit).join("") : digits}`;
}

/** True when a hex is one of the offered palette entries, compared case-insensitively. */
export function isPaletteColor(hex: string): boolean {
  const normalized = parseHexColor(hex);
  return normalized !== null && PROJECT_ICON_COLORS.some((option) => option.hex === normalized);
}

/**
 * Resolves any stored colour — a current hex or a retired Tailwind name — into
 * the hex to render. Every render site goes through this, so no caller can
 * forget that legacy values are still in the database.
 */
export function resolveProjectIconColor(color: ProjectIconColor): string {
  return (
    parseHexColor(color) ?? LEGACY_COLOR_HEXES[color.toLowerCase()] ?? DEFAULT_PROJECT_ICON_COLOR
  );
}
