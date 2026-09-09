/**
 * T3o mode-tabs placement (T3O-34, D8/D9).
 */
import { describe, expect, it } from "vite-plus/test";

import {
  locationHasModeTabs,
  MODE_TABS_MIN_WIDTH,
  shouldSidebarHostModeTabs,
} from "./modeTabsSlot";

const hosting = (overrides: Partial<Parameters<typeof shouldSidebarHostModeTabs>[0]> = {}) =>
  shouldSidebarHostModeTabs({
    availableWidth: MODE_TABS_MIN_WIDTH,
    isMobile: false,
    sidebarVisible: true,
    pathname: "/env-1/thread-1",
    ...overrides,
  });

describe("shouldSidebarHostModeTabs", () => {
  it("hosts the tabs once the header slot is wide enough", () => {
    expect(hosting({ availableWidth: MODE_TABS_MIN_WIDTH })).toBe(true);
    expect(hosting({ availableWidth: MODE_TABS_MIN_WIDTH + 200 })).toBe(true);
  });

  it("leaves the tabs in the top bar one pixel below the threshold", () => {
    expect(hosting({ availableWidth: MODE_TABS_MIN_WIDTH - 1 })).toBe(false);
    expect(hosting({ availableWidth: 0 })).toBe(false);
  });

  it("never hosts on mobile, where the sidebar is a sheet", () => {
    expect(hosting({ isMobile: true, availableWidth: 1000 })).toBe(false);
  });

  it("never hosts while the sidebar is collapsed", () => {
    expect(hosting({ sidebarVisible: false, availableWidth: 1000 })).toBe(false);
  });

  it("hosts at every location whose top bar carries the tabs today", () => {
    for (const pathname of ["/", "/env-1/thread-1", "/draft/d1"]) {
      expect(hosting({ pathname, availableWidth: 1000 })).toBe(true);
    }
  });

  it("leaves the footer destinations and settings alone", () => {
    for (const pathname of [
      "/settings",
      "/settings/general",
      "/usage",
      "/pull-requests",
      "/projects/web",
      "/board",
      "/board/card-1",
    ]) {
      expect(hosting({ pathname, availableWidth: 1000 })).toBe(false);
    }
  });
});

describe("locationHasModeTabs", () => {
  it("treats a longer word starting with a tabless root as a different route", () => {
    expect(locationHasModeTabs("/usagey")).toBe(true);
    expect(locationHasModeTabs("/projectsish")).toBe(true);
    expect(locationHasModeTabs("/usage")).toBe(false);
    expect(locationHasModeTabs("/projects/web")).toBe(false);
  });
});
