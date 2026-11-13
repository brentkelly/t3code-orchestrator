import type { BoardWorkerCapacitySnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardWorkerCapacityLines } from "./workerCapacity";

const snapshot: BoardWorkerCapacitySnapshot = {
  at: "2026-11-13T00:00:00.000Z",
  declared: { cpuCores: 16, ramGiB: 64, diskGB: 500 },
  headroom: { cpuCores: 4, ramGiB: -2, diskGB: 500 },
  over: { cpuRam: true, disk: false },
  agents: { running: 1, max: 4 },
  providers: [
    {
      instanceId: "claude",
      driver: "Claude",
      account: { status: "signed-in", email: "dev@acme.dev", plan: "Max" },
      quota: {
        exhausted: true,
        checkedAt: null,
        resetsAt: "2026-11-13T14:00:00.000Z",
        windows: [],
      },
      agents: { running: 1, max: null },
    },
  ],
  readiness: [
    { repositoryKey: "a", path: ".t3/ready.sh", state: "ready", version: null, checkedAt: null },
    {
      repositoryKey: "b",
      path: ".t3/ready.sh",
      state: "not-ready",
      version: null,
      checkedAt: null,
    },
  ],
  heavyCards: [],
};

describe("boardWorkerCapacityLines", () => {
  it("shows free capacity per dimension, clamping a negative headroom to full", () => {
    const lines = boardWorkerCapacityLines(snapshot, () => "14:00");
    expect(lines.bars.map((bar) => [bar.text, bar.used])).toEqual([
      ["4 of 16 cores free", 0.75],
      ["0 of 64 GiB free", 1],
      ["500 of 500 GB free", 0],
    ]);
    expect(lines.agents).toBe("1 agent running · at most 4");
    expect(lines.over).toBe("Over its declared CPU or RAM: takes no new work until usage drops.");
    expect(lines.quota).toEqual(["Claude quota used up · resets 14:00"]);
    expect(lines.readiness).toBe("Ready for 1 of 2 projects");
    expect(lines.notReady).toBe(1);
    expect(lines.projects).toEqual(["b · Not ready"]);
    expect(lines.accounts).toEqual(["Claude · dev@acme.dev · Max"]);
    expect(lines.stale).toBeNull();
  });

  it("marks an offline worker's snapshot as its last report, not what it offers now", () => {
    expect(boardWorkerCapacityLines(snapshot, () => "09:41", false).stale).toBe(
      "Last report 09:41",
    );
  });
});
