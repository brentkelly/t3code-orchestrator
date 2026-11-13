import type { BoardResourceProfile, BoardWorkerCapacitySnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardWorkerCapacityLines } from "./workerCapacity";

const snapshot: BoardWorkerCapacitySnapshot & { held: BoardResourceProfile } = {
  held: { cpuCores: 10, ramGiB: 24, diskGB: 0 },
  at: "2026-11-13T00:00:00.000Z",
  declared: { cpuCores: 16, ramGiB: 64, diskGB: 500 },
  headroom: { cpuCores: 4, ramGiB: -2, diskGB: 500 },
  over: { cpuRam: true, disk: false },
  agents: { running: 1, max: 4 },
  providers: [
    {
      instanceId: "claude",
      driver: "claudeAgent",
      account: { status: "signed-in", email: "dev@acme.dev", plan: "Max" },
      quota: {
        exhausted: true,
        checkedAt: null,
        resetsAt: "2026-11-13T14:00:00.000Z",
        windows: [
          {
            label: "Session",
            usedPercent: 97,
            resetsAt: "2026-11-13T14:00:00.000Z",
            gating: true,
            nearLimit: true,
          },
          { label: "Weekly · Opus", usedPercent: 40, resetsAt: null, gating: false },
        ],
      },
      agents: { running: 1, max: null },
    },
    {
      instanceId: "codex",
      driver: "codex",
      account: { status: "signed-out" },
      quota: { exhausted: false, checkedAt: null, resetsAt: null, windows: [] },
      agents: { running: 0, max: null },
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
    const lines = boardWorkerCapacityLines(snapshot, () => "14:00", "build-01");
    expect(lines.bars.map((bar) => [bar.text, bar.used])).toEqual([
      ["4 of 16 cores free", 0.75],
      ["0 of 64 GiB free", 1],
      ["500 of 500 GB free", 0],
    ]);
    expect(lines.bars[0]?.tooltip).toBe(
      "Declared 16 cores · offered 4 · this board's cards hold 10",
    );
    expect(lines.agents).toBe("1 agent running · at most 4");
    expect(lines.over).toBe("Over its declared CPU or RAM: takes no new work until usage drops.");
    expect(lines.providers).toEqual([
      {
        title: "Claude · dev@acme.dev · Max",
        windows: [
          {
            label: "Session",
            used: 0.97,
            text: "Session · 97% used · resets 14:00",
            nearLimit: true,
          },
          { label: "Weekly · Opus", used: 0.4, text: "Weekly · Opus · 40% used", nearLimit: false },
        ],
        nearLimit: "Near its limit: takes no new cards · resets 14:00",
        signedOut: null,
      },
      {
        title: "Codex",
        windows: [],
        nearLimit: null,
        signedOut: "Signed out · run `codex login` on build-01",
      },
    ]);
    expect(lines.readiness).toBe("Ready for 1 of 2 projects");
    expect(lines.notReady).toBe(1);
    expect(lines.projects).toEqual(["b · Not ready"]);
    expect(lines.stale).toBeNull();
  });

  it("marks an offline worker's snapshot as its last report, not what it offers now", () => {
    expect(boardWorkerCapacityLines(snapshot, () => "09:41", "build-01", false).stale).toBe(
      "Last report 09:41",
    );
  });
});
