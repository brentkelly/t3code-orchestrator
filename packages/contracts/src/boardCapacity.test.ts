import { describe, expect, it } from "vite-plus/test";

import {
  boardCardRequestedProfile,
  boardPlannerUse,
  boardProjectConfigVersion,
  boardResourceProfile,
  normalizeBoardReadinessPath,
  resolveBoardProjectBaseline,
  type BoardProjectResources,
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
    // What the board learned never moves the version a human's edit expects.
    const learnedOnly = { value: 3, samples: 5, history: [3] };
    expect(
      boardProjectConfigVersion({
        ...delta,
        resources: {
          baseline: null,
          setupTimeoutMinutes: null,
          readinessPath: null,
          readinessTimeoutSeconds: null,
          learned: { computedAt: NOW, cpu: learnedOnly, ram: learnedOnly, disk: learnedOnly },
        },
      }),
    ).toBe(before);
  });
});

const NOW = "2026-11-13T00:00:00.000Z";
const learnedDimension = (value: number | null, unplaceable?: true) => ({
  value,
  samples: value === null ? 2 : 9,
  history: [],
  ...(unplaceable === undefined ? {} : { unplaceable }),
});
const resourcesWith = (input: {
  readonly baseline: BoardProjectResources["baseline"];
  readonly learned: Partial<Record<"cpu" | "ram" | "disk", number | null>>;
  readonly pin?: ReadonlyArray<"cpu" | "ram" | "disk">;
  readonly unplaceable?: "cpu";
}): BoardProjectResources => ({
  baseline: input.baseline,
  setupTimeoutMinutes: null,
  readinessPath: null,
  readinessTimeoutSeconds: null,
  ...(input.pin === undefined ? {} : { pinDeclared: input.pin }),
  learned: {
    computedAt: NOW,
    cpu: learnedDimension(
      input.learned.cpu ?? null,
      input.unplaceable === "cpu" ? true : undefined,
    ),
    ram: learnedDimension(input.learned.ram ?? null),
    disk: learnedDimension(input.learned.disk ?? null),
  },
});
const human = { cpuCores: 4, ramGiB: 8, diskGB: 10, setAtUpgrade: false };

describe("boardPlannerUse", () => {
  it("applies a learned increase to new placements, naming learned as its source", () => {
    const resources = resourcesWith({ baseline: human, learned: { cpu: 6 } });
    expect(boardPlannerUse(resources, "cpu")).toMatchObject({ value: 6, source: "learned" });
    expect(resolveBoardProjectBaseline(resources)).toEqual({ cpuCores: 6, ramGiB: 8, diskGB: 10 });
  });

  it("only offers a learned decrease, and never applies it", () => {
    const use = boardPlannerUse(resourcesWith({ baseline: human, learned: { ram: 5 } }), "ram");
    expect(use).toMatchObject({ value: 8, source: "declared", offeredDecrease: 5 });
  });

  it("clamps to 0.5x–2x only against a value a human declared", () => {
    const declared = resourcesWith({ baseline: human, learned: { disk: 30, ram: 1 } });
    expect(boardPlannerUse(declared, "disk").value).toBe(20);
    expect(boardPlannerUse(declared, "ram").offeredDecrease).toBe(4);
    // The 5 GB placeholder learns a 30 GB worktree, and so does a value set at the upgrade.
    expect(
      boardPlannerUse(resourcesWith({ baseline: null, learned: { disk: 30 } }), "disk"),
    ).toMatchObject({ value: 30, source: "learned", declaredSource: "placeholder" });
    expect(
      boardPlannerUse(
        resourcesWith({ baseline: { ...human, setAtUpgrade: true }, learned: { disk: 30 } }),
        "disk",
      ).value,
    ).toBe(30);
  });

  it("ignores learning altogether while pinned", () => {
    const pinned = resourcesWith({
      baseline: human,
      learned: { cpu: 6, ram: 2 },
      pin: ["cpu", "ram"],
    });
    expect(boardPlannerUse(pinned, "cpu")).toMatchObject({
      value: 4,
      source: "declared",
      pinned: true,
    });
    expect(boardPlannerUse(pinned, "ram").offeredDecrease).toBeNull();
  });

  it("holds back an increase no ready worker could place, and under five samples uses declared", () => {
    expect(
      boardPlannerUse(
        resourcesWith({ baseline: human, learned: { cpu: 6 }, unplaceable: "cpu" }),
        "cpu",
      ),
    ).toMatchObject({ value: 4, heldIncrease: 6 });
    expect(boardPlannerUse(resourcesWith({ baseline: human, learned: {} }), "cpu").value).toBe(4);
  });
});
