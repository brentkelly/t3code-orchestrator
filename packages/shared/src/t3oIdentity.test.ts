import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveFileName,
  cliReleaseChannelOf,
  cliReleaseDownloadBaseUrl,
  newestCliReleaseVersion,
} from "./cliRelease.ts";
import {
  isT3oReleaseVersion,
  T3O_DESKTOP_RENDERER_ORIGINS,
  T3O_DESKTOP_SCHEMES,
  t3oDesktopIdentity,
} from "./t3oIdentity.ts";

describe("t3oDesktopIdentity", () => {
  it("never shares an identifier with upstream T3 Code", () => {
    for (const isDevelopment of [false, true]) {
      const identity = t3oDesktopIdentity(isDevelopment);
      expect(identity.scheme).not.toMatch(/^t3code/);
      expect(identity.userDataDirName).not.toMatch(/t3code|T3 Code/);
      expect(identity.appUserModelId).not.toContain("t3tools");
      expect(identity.linuxWmClass).not.toMatch(/^t3code/);
      expect(identity.linuxDesktopEntryName).not.toContain("t3tools");
      expect(identity.linuxDesktopEntryName).toMatch(/\.desktop$/);
    }
  });

  it("keeps a dev run apart from a packaged build", () => {
    const production = t3oDesktopIdentity(false);
    const development = t3oDesktopIdentity(true);
    for (const key of Object.keys(production) as Array<keyof typeof production>) {
      expect(development[key]).not.toBe(production[key]);
    }
  });

  it("lists every renderer origin the server has to accept", () => {
    expect(T3O_DESKTOP_SCHEMES).toEqual(["t3o", "t3o-dev"]);
    expect(T3O_DESKTOP_RENDERER_ORIGINS).toEqual(["t3o://app", "t3o-dev://app"]);
  });
});

describe("isT3oReleaseVersion", () => {
  it("accepts an upstream base version with a fork counter", () => {
    expect(isT3oReleaseVersion("0.0.42-t3o.1")).toBe(true);
    expect(isT3oReleaseVersion("1.12.0-t3o.27")).toBe(true);
  });

  it("rejects upstream versions and malformed fork versions", () => {
    for (const version of [
      "0.0.42",
      "v0.0.42-t3o.1",
      "0.0.42-t3o",
      "0.0.42-t3o.1.2",
      "0.0.42-nightly.20260911.4",
      "0.0.42-t3o.x",
    ]) {
      expect(isT3oReleaseVersion(version)).toBe(false);
    }
  });
});

describe("T3o release versions through the runtime installers", () => {
  it("are on the stable channel and resolve to v-prefixed fork tags", () => {
    expect(cliReleaseChannelOf("0.0.42-t3o.1")).toBe("stable");
    expect(cliReleaseDownloadBaseUrl("0.0.42-t3o.1")).toBe(
      "https://github.com/brentkelly/t3code-orchestrator/releases/download/v0.0.42-t3o.1",
    );
    expect(cliArchiveFileName("0.0.42-t3o.1", "linux-x64")).toBe(
      "t3-0.0.42-t3o.1-linux-x64.tar.gz",
    );
  });

  it("are picked from the fork's release index, skipping drafts", () => {
    expect(
      newestCliReleaseVersion(
        [
          { tag_name: "v0.0.42-t3o.3", draft: true },
          { tag_name: "v0.0.42-t3o.2" },
          { tag_name: "v0.0.42-t3o.1" },
        ],
        "stable",
      ),
    ).toBe("0.0.42-t3o.2");
  });
});
