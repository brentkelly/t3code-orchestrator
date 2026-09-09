// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3o board corner menu (T3O-34, D4/D5).
 *
 * Two things here are structural promises rather than logic, and both cost the
 * user something real if they quietly break, so they are asserted from source
 * the way `BoardTopBar.test.ts` pins the board header's composition:
 *
 *  - The items are upstream's `SidebarUtilityMenu`, not three buttons copied
 *    into the fork. Reimplementing them is how the board's menu and the
 *    sidebar's menu silently drift apart.
 *  - The board's column scroller reserves the corner's height, so no card can
 *    come to rest under the pill.
 */
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { BOARD_UTILITY_MENU_RESERVED_SPACE } from "./BoardUtilityMenu";

const read = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
const menuSource = read("./BoardUtilityMenu.tsx");
const boardPageSource = read("./BoardPage.tsx");

describe("board corner menu", () => {
  it("reuses upstream's utility menu instead of reimplementing its items", () => {
    expect(menuSource).toContain("<SidebarUtilityMenu />");
    expect(menuSource).toContain('from "../components/sidebar/SidebarChrome"');
    // The tell-tale of a reimplementation: the destinations named here.
    expect(menuSource).not.toContain('to: "/settings"');
    expect(menuSource).not.toContain('to: "/usage"');
    expect(menuSource).not.toContain('to: "/pull-requests"');
  });

  it("collapses and expands — both directions are on screen", () => {
    expect(menuSource).toContain('aria-label="Hide menu"');
    expect(menuSource).toContain('aria-label="Show menu"');
    expect(menuSource).toContain("aria-expanded");
  });

  it("is mounted once, above both branches of the surface", () => {
    // One mount on `BoardPage` itself covers the connected board, the
    // no-environment dead end and every sub-board scope.
    expect(boardPageSource.match(/<BoardUtilityMenu \/>/g)?.length).toBe(1);
  });

  it("makes the column scroller reserve the corner, and not with the old pb-3", () => {
    expect(boardPageSource).toContain("BOARD_UTILITY_MENU_RESERVED_SPACE");
    expect(BOARD_UTILITY_MENU_RESERVED_SPACE).toBe("pb-[52px]");
    expect(boardPageSource).not.toMatch(/overflow-auto px-3 pb-3/);
  });
});
