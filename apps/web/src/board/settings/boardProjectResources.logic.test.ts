import type { BoardWorkerCapacitySnapshot, BoardWorkerId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardBaselineSaveNotice,
  boardProjectHardToPlace,
  boardProjectWorkerRows,
  boardResourcesDraftOf,
  boardResourcesOf,
  parseBoardBaselineField,
} from "./boardProjectResources.logic";

const snapshot = (
  declared: BoardWorkerCapacitySnapshot["declared"],
  readiness: BoardWorkerCapacitySnapshot["readiness"],
  readinessProtocol = 2,
): BoardWorkerCapacitySnapshot => ({
  readinessProtocol,
  at: "2026-11-13T00:00:00.000Z",
  declared,
  headroom: declared,
  over: { cpuRam: false, disk: false },
  agents: { running: 0, max: null },
  providers: [],
  readiness,
  heavyCards: [],
});

const local = "local" as BoardWorkerId;
const small = "small" as BoardWorkerId;
const old = "old" as BoardWorkerId;
const trusted = "trusted" as BoardWorkerId;

describe("boardProjectWorkerRows", () => {
  it("reads this project's readiness off each worker", () => {
    const rows = boardProjectWorkerRows({
      workers: [
        { workerId: local, label: "This server" },
        { workerId: small, label: "build-02" },
        { workerId: "absent" as BoardWorkerId, label: "gone" },
        { workerId: old, label: "old" },
        { workerId: trusted, label: "build-03" },
      ],
      snapshots: new Map([
        [
          local,
          snapshot({ cpuCores: 16, ramGiB: 64, diskGB: 500 }, [
            {
              repositoryKey: "github.com/acme/app",
              path: ".t3/ready.sh",
              state: "not-ready",
              version: "abc",
              checkedAt: null,
              exitCode: 1,
              lastLine: "missing docker",
              configKey: "checks:now",
            },
            // Another project's entry on the same worker is not this one's.
            {
              repositoryKey: "github.com/acme/other",
              path: ".t3/ready.sh",
              state: "ready",
              version: null,
              checkedAt: null,
            },
          ]),
        ],
        [small, snapshot({ cpuCores: 8, ramGiB: 8, diskGB: 500 }, [])],
        // Too old to honour runScript: the board never asks it, and says why.
        [
          old,
          snapshot(
            { cpuCores: 8, ramGiB: 8, diskGB: 500 },
            [
              {
                repositoryKey: "github.com/acme/app",
                path: ".t3/ready.sh",
                state: "ready",
                version: null,
                checkedAt: null,
                configKey: "checks:stale",
              },
            ],
            0,
          ),
        ],
        // Ready with a skipped script and a warning: worth a look.
        [
          trusted,
          snapshot({ cpuCores: 8, ramGiB: 8, diskGB: 500 }, [
            {
              repositoryKey: "github.com/acme/app",
              path: ".t3/ready.sh",
              state: "ready",
              version: null,
              checkedAt: null,
              configKey: "checks:now",
              scriptSkipped: "not-trusted",
              checks: { passed: 2, failed: 0, warned: 1 },
            },
          ]),
        ],
      ]),
      repositoryKey: "github.com/acme/app",
      projectId: "project-1",
      readinessPath: ".t3/ready.sh",
      readinessConfigKey: "checks:now",
      readinessConfigured: true,
    });
    expect(rows).toEqual([
      {
        workerId: local,
        label: "This server",
        state: "not-ready",
        hasNotice: false,
        detail: "Exit 1 · missing docker",
        declared: { cpuCores: 16, ramGiB: 64, diskGB: 500 },
      },
      {
        workerId: small,
        label: "build-02",
        state: null,
        hasNotice: false,
        detail: null,
        declared: { cpuCores: 8, ramGiB: 8, diskGB: 500 },
      },
      {
        workerId: old,
        label: "old",
        state: null,
        hasNotice: false,
        detail: "Update this worker to check readiness",
        declared: { cpuCores: 8, ramGiB: 8, diskGB: 500 },
      },
      {
        workerId: trusted,
        label: "build-03",
        state: "ready",
        hasNotice: true,
        detail:
          "2 checks passed, 1 warning · readiness script not run: not trusted for this project",
        declared: { cpuCores: 8, ramGiB: 8, diskGB: 500 },
      },
    ]);
  });

  it("flags an old worker only when the project asks for readiness", () => {
    const rows = boardProjectWorkerRows({
      workers: [{ workerId: old, label: "old" }],
      snapshots: new Map([[old, snapshot({ cpuCores: 8, ramGiB: 8, diskGB: 500 }, [], 0)]]),
      repositoryKey: "github.com/acme/app",
      projectId: "project-1",
      readinessPath: ".t3/ready.sh",
      readinessConfigured: false,
    });
    expect(rows.map((row) => row.detail)).toEqual([null]);
  });
});

describe("boardProjectHardToPlace", () => {
  const worker = (label: string, cpuCores: number, state: "ready" | "not-ready" = "ready") => ({
    label,
    state,
    declared: { cpuCores, ramGiB: 64, diskGB: 500 },
  });
  const baseline = (cpuCores: number) => ({ cpuCores, ramGiB: 4, diskGB: 5 });

  it("warns per dimension, against only the workers ready for the project", () => {
    const workers = [worker("build-01", 16), worker("build-02", 8), worker("big", 64, "not-ready")];
    expect(boardProjectHardToPlace(baseline(20), workers)).toEqual([
      "CPU: an M card needs 20 cores; the largest ready worker declares 16. No card can be placed.",
    ]);
    expect(boardProjectHardToPlace(baseline(14), workers)).toEqual([
      "CPU: L and XL cards can't be placed; the largest ready worker declares 16 cores.",
    ]);
    expect(boardProjectHardToPlace(baseline(10), workers)).toEqual([
      "CPU: only build-01 fits an M card, so cards will queue behind each other.",
    ]);
    expect(boardProjectHardToPlace(baseline(4), workers)).toEqual([]);
  });

  it("doesn't call a lone worker the only one that fits, and says nothing with none ready", () => {
    expect(boardProjectHardToPlace(baseline(10), [worker("This server", 16)])).toEqual([]);
    expect(boardProjectHardToPlace(baseline(99), [worker("x", 16, "not-ready")])).toEqual([]);
  });
});

describe("boardBaselineSaveNotice", () => {
  const before = { cpuCores: 2, ramGiB: 4, diskGB: 5 };
  it("names the placed cards a changed baseline won't reach", () => {
    expect(boardBaselineSaveNotice(7, before, { ...before, cpuCores: 4 })).toBe(
      "7 placed cards keep their current reservation.",
    );
    expect(boardBaselineSaveNotice(1, before, { ...before, diskGB: 9 })).toBe(
      "1 placed card keeps its current reservation.",
    );
    expect(boardBaselineSaveNotice(7, before, before)).toBeNull();
    expect(boardBaselineSaveNotice(0, before, { ...before, cpuCores: 4 })).toBeNull();
  });
});

describe("parseBoardBaselineField", () => {
  it("takes a positive number and nothing else", () => {
    expect(parseBoardBaselineField(" 2.5 ")).toBe(2.5);
    expect(parseBoardBaselineField("0")).toBeNull();
    expect(parseBoardBaselineField("")).toBeNull();
    expect(parseBoardBaselineField("four")).toBeNull();
  });
});

describe("the Resources form", () => {
  it("saving one field declares nothing else and keeps the set-at-upgrade mark", () => {
    const previous = {
      baseline: { cpuCores: 2, ramGiB: 4, diskGB: 5, setAtUpgrade: true },
      setupTimeoutMinutes: null,
      readinessPath: null,
      readinessTimeoutSeconds: null,
      readinessChecks: [],
    };
    const draft = { ...boardResourcesDraftOf(previous), readinessPath: "./ci/ready.sh" };
    expect(boardResourcesDraftOf(previous)["setupTimeoutMinutes"]).toBe("");
    expect(boardResourcesOf(draft, previous)).toEqual({
      ok: { ...previous, readinessPath: "ci/ready.sh" },
    });
    // From nothing declared, the defaults stay undeclared.
    expect(boardResourcesOf(boardResourcesDraftOf(null), null)).toEqual({
      ok: {
        baseline: null,
        setupTimeoutMinutes: null,
        readinessPath: null,
        readinessTimeoutSeconds: null,
        readinessChecks: [],
      },
    });
  });

  it("an edited baseline drops the mark; a half-filled one is refused", () => {
    const previous = {
      baseline: { cpuCores: 2, ramGiB: 4, diskGB: 5, setAtUpgrade: true },
      setupTimeoutMinutes: null,
      readinessPath: null,
      readinessTimeoutSeconds: null,
      readinessChecks: [],
    };
    const edited = boardResourcesOf(
      { ...boardResourcesDraftOf(previous), cpuCores: "3" },
      previous,
    );
    expect("ok" in edited && edited.ok.baseline?.setAtUpgrade).toBe(false);
    expect(
      boardResourcesOf({ ...boardResourcesDraftOf(null), cpuCores: "3" }, null),
    ).toHaveProperty("error");
  });
});
