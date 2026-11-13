import type { BoardCardResources, BoardCardSetupResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardCardCapacityView, boardCardSetupView } from "./boardCardCapacity";

const baseline = {
  baseline: { cpuCores: 12, ramGiB: 16, diskGB: 45, setAtUpgrade: false },
  setupTimeoutMinutes: null,
  readinessPath: null,
  readinessTimeoutSeconds: null,
};

const resources = (overrides: Partial<BoardCardResources>): BoardCardResources => ({
  sizing: null,
  grant: null,
  setup: null,
  ...overrides,
});

describe("boardCardCapacityView", () => {
  it("shows the reservation, and an edit beside the planner's suggestion with Reset", () => {
    const view = boardCardCapacityView({
      resources: resources({
        sizing: {
          planner: { size: { cpu: "M", ram: "M", disk: "M" }, reason: "A normal build" },
          edit: { size: { cpu: "S", ram: "S", disk: "L" }, by: "human" },
        },
      }),
      projectResources: baseline,
      placed: false,
      pinned: false,
      worker: null,
    });
    expect(view.reservation).toBe("9 cores · 12 GiB · 56.3 GB");
    expect(view.provenance).toBe("Edited by you · planner suggested M · M · M");
    expect(view.canReset).toBe(true);
  });

  it("is too big for the card's worker only before it is placed, and says what to do", () => {
    const tooBig = (size: "XL" | "M", placed: boolean, pinned: boolean) =>
      boardCardCapacityView({
        resources: resources({
          sizing: {
            planner: null,
            edit: { size: { cpu: size, ram: "M", disk: "M" }, by: "human" },
          },
        }),
        projectResources: baseline,
        placed,
        pinned,
        worker: { label: "build-02", declared: { cpuCores: 16, ramGiB: 64, diskGB: 500 } },
      }).tooBig;
    expect(tooBig("XL", false, false)).toBe(
      "CPU XL needs 18 cores; build-02 has 16. Lower the size.",
    );
    expect(tooBig("XL", false, true)).toBe(
      "CPU XL needs 18 cores; build-02 has 16. Lower the size, or unpin.",
    );
    expect(tooBig("XL", true, false)).toBeNull();
    expect(tooBig("M", false, false)).toBeNull();
  });

  it("says a placed card runs at the size it was granted", () => {
    const view = boardCardCapacityView({
      resources: resources({
        sizing: { planner: null, edit: { size: { cpu: "XL", ram: "M", disk: "M" }, by: "agent" } },
        grant: {
          profile: { cpuCores: 6, ramGiB: 16, diskGB: 45 },
          heavy: true,
          claimId: null,
          grantedAt: "2026-11-13T00:00:00.000Z",
          settled: true,
        },
      }),
      projectResources: baseline,
      placed: true,
      pinned: false,
      worker: null,
    });
    expect(view.granted).toBe(
      "Running at the size it was granted (6 cores · 16 GiB · 45 GB). The new size applies if the card is placed again.",
    );
    expect(view.provenance).toBe("Edited by an agent");
  });
});

describe("boardCardSetupView", () => {
  const setup = (overrides: Partial<BoardCardSetupResult>): BoardCardSetupResult => ({
    status: "running",
    stage: "setup-script",
    exitCode: null,
    startedAt: "2026-11-13T00:00:00.000Z",
    durationMs: null,
    workerId: "local",
    detail: null,
    blocking: false,
    ...overrides,
  });

  it("reads Preparing n/4 while it runs, and collapses to one line once it succeeded", () => {
    expect(
      boardCardSetupView({ setup: setup({}), workerLabel: "build-01", stepRunning: true }).face,
    ).toBe("Preparing · 3/4");
    const done = boardCardSetupView({
      setup: setup({ status: "succeeded", durationMs: 372_000 }),
      workerLabel: "build-01",
      stepRunning: true,
    });
    expect(done.face).toBeNull();
    expect(done.collapsed).toBe("Setup · build-01 · 6m 12s");
  });

  it("a failure is amber when setup holds the agent, or once the step it ran beside ended", () => {
    const failed = setup({ status: "failed", exitCode: 2 });
    expect(
      boardCardSetupView({
        setup: { ...failed, blocking: true },
        workerLabel: "b",
        stepRunning: false,
      }).face,
    ).toBe("Setup failed · 3/4");
    // async: true and the step is still running: not amber, but the detail says so.
    const running = boardCardSetupView({ setup: failed, workerLabel: "b", stepRunning: true });
    expect(running.face).toBeNull();
    expect(running.failure).toBe("Setup script failed (exit 2).");
    expect(running.stages.at(-1)?.status).toBe("failed");
    expect(running.canRetry).toBe(true);
    expect(boardCardSetupView({ setup: failed, workerLabel: "b", stepRunning: false }).face).toBe(
      "Setup failed · 3/4",
    );
  });
});
