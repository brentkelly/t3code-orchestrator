import type { BoardWorkerCapacitySnapshot, BoardWorkerId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardProjectWorkerRows, parseBoardBaselineField } from "./boardProjectResources.logic";

const snapshot = (
  declared: BoardWorkerCapacitySnapshot["declared"],
  readiness: BoardWorkerCapacitySnapshot["readiness"],
): BoardWorkerCapacitySnapshot => ({
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

describe("boardProjectWorkerRows", () => {
  it("reads this project's readiness off each worker and flags a worker an M card can't fit", () => {
    const rows = boardProjectWorkerRows({
      workers: [
        { workerId: local, label: "This server" },
        { workerId: small, label: "build-02" },
        { workerId: "absent" as BoardWorkerId, label: "gone" },
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
      ]),
      repositoryKey: "github.com/acme/app",
      readinessPath: ".t3/ready.sh",
      baseline: { cpuCores: 2, ramGiB: 12, diskGB: 5 },
    });
    expect(rows).toEqual([
      {
        workerId: local,
        label: "This server",
        state: "not-ready",
        detail: "Exit 1 · missing docker",
        hardToPlace: null,
      },
      {
        workerId: small,
        label: "build-02",
        state: null,
        detail: null,
        hardToPlace: "An M card needs 12 GiB of RAM; build-02 declares 8.",
      },
    ]);
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
