import { describe, expect, it } from "vite-plus/test";

import { isSettingsNavPathActive } from "./boardSettingsPaths";

describe("which Board settings entry is lit", () => {
  const navPaths = [
    "/settings/general",
    "/settings/board",
    "/settings/board/pipeline",
    "/settings/board/projects",
    "/settings/board/workers",
  ];
  const lit = (path: string) =>
    navPaths.filter((to) => isSettingsNavPathActive(path, to, navPaths));

  it("lights only the longest entry the page falls under", () => {
    expect(lit("/settings/board")).toEqual(["/settings/board"]);
    expect(lit("/settings/board/workers")).toEqual(["/settings/board/workers"]);
    expect(lit("/settings/board/pipeline")).toEqual(["/settings/board/pipeline"]);
  });

  it("lights Projects on a project's own pages", () => {
    expect(lit("/settings/board/projects/p1/resources")).toEqual(["/settings/board/projects"]);
  });
});
