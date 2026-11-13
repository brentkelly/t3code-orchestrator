// @effect-diagnostics nodeBuiltinImport:off - reads the machine: cores, memory, cgroup files, du.
/**
 * Every machine reading worker capacity uses (T3O-86), behind one Reference so tests inject
 * values: cores, total and available memory, the agent slice's `memory.high`, free disk on
 * the worktree volume, and a worktree's size by a bounded `du`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { BoardDiskSpace } from "../ci/diskSpace.ts";

const GiB = 1024 ** 3;
const GB = 1000 ** 3;
const DU_TIMEOUT_MS = 30_000;

export interface BoardMachineShape {
  readonly cpuCount: Effect.Effect<number>;
  readonly totalMemoryBytes: Effect.Effect<number>;
  /** The kernel's available memory (`MemAvailable`), not "free"; null when unknown. */
  readonly availableMemoryBytes: Effect.Effect<number | null>;
  /** The agents slice's `memory.high`, or null where it can't be read. */
  readonly agentSliceMemoryHighBytes: Effect.Effect<number | null>;
  readonly freeDiskBytes: (path: string) => Effect.Effect<number | null>;
  /** A worktree's size, bounded in time; null when `du` fails or runs out of time. */
  readonly diskUsageBytes: (path: string) => Effect.Effect<number | null>;
}

const readMemAvailable = Effect.sync((): number | null => {
  try {
    const meminfo = NodeFS.readFileSync("/proc/meminfo", "utf8");
    const kb = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
    if (kb !== undefined) return Number(kb) * 1024;
  } catch {
    // Not Linux: libuv's free memory is the closest reading.
  }
  return NodeOS.freemem();
});

const readSliceMemoryHigh = Effect.sync((): number | null => {
  // Only Linux has the file; elsewhere the read fails and the fallback applies.
  const uid = NodeOS.userInfo().uid;
  const path = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/app-t3code.slice/app-t3code-agents.slice/memory.high`;
  try {
    const value = Number(NodeFS.readFileSync(path, "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
});

const duBytes = (path: string): Effect.Effect<number | null> =>
  Effect.callback<number | null>((resume) => {
    const child = NodeChildProcess.execFile(
      "du",
      ["-sk", path],
      { timeout: DU_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout) => {
        const kb = Number(/^(\d+)/.exec(stdout)?.[1]);
        resume(Effect.succeed(error === null && Number.isFinite(kb) ? kb * 1024 : null));
      },
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

export class BoardMachine extends Context.Reference<BoardMachineShape>(
  "t3/board/capacity/machine/BoardMachine",
  {
    defaultValue: () => ({
      cpuCount: Effect.sync(() => NodeOS.cpus().length),
      totalMemoryBytes: Effect.sync(() => NodeOS.totalmem()),
      availableMemoryBytes: readMemAvailable,
      agentSliceMemoryHighBytes: readSliceMemoryHigh,
      freeDiskBytes: Effect.fn("BoardMachine.freeDiskBytes")(function* (path: string) {
        const disk = yield* BoardDiskSpace;
        return yield* disk.freeBytes(path);
      }),
      diskUsageBytes: duBytes,
    }),
  },
) {}

export const bytesToGiB = (bytes: number) => bytes / GiB;
export const bytesToGB = (bytes: number) => bytes / GB;

/** RAM a worker offers by default: the agent slice's `memory.high` less 2 GiB; without the
    slice, total less 8 GiB and at least half of total. */
export function defaultRamGiB(totalBytes: number, sliceHighBytes: number | null): number {
  if (sliceHighBytes !== null && sliceHighBytes < totalBytes) {
    return Math.max(1, Math.floor(bytesToGiB(sliceHighBytes) - 2));
  }
  return Math.floor(Math.max(bytesToGiB(totalBytes) - 8, bytesToGiB(totalBytes) / 2));
}
