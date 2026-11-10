// @effect-diagnostics nodeBuiltinImport:off
/**
 * The board's only chrome row. Asserted from source because a class that no
 * stylesheet defines fails silently.
 */
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const read = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
const topBarSource = read("./BoardTopBar.tsx");
const boardPageSource = read("./BoardPage.tsx");
const stylesheetSource = read("../index.css");

describe("board top bar", () => {
  it("styles its header with classes that exist, not the phantom workspace-topbar", () => {
    // Guard the premise: if a `workspace-topbar` class is ever really defined,
    // this test is the wrong shape and should say so here rather than pass on.
    expect(stylesheetSource).not.toMatch(/(?:@utility|\.)workspace-topbar\b/);
    expect(topBarSource).not.toMatch(/"workspace-topbar/);
    expect(boardPageSource).not.toMatch(/"workspace-topbar/);
  });

  it("takes its geometry from the shared workspace header", () => {
    expect(topBarSource).toContain("<WorkspacePageHeader");
  });

  it("carries the brand and the mode tabs, plus a slot for the board's controls", () => {
    expect(topBarSource).toContain("<T3Wordmark />");
    expect(topBarSource).toContain('<BoardModeTabs mode="board" />');
    expect(topBarSource).toContain("{children}");
  });

  it("is mounted with and without a connected environment", () => {
    // Both branches of the surface: with no environment there is nothing to
    // filter or create, but the way back to threads still has to be on screen.
    expect(boardPageSource.match(/<BoardTopBar[\s>]/g)?.length).toBe(2);
  });

  it("puts the filter box and the create button in the bar, and nowhere else", () => {
    expect(boardPageSource).toContain("<BoardCardFilterField");
    // One create button on the surface: it moved out of the row below.
    expect(boardPageSource.match(/New card/g)?.length).toBe(1);
  });
});
