// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import * as mirrors from "./upstreamClasses";

// Board token utility -> the arbitrary value upstream writes for the same CSS.
const UPSTREAM_UTILITY: Record<string, string> = {
  "rounded-board-inner-md": "rounded-[calc(var(--radius-md)-1px)]",
  "rounded-board-inner-lg": "rounded-[calc(var(--radius-lg)-1px)]",
  "rounded-b-board-inner-2xl": "rounded-b-[calc(var(--radius-2xl)-1px)]",
  "shadow-board-control-top": "shadow-[0_1px_--theme(--color-black/4%)]",
  "shadow-board-control-top-dark": "shadow-[0_-1px_--theme(--color-white/6%)]",
  "ring-3": "ring-[3px]",
  "px-2.75": "px-[calc(--spacing(3)-1px)]",
  "px-2.25": "px-[calc(--spacing(2.5)-1px)]",
  "py-1.25": "py-[calc(--spacing(1.5)-1px)]",
  "bg-foreground/9": "bg-foreground/[0.09]",
  "bg-foreground/6": "bg-foreground/[0.06]",
};
const UPSTREAM_PHRASE: ReadonlyArray<readonly [string, string]> = [
  [
    "transition-[background-color] duration-5000000000 ease-in-out",
    "[transition:background-color_5000000s_ease-in-out_0s]",
  ],
];

type Mirror = { readonly file: string; readonly match: "exact" | "subset" };
const MIRRORS: Record<keyof typeof mirrors, Mirror> = {
  UPSTREAM_INPUT_CONTROL: { file: "input.tsx", match: "exact" },
  UPSTREAM_INPUT_CONTROL_COMPACT: { file: "input.tsx", match: "exact" },
  UPSTREAM_INPUT: { file: "input.tsx", match: "exact" },
  UPSTREAM_INPUT_COMPACT: { file: "input.tsx", match: "exact" },
  UPSTREAM_INPUT_SM: { file: "input.tsx", match: "exact" },
  UPSTREAM_INPUT_SEARCH: { file: "input.tsx", match: "exact" },
  UPSTREAM_TEXTAREA_CONTROL: { file: "textarea.tsx", match: "exact" },
  UPSTREAM_TEXTAREA: { file: "textarea.tsx", match: "exact" },
  UPSTREAM_TEXTAREA_MIN_HEIGHT: { file: "textarea.tsx", match: "exact" },
  UPSTREAM_DIALOG_VIEWPORT: { file: "dialog.tsx", match: "exact" },
  UPSTREAM_DIALOG_VIEWPORT_MOBILE_SHEET: { file: "dialog.tsx", match: "exact" },
  UPSTREAM_DIALOG_POPUP: { file: "dialog.tsx", match: "exact" },
  UPSTREAM_DIALOG_POPUP_DEFAULT: { file: "dialog.tsx", match: "exact" },
  UPSTREAM_DIALOG_TITLE: { file: "dialog.tsx", match: "exact" },
  UPSTREAM_DIALOG_FOOTER: { file: "dialog.tsx", match: "exact" },
  UPSTREAM_DIALOG_FOOTER_DEFAULT: { file: "dialog.tsx", match: "exact" },
  UPSTREAM_COMBOBOX_INPUT_WRAPPER: { file: "combobox.tsx", match: "exact" },
  UPSTREAM_COMBOBOX_INPUT_SM: { file: "combobox.tsx", match: "exact" },
  UPSTREAM_COMBOBOX_ITEM: { file: "combobox.tsx", match: "exact" },
  UPSTREAM_COMBOBOX_ITEM_SELECTED_FILL: { file: "combobox.tsx", match: "exact" },
  UPSTREAM_COMBOBOX_ITEM_CONTENT: { file: "combobox.tsx", match: "exact" },
  UPSTREAM_COMBOBOX_LIST: { file: "combobox.tsx", match: "exact" },
  UPSTREAM_RADIO_GROUP: { file: "radio-group.tsx", match: "subset" },
  UPSTREAM_KBD: { file: "kbd.tsx", match: "exact" },
  UPSTREAM_POPOVER_POSITIONER: { file: "popover.tsx", match: "exact" },
  UPSTREAM_POPOVER_POSITIONER_TRANSITION: { file: "popover.tsx", match: "exact" },
  UPSTREAM_POPOVER_POPUP: { file: "popover.tsx", match: "subset" },
  UPSTREAM_POPOVER_VIEWPORT: { file: "popover.tsx", match: "subset" },
  UPSTREAM_POPOVER_VIEWPORT_PADDING_NONE: { file: "popover.tsx", match: "exact" },
  UPSTREAM_POPOVER_VIEWPORT_OVERFLOW: { file: "popover.tsx", match: "exact" },
};

function utilityOf(className: string): readonly [string, string] {
  let depth = 0;
  let split = -1;
  for (let i = 0; i < className.length; i++) {
    const char = className[i];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) split = i;
  }
  return [className.slice(0, split + 1), className.slice(split + 1)];
}

function toUpstreamClasses(boardClasses: string): ReadonlyArray<string> {
  let text = boardClasses;
  for (const [board, upstream] of UPSTREAM_PHRASE) text = text.replace(board, upstream);
  return text.split(/\s+/).map((className) => {
    const [variants, utility] = utilityOf(className);
    return variants + (UPSTREAM_UTILITY[utility] ?? utility);
  });
}

function upstreamStringLiterals(file: string): ReadonlyArray<ReadonlyArray<string>> {
  const source = NodeFS.readFileSync(
    new URL(`../../components/ui/${file}`, import.meta.url),
    "utf8",
  );
  return [...source.matchAll(/"([^"\n]*)"/g)].map((match) => match[1]!.split(/\s+/));
}

describe("board/ui upstream class mirrors", () => {
  it.each(Object.keys(MIRRORS) as Array<keyof typeof mirrors>)(
    "%s matches upstream's source",
    (name) => {
      const { file, match } = MIRRORS[name];
      const expected = toUpstreamClasses(mirrors[name]);
      const literals = upstreamStringLiterals(file);
      const found = literals.some((literal) =>
        match === "exact"
          ? literal.join(" ") === expected.join(" ")
          : expected.every((className) => literal.includes(className)),
      );
      expect(found, `${name}: ${expected.join(" ")}`).toBe(true);
    },
  );
});
