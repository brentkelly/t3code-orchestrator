import { describe, expect, it } from "vite-plus/test";

import {
  boardCardRequestedProfile,
  boardProjectConfigVersion,
  boardResourceProfile,
  normalizeBoardReadinessPath,
} from "./index.ts";

describe("boardResourceProfile", () => {
  it("multiplies each dimension by its own size", () => {
    // The brief's example: S / S / L on a 6-core, 16 GiB, 45 GB baseline.
    expect(
      boardResourceProfile(
        { cpuCores: 6, ramGiB: 16, diskGB: 45 },
        { cpu: "S", ram: "S", disk: "L" },
      ),
    ).toEqual({ cpuCores: 4.5, ramGiB: 12, diskGB: 56.25 });
    expect(
      boardResourceProfile(
        { cpuCores: 4, ramGiB: 8, diskGB: 10 },
        { cpu: "XL", ram: "M", disk: "S" },
      ),
    ).toEqual({ cpuCores: 6, ramGiB: 8, diskGB: 7.5 });
  });

  it("uses the 2/4/5 placeholder and size M when nothing is declared", () => {
    expect(boardCardRequestedProfile(null, null)).toEqual({ cpuCores: 2, ramGiB: 4, diskGB: 5 });
  });
});

describe("normalizeBoardReadinessPath", () => {
  it("keeps a relative path inside the repository and refuses one that leaves it", () => {
    expect(normalizeBoardReadinessPath("./.t3//ready.sh")).toBe(".t3/ready.sh");
    for (const bad of ["/etc/passwd", "../x.sh", "a/../../x.sh", "C:/x.sh", "a\\b.sh", " "]) {
      expect(normalizeBoardReadinessPath(bad)).toBeNull();
    }
  });
});

describe("boardProjectConfigVersion", () => {
  it("is unchanged for a config without resources, and moves when they are set", () => {
    const delta = { stageSwitches: {}, overrides: {}, ci: { steps: [] } };
    const before = boardProjectConfigVersion(delta);
    expect(
      boardProjectConfigVersion({
        ...delta,
        resources: {
          baseline: null,
          setupTimeoutMinutes: null,
          readinessPath: null,
          readinessTimeoutSeconds: null,
        },
      }),
    ).toBe(before);
    expect(
      boardProjectConfigVersion({
        ...delta,
        resources: {
          baseline: { cpuCores: 1, ramGiB: 1, diskGB: 1, setAtUpgrade: false },
          setupTimeoutMinutes: null,
          readinessPath: null,
          readinessTimeoutSeconds: null,
        },
      }),
    ).not.toBe(before);
  });
});
