import { describe, expect, it } from "vite-plus/test";

import {
  boardActualsFooter,
  boardActualsRowState,
  boardAgentActualsSkipReason,
  boardCardActualsSample,
  boardLearnedDimension,
  boardProjectLearned,
  type BoardActualsCardSample,
  type BoardCardActualsRow,
  type BoardStepReading,
} from "./index.ts";

const GiB = 1024 ** 3;
const GB = 1000 ** 3;
const NOW = "2026-11-13T00:00:00.000Z";
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const reading = (overrides: Partial<BoardStepReading> = {}): BoardStepReading => ({
  measured: true,
  reason: null,
  running: false,
  partial: false,
  cpuCoreSeconds: 100,
  peakCpuCores: 2,
  peakRamBytes: 4 * GiB,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  diskBytes: 5 * GB,
  samples: 10,
  ...overrides,
});

const row = (overrides: Partial<BoardCardActualsRow> = {}): BoardCardActualsRow => ({
  stepKey: "ci:run-1",
  kind: "ci",
  stepId: null,
  label: "CI pass 1",
  workerId: "local",
  grantedProfile: { cpuCores: 2, ramGiB: 4, diskGB: 5 },
  startedAt: daysAgo(1),
  endedAt: daysAgo(1),
  reading: reading(),
  updatedAt: daysAgo(1),
  ...overrides,
});

const M = { cpu: "M", ram: "M", disk: "M" } as const;

describe("boardActualsRowState", () => {
  it("never reads not measured as a figure, and tells partial and so-far apart", () => {
    expect(boardActualsRowState(row({ reading: reading({ measured: false }) }))).toBe(
      "not-measured",
    );
    expect(boardActualsRowState(row({ reading: reading({ running: true }) }))).toBe("so-far");
    expect(boardActualsRowState(row({ reading: reading({ partial: true }) }))).toBe("partial");
    expect(boardActualsRowState(row())).toBe("complete");
  });
});

describe("boardAgentActualsSkipReason", () => {
  it("measures Claude, and names why Codex and the unscoped providers aren't", () => {
    expect(boardAgentActualsSkipReason("claudeAgent")).toBeNull();
    expect(boardAgentActualsSkipReason("codex")).toMatch(/shared scope/);
    for (const id of ["cursor", "grok", "opencode", "antigravity", "kiro"]) {
      expect(boardAgentActualsSkipReason(id)).toMatch(/scope of their own/);
    }
  });
});

describe("boardActualsFooter", () => {
  it("uses only the current placement's rows, as a share of its reservation", () => {
    const footer = boardActualsFooter({
      rows: [
        row({ workerId: "old", reading: reading({ peakCpuCores: 8, peakRamBytes: 30 * GiB }) }),
        row({ workerId: "local", reading: reading({ peakCpuCores: 1, peakRamBytes: 2 * GiB }) }),
        row({ workerId: "local", reading: reading({ measured: false }) }),
      ],
      workerId: "local",
      reservation: { cpuCores: 2, ramGiB: 4, diskGB: 10 },
    });
    expect(footer.peaks).toEqual({ cpuCores: 1, ramGiB: 2, diskGB: 5 });
    expect(footer.share).toEqual({ cpuCores: 0.5, ramGiB: 0.5, diskGB: 0.5 });
  });
});

describe("boardCardActualsSample", () => {
  it("takes the largest value per dimension across the card's steps", () => {
    const sample = boardCardActualsSample(
      [
        row({ kind: "agent", reading: reading({ peakCpuCores: 0.2, peakRamBytes: 8 * GiB }) }),
        row({ kind: "ci", reading: reading({ peakCpuCores: 6, peakRamBytes: 3 * GiB }) }),
        row({ kind: "setup", reading: reading({ diskBytes: 12 * GB }) }),
      ],
      M,
    );
    expect(sample).toMatchObject({ cpu: 6, ram: 8, disk: 12 });
  });

  it("gives no sample without a measured CI pass or setup", () => {
    expect(boardCardActualsSample([row({ kind: "agent" })], M)).toBeNull();
    expect(
      boardCardActualsSample(
        [row({ kind: "agent" }), row({ kind: "ci", reading: reading({ measured: false }) })],
        M,
      ),
    ).toBeNull();
    // A partial pass is a lower bound, and a running one isn't over.
    expect(boardCardActualsSample([row({ reading: reading({ partial: true }) })], M)).toBeNull();
    expect(boardCardActualsSample([row({ reading: reading({ running: true }) })], M)).toBeNull();
  });

  it("normalises each dimension by the card's size multiplier", () => {
    const sample = boardCardActualsSample(
      [row({ reading: reading({ peakCpuCores: 3, peakRamBytes: 6 * GiB, diskBytes: 10 * GB }) })],
      { cpu: "XL", ram: "S", disk: "L" },
    );
    expect(sample).toMatchObject({ cpu: 2, ram: 8, disk: 8 });
  });
});

const samples = (values: ReadonlyArray<number>, age = 1): Array<BoardActualsCardSample> =>
  values.map((value, index) => ({ at: daysAgo(age + index * 0.01), cpu: value, ram: value, disk: value }));

describe("boardLearnedDimension", () => {
  it("needs five card samples in the last 30 days", () => {
    expect(boardLearnedDimension(samples([1, 2, 3, 4]), "cpu", NOW).value).toBeNull();
    const old = [...samples([1, 2, 3, 4]), ...samples([9], 31)];
    expect(boardLearnedDimension(old, "cpu", NOW)).toMatchObject({ value: null, samples: 4 });
    expect(boardLearnedDimension(samples([1, 2, 3, 4, 5]), "cpu", NOW).value).toBe(5);
  });

  it("is the 90th percentile across cards, rounded up", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9.2, 10];
    expect(boardLearnedDimension(samples(values), "cpu", NOW).value).toBe(10);
    expect(
      boardLearnedDimension(samples([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.3, 11]), "cpu", NOW)
        .value,
    ).toBe(3);
  });
});

describe("boardProjectLearned", () => {
  const declared = (cpuCores: number) => ({
    baseline: { cpuCores, ramGiB: 4, diskGB: 5, setAtUpgrade: false },
    setupTimeoutMinutes: null,
    readinessPath: null,
    readinessTimeoutSeconds: null,
  });

  it("marks an increase no ready worker could place at M, so it isn't applied", () => {
    const learned = boardProjectLearned({
      samples: samples([7, 7, 7, 7, 7]),
      resources: declared(4),
      readyWorkers: [
        { cpuCores: 6, ramGiB: 64, diskGB: 500 },
        { cpuCores: 4, ramGiB: 64, diskGB: 500 },
      ],
      nowIso: NOW,
    });
    expect(learned.cpu.unplaceable).toBe(true);
    expect(learned.ram.unplaceable).toBeUndefined();
  });

  it("marks nothing while no worker reports", () => {
    const learned = boardProjectLearned({
      samples: samples([7, 7, 7, 7, 7]),
      resources: declared(4),
      readyWorkers: [],
      nowIso: NOW,
    });
    expect(learned.cpu.unplaceable).toBeUndefined();
  });
});
