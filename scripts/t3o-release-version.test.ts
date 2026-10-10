import { describe, expect, it } from "vite-plus/test";

import { resolveT3oReleaseVersion } from "./t3o-release-version.ts";
import { resolvePackagedBackend } from "./t3o-smoke-packaged-backend.ts";

describe("resolveT3oReleaseVersion", () => {
  it("reads a pushed v-prefixed tag", () => {
    expect(
      resolveT3oReleaseVersion({
        eventName: "push",
        refName: "v0.0.42-t3o.1",
        dispatchVersion: undefined,
      }),
    ).toEqual({ version: "0.0.42-t3o.1", tag: "v0.0.42-t3o.1", name: "T3o v0.0.42-t3o.1" });
  });

  it("reads a dispatched version with or without the v", () => {
    for (const dispatchVersion of ["0.0.42-t3o.2", "v0.0.42-t3o.2", " 0.0.42-t3o.2 "]) {
      expect(
        resolveT3oReleaseVersion({
          eventName: "workflow_dispatch",
          refName: "board/t3o-1",
          dispatchVersion,
        }).tag,
      ).toBe("v0.0.42-t3o.2");
    }
  });

  it("refuses upstream versions, bare tags and missing input", () => {
    const cases = [
      { eventName: "push", refName: "v0.0.42", dispatchVersion: undefined },
      { eventName: "push", refName: "0.0.42-t3o.1", dispatchVersion: undefined },
      { eventName: "push", refName: "v0.0.42-nightly.20260911.4", dispatchVersion: undefined },
      { eventName: "workflow_dispatch", refName: "t3o", dispatchVersion: "" },
      { eventName: "workflow_dispatch", refName: "t3o", dispatchVersion: "0.0.42-t3o" },
      { eventName: "schedule", refName: "t3o", dispatchVersion: "0.0.42-t3o.1" },
    ];
    for (const input of cases) {
      expect(() => resolveT3oReleaseVersion(input)).toThrow();
    }
  });
});

describe("resolvePackagedBackend", () => {
  it("finds the executable and server entry of each packaged layout", () => {
    expect(resolvePackagedBackend("darwin", "/Applications/T3o.app")).toEqual({
      executable: "/Applications/T3o.app/Contents/MacOS/T3o",
      entry: "/Applications/T3o.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
    });
    expect(resolvePackagedBackend("linux", "/opt/T3o")).toEqual({
      executable: "/opt/T3o/t3o",
      entry: "/opt/T3o/resources/app.asar/apps/server/dist/bin.mjs",
    });
    const windows = resolvePackagedBackend("win32", "/install/T3o");
    expect(windows.executable.replaceAll("\\", "/")).toBe("/install/T3o/T3o.exe");
    expect(windows.entry.replaceAll("\\", "/")).toBe(
      "/install/T3o/resources/server.asar/apps/server/dist/bin.mjs",
    );
  });
});
