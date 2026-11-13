/**
 * T3o (T3O-87): cgroup v2 stats and the accumulator turning 5 s samples into a reading. Memory
 * is `anon` + `shmem`, never `memory.peak` (it counts page cache); the CPU peak is the highest
 * 1-minute average rate, or the whole step's average when no full minute was sampled.
 */
import { BOARD_ACTUALS_PEAK_WINDOW_MS, type BoardStepReading } from "@t3tools/contracts";

const statValue = (text: string, key: string): number | null => {
  const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
  return match === null ? null : Number(match[1]);
};

export function parseCpuUsageUsec(cpuStat: string): number | null {
  return statValue(cpuStat, "usage_usec");
}

export function parseMemoryRamBytes(memoryStat: string): number | null {
  const anon = statValue(memoryStat, "anon");
  const shmem = statValue(memoryStat, "shmem");
  return anon === null && shmem === null ? null : (anon ?? 0) + (shmem ?? 0);
}

/** `rbytes` and `wbytes` summed over every device line; null when the controller is absent. */
export function parseIoBytes(
  ioStat: string,
): { readonly read: number; readonly write: number } | null {
  let read = 0;
  let write = 0;
  let seen = false;
  for (const line of ioStat.split("\n")) {
    for (const field of line.trim().split(/\s+/)) {
      const [key, value] = field.split("=");
      if (value === undefined) continue;
      if (key === "rbytes") {
        read += Number(value);
        seen = true;
      } else if (key === "wbytes") {
        write += Number(value);
        seen = true;
      }
    }
  }
  return seen ? { read, write } : null;
}

/** One reading of one control group's files; null fields where a controller is missing. */
export interface CgroupSample {
  readonly cpuUsec: number | null;
  readonly ramBytes: number | null;
  readonly io: { readonly read: number; readonly write: number } | null;
}

export function parseCgroupSample(files: {
  readonly cpuStat: string | null;
  readonly memoryStat: string | null;
  readonly ioStat: string | null;
}): CgroupSample | null {
  if (files.cpuStat === null && files.memoryStat === null) return null;
  return {
    cpuUsec: files.cpuStat === null ? null : parseCpuUsageUsec(files.cpuStat),
    ramBytes: files.memoryStat === null ? null : parseMemoryRamBytes(files.memoryStat),
    io: files.ioStat === null ? null : parseIoBytes(files.ioStat),
  };
}

interface SourceState {
  first: CgroupSample;
  last: CgroupSample;
}

/**
 * A step's samples across its control groups (one for an agent, one per CI step for a pass).
 * A group whose files are gone keeps its last figures; it stops counting towards memory.
 */
export class ActualsAccumulator {
  private readonly sources = new Map<string, SourceState>();
  private readonly cpuSeries: Array<{ readonly atMs: number; readonly cpuUsec: number }> = [];
  // The first CPU point: a fresh group's figure there includes time before it was sampled.
  private cpuOrigin: { readonly atMs: number; readonly cpuUsec: number } | null = null;
  private lastCpuAtMs: number | null = null;
  private peakWindowCores: number | null = null;
  private peakRamBytes: number | null = null;
  private sampleCount = 0;

  /**
   * One tick: each source's sample now, or null when its files can't be read. A `fresh` source
   * is a group created for this step, so its counters started at 0 with it: nothing it did
   * before its first sample is lost.
   */
  addTick(
    atMs: number,
    samples: ReadonlyMap<string, CgroupSample | null>,
    fresh: ReadonlySet<string> = new Set(),
  ): void {
    let ramNow: number | null = null;
    let any = false;
    for (const [id, sample] of samples) {
      if (sample === null) continue;
      any = true;
      const held = this.sources.get(id);
      if (held === undefined) {
        const first = fresh.has(id)
          ? {
              cpuUsec: sample.cpuUsec === null ? null : 0,
              ramBytes: sample.ramBytes,
              io: sample.io === null ? null : { read: 0, write: 0 },
            }
          : sample;
        this.sources.set(id, { first, last: sample });
      } else held.last = sample;
      if (sample.ramBytes !== null) ramNow = (ramNow ?? 0) + sample.ramBytes;
    }
    if (!any) return;
    this.sampleCount += 1;
    if (ramNow !== null) this.peakRamBytes = Math.max(this.peakRamBytes ?? 0, ramNow);
    const cpuUsec = this.cpuUsec();
    if (cpuUsec === null) return;
    this.cpuSeries.push({ atMs, cpuUsec });
    this.cpuOrigin ??= { atMs, cpuUsec };
    this.lastCpuAtMs = atMs;
    // The newest point a full window before now, and nothing older than it.
    let reference: { readonly atMs: number; readonly cpuUsec: number } | null = null;
    while (
      this.cpuSeries.length > 0 &&
      this.cpuSeries[0]!.atMs <= atMs - BOARD_ACTUALS_PEAK_WINDOW_MS
    ) {
      reference = this.cpuSeries.shift()!;
    }
    if (reference !== null) {
      this.cpuSeries.unshift(reference);
      const cores = (cpuUsec - reference.cpuUsec) / 1e6 / ((atMs - reference.atMs) / 1000);
      this.peakWindowCores = Math.max(this.peakWindowCores ?? 0, cores);
    }
  }

  get samples(): number {
    return this.sampleCount;
  }

  private cpuUsec(): number | null {
    let total: number | null = null;
    for (const { first, last } of this.sources.values()) {
      if (first.cpuUsec === null || last.cpuUsec === null) continue;
      total = (total ?? 0) + Math.max(0, last.cpuUsec - first.cpuUsec);
    }
    return total;
  }

  private io(): { readonly read: number; readonly write: number } | null {
    let total: { read: number; write: number } | null = null;
    for (const { first, last } of this.sources.values()) {
      if (first.io === null || last.io === null) continue;
      total ??= { read: 0, write: 0 };
      total.read += Math.max(0, last.io.read - first.io.read);
      total.write += Math.max(0, last.io.write - first.io.write);
    }
    return total;
  }

  reading(input: {
    readonly running: boolean;
    readonly partial: boolean;
    readonly diskBytes: number | null;
    readonly notMeasuredReason: string;
  }): BoardStepReading {
    const cpuUsec = this.cpuUsec();
    if (this.sampleCount === 0) {
      return {
        measured: false,
        reason: input.notMeasuredReason,
        running: input.running,
        partial: input.partial,
        cpuCoreSeconds: null,
        peakCpuCores: null,
        peakRamBytes: null,
        ioReadBytes: null,
        ioWriteBytes: null,
        diskBytes: input.diskBytes,
        samples: 0,
      };
    }
    const origin = this.cpuOrigin;
    const elapsedSeconds =
      origin === null || this.lastCpuAtMs === null ? 0 : (this.lastCpuAtMs - origin.atMs) / 1000;
    const wholeStep =
      cpuUsec === null || origin === null || elapsedSeconds <= 0
        ? null
        : (cpuUsec - origin.cpuUsec) / 1e6 / elapsedSeconds;
    const io = this.io();
    return {
      measured: true,
      reason: null,
      running: input.running,
      partial: input.partial,
      cpuCoreSeconds: cpuUsec === null ? null : cpuUsec / 1e6,
      peakCpuCores: this.peakWindowCores ?? wholeStep,
      peakRamBytes: this.peakRamBytes,
      ioReadBytes: io?.read ?? null,
      ioWriteBytes: io?.write ?? null,
      diskBytes: input.diskBytes,
      samples: this.sampleCount,
    };
  }
}
