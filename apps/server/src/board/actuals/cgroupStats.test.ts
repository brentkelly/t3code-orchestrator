import { describe, expect, it } from "vite-plus/test";

import {
  ActualsAccumulator,
  parseCgroupSample,
  parseCpuUsageUsec,
  parseIoBytes,
  parseMemoryRamBytes,
} from "./cgroupStats.ts";

const NOT_MEASURED = { running: false, partial: false, diskBytes: null, notMeasuredReason: "none" };

describe("cgroup stat parsing", () => {
  it("reads usage_usec, anon + shmem (not file cache), and IO summed over devices", () => {
    expect(parseCpuUsageUsec("usage_usec 1500000\nuser_usec 1000000\nsystem_usec 500000\n")).toBe(
      1_500_000,
    );
    expect(parseMemoryRamBytes("anon 4096\nfile 999999\nkernel 12\nshmem 1024\n")).toBe(5120);
    expect(parseMemoryRamBytes("file 10\n")).toBeNull();
    expect(
      parseIoBytes(
        "8:0 rbytes=100 wbytes=200 rios=1 wios=2 dbytes=0 dios=0\n259:0 rbytes=5 wbytes=7 rios=1\n",
      ),
    ).toEqual({ read: 105, write: 207 });
    expect(parseIoBytes("")).toBeNull();
    // A group whose files are gone samples nothing.
    expect(parseCgroupSample({ cpuStat: null, memoryStat: null, ioStat: null })).toBeNull();
  });
});

const sample = (cpuSeconds: number, ramBytes = 0, io = { read: 0, write: 0 }) => ({
  cpuUsec: cpuSeconds * 1e6,
  ramBytes,
  io,
});

describe("ActualsAccumulator", () => {
  it("takes the highest 1-minute average rate, not a 5 s spike", () => {
    const accumulator = new ActualsAccumulator();
    // One core for a minute, then a 5 s burst at 8 cores, then idle.
    let cpu = 0;
    for (let second = 0; second <= 120; second += 5) {
      if (second > 0 && second <= 60) cpu += 5;
      if (second === 65) cpu += 40;
      accumulator.addTick(second * 1000, new Map([["a", sample(cpu)]]));
    }
    const reading = accumulator.reading(NOT_MEASURED);
    expect(reading.cpuCoreSeconds).toBe(100);
    // The window holding the burst: 40 s of it + 55 s of one core over 60 s.
    expect(reading.peakCpuCores).toBeCloseTo((40 + 55) / 60, 5);
    expect(reading.samples).toBe(25);
  });

  it("uses the whole step's average when no full minute was sampled", () => {
    const accumulator = new ActualsAccumulator();
    accumulator.addTick(0, new Map([["a", sample(0)]]));
    accumulator.addTick(20_000, new Map([["a", sample(40)]]));
    expect(accumulator.reading(NOT_MEASURED).peakCpuCores).toBe(2);

    // A fresh group created ~1 s before its first sample at one core: its first figure covers
    // time before that sample, so the average runs from that sample, not from 0.
    const fresh = new ActualsAccumulator();
    fresh.addTick(1_000, new Map([["ci", sample(1)]]), new Set(["ci"]));
    fresh.addTick(3_000, new Map([["ci", sample(3)]]), new Set(["ci"]));
    const reading = fresh.reading(NOT_MEASURED);
    expect(reading.cpuCoreSeconds).toBe(3);
    expect(reading.peakCpuCores).toBe(1);
  });

  it("peaks memory across groups alive together, and sums CPU and IO rises per group", () => {
    const accumulator = new ActualsAccumulator();
    accumulator.addTick(
      0,
      new Map([
        ["a", sample(10, 100, { read: 1000, write: 0 })],
        ["b", sample(5, 300)],
      ]),
    );
    accumulator.addTick(
      5_000,
      new Map([
        ["a", sample(12, 200, { read: 1500, write: 40 })],
        ["b", sample(9, 500)],
      ]),
    );
    // b's group is gone: it keeps its figures and stops counting towards memory.
    accumulator.addTick(
      10_000,
      new Map([
        ["a", sample(13, 150, { read: 1600, write: 40 })],
        ["b", null],
      ]),
    );
    const reading = accumulator.reading(NOT_MEASURED);
    expect(reading.cpuCoreSeconds).toBe(7);
    expect(reading.peakRamBytes).toBe(700);
    expect([reading.ioReadBytes, reading.ioWriteBytes]).toEqual([600, 40]);
  });

  it("reads not measured, never 0, when nothing was ever sampled", () => {
    const accumulator = new ActualsAccumulator();
    accumulator.addTick(0, new Map([["a", null]]));
    expect(accumulator.reading({ ...NOT_MEASURED, notMeasuredReason: "no cgroup" })).toMatchObject({
      measured: false,
      reason: "no cgroup",
      cpuCoreSeconds: null,
      peakRamBytes: null,
    });
  });
});
