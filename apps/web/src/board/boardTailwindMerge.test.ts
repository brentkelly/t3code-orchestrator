import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { cn } from "~/lib/utils";
import {
  BOARD_TAILWIND_MERGE_BORDER_WIDTHS,
  BOARD_TAILWIND_MERGE_THEME,
} from "./boardTailwindMerge";

const css = NodeFS.readFileSync(new URL("./board-theme.css", import.meta.url), "utf8");

function tokens(namespace: string): string[] {
  return [...css.matchAll(new RegExp(`--${namespace}-(board(?:-[a-z0-9]+)*)(?:--[\\w-]+)?:`, "g"))]
    .map((match) => match[1]!)
    .toSorted();
}

describe("board tailwind-merge registration", () => {
  it.each([
    ["text", "text"],
    ["leading", "leading"],
    ["tracking", "tracking"],
    ["radius", "radius"],
    ["shadow", "shadow"],
    ["ease", "ease"],
  ] as const)("registers every --%s-board-* token", (namespace, key) => {
    expect([...BOARD_TAILWIND_MERGE_THEME[key]].toSorted()).toEqual(tokens(namespace));
  });

  it("registers every board border-width utility", () => {
    const utilities = [...css.matchAll(/@utility border-(board-[\w-]+)/g)].map((m) => m[1]!);
    expect([...BOARD_TAILWIND_MERGE_BORDER_WIDTHS].toSorted()).toEqual(utilities.toSorted());
  });

  it("merges board tokens by kind, not as colours", () => {
    expect(cn("text-board-11 text-muted-foreground")).toBe("text-board-11 text-muted-foreground");
    expect(cn("text-board-11", "text-board-12-5/normal")).toBe("text-board-12-5/normal");
    expect(cn("text-xs", "text-board-11")).toBe("text-board-11");
    expect(cn("shadow-sm", "shadow-board-ring-border")).toBe("shadow-board-ring-border");
    expect(cn("rounded-md", "rounded-board-7")).toBe("rounded-board-7");
    expect(cn("tracking-wide", "tracking-board-3")).toBe("tracking-board-3");
    expect(cn("leading-snug", "leading-board-1-45")).toBe("leading-board-1-45");
    expect(cn("border-board-spinner border-muted-foreground/40")).toBe(
      "border-board-spinner border-muted-foreground/40",
    );
    expect(cn("text-board-amber-text", "text-foreground")).toBe("text-foreground");
  });
});
