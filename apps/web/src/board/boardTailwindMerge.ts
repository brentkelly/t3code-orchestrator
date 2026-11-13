import { mergeConfigs, type Config } from "tailwind-merge";

/** The board's theme scales (board-theme.css), so `cn()` merges `text-board-11` as a
    font size and `shadow-board-*` as a shadow rather than as colours. */
export const BOARD_TAILWIND_MERGE_THEME = {
  text: [
    "board-9",
    "board-9-5",
    "board-10",
    "board-10-5",
    "board-11",
    "board-11-5",
    "board-12",
    "board-12-5",
    "board-13",
    "board-13-5",
    "board-15",
    "board-17",
    "board-21",
    "board-22",
  ],
  leading: [
    "board-1-3",
    "board-1-35",
    "board-1-4",
    "board-1-45",
    "board-1-55",
    "board-1-6",
    "board-1-7",
  ],
  tracking: [
    "board-n2",
    "board-n1-5",
    "board-n1",
    "board-2",
    "board-3",
    "board-4",
    "board-6",
    "board-7",
    "board-9",
  ],
  radius: [
    "board-3",
    "board-5",
    "board-7",
    "board-9",
    "board-10",
    "board-inner-md",
    "board-inner-lg",
    "board-inner-2xl",
  ],
  shadow: [
    "board-card-hover",
    "board-card-warning",
    "board-card-warning-hover",
    "board-card-attention",
    "board-card-attention-hover",
    "board-card-stack",
    "board-card-stack-hover",
    "board-card-urgent",
    "board-menu",
    "board-menu-dark",
    "board-ring-border",
    "board-ring-primary",
    "board-ring-focus",
    "board-badge-cutout",
    "board-inset-border",
    "board-inset-faint",
    "board-inset-primary",
    "board-inset-primary-soft",
    "board-drop-before",
    "board-drop-after",
    "board-control-top",
    "board-control-top-dark",
  ],
  ease: ["board"],
} as const;

/** The hairline spinner borders are `@utility` classes, so they need naming as widths. */
export const BOARD_TAILWIND_MERGE_BORDER_WIDTHS = [
  "board-spinner",
  "board-spinner-md",
  "board-spinner-lg",
] as const;

/** Extends a tailwind-merge config with the board's scales. */
export function mergeBoardTailwindTheme(config: Config<string, string>): Config<string, string> {
  return mergeConfigs(config, {
    extend: {
      theme: BOARD_TAILWIND_MERGE_THEME,
      classGroups: { "border-w": [{ border: BOARD_TAILWIND_MERGE_BORDER_WIDTHS }] },
    },
  });
}
