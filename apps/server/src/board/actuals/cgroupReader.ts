// @effect-diagnostics nodeBuiltinImport:off - reads cgroup files and asks systemd for a unit's group.
/**
 * T3o (T3O-87): every machine reading the step actuals take, behind one Reference so tests
 * inject them: a control group's stat files, and the group of a CI or setup scope's unit.
 * The worktree's footprint uses the capacity card's bounded `du` (`BoardMachine`).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { parseControlGroup } from "./agentScopeControlGroup.ts";

const SYSTEMCTL_TIMEOUT_MS = 5_000;

export interface BoardCgroupReaderShape {
  /** A file under `/sys/fs/cgroup/<controlGroup>/`, or null when it can't be read. */
  readonly readFile: (controlGroup: string, file: string) => Effect.Effect<string | null>;
  /** A systemd unit's control group, or null until it exists (or without systemd). */
  readonly unitControlGroup: (unit: string) => Effect.Effect<string | null>;
  /**
   * A wrapped scope's group is removed the moment its command exits, taking the last
   * seconds' counters with it. `script` is shell that, run as an EXIT trap inside the scope,
   * copies the stat files out; `read` returns (and removes) that copy. Null script: no copy.
   */
  readonly finalSnapshot: {
    readonly script: (id: string) => string | null;
    readonly read: (id: string) => Effect.Effect<CgroupFinalSnapshot | null>;
  };
}

export interface CgroupFinalSnapshot {
  readonly controlGroup: string;
  readonly cpuStat: string | null;
  readonly memoryStat: string | null;
  readonly ioStat: string | null;
}

const SNAPSHOT_FILES = ["cpu.stat", "memory.stat", "io.stat"] as const;

const FINAL_DIR_PREFIX = "t3o-actuals-";

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Folders a crashed or killed server left: named for their owner's pid, which is gone. */
const sweepStaleFinalDirs = () => {
  let names: ReadonlyArray<string>;
  try {
    names = NodeFS.readdirSync(NodeOS.tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^t3o-actuals-(\d+)-/.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || processAlive(pid)) continue;
    try {
      NodeFS.rmSync(NodePath.join(NodeOS.tmpdir(), name), { recursive: true, force: true });
    } catch {
      // Another user's, or already gone.
    }
  }
};

/** A private folder (mkdtemp: unguessable, mode 0700), made on first use and removed at exit:
    the trap writes into it, so nobody else may plant links there. Null when it can't be made. */
let finalDir: string | null | undefined;
const finalDirOf = (): string | null => {
  if (finalDir !== undefined) return finalDir;
  sweepStaleFinalDirs();
  try {
    const made = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), `${FINAL_DIR_PREFIX}${process.pid}-`),
    );
    process.once("exit", () => NodeFS.rmSync(made, { recursive: true, force: true }));
    finalDir = made;
  } catch {
    finalDir = null;
  }
  return finalDir;
};

const finalScript = (id: string) => {
  const base = finalDirOf();
  if (base === null) return null;
  const dir = NodePath.join(base, id);
  if (/['"$`\\]/.test(dir)) return null;
  const copy = [
    `g=$(sed -n "s/^0:://p" /proc/self/cgroup)`,
    `d="${dir}"`,
    `mkdir -p "$d" && printf %s "$g" >"$d/cgroup"`,
    `for f in ${SNAPSHOT_FILES.join(" ")}; do cat "/sys/fs/cgroup$g/$f" >"$d/$f" 2>/dev/null; done`,
  ].join("; ");
  return `trap '${copy}' EXIT`;
};

const readFinal = (id: string) =>
  Effect.sync((): CgroupFinalSnapshot | null => {
    const base = finalDirOf();
    if (base === null) return null;
    const dir = NodePath.join(base, id);
    const read = (file: string) => {
      try {
        return NodeFS.readFileSync(NodePath.join(dir, file), "utf8");
      } catch {
        return null;
      }
    };
    const controlGroup = read("cgroup");
    if (controlGroup === null) return null;
    const snapshot = {
      controlGroup: controlGroup.trim(),
      cpuStat: read("cpu.stat"),
      memoryStat: read("memory.stat"),
      ioStat: read("io.stat"),
    };
    NodeFS.rmSync(dir, { recursive: true, force: true });
    return snapshot;
  });

const readCgroupFile = (controlGroup: string, file: string) =>
  Effect.callback<string | null>((resume) => {
    NodeFS.readFile(`/sys/fs/cgroup${controlGroup}/${file}`, "utf8", (error, text) =>
      resume(Effect.succeed(error === null ? text : null)),
    );
  });

const showUnitControlGroup = (unit: string) =>
  Effect.callback<string | null>((resume) => {
    const child = NodeChildProcess.execFile(
      "systemctl",
      ["--user", "show", unit, "--property=ControlGroup"],
      { timeout: SYSTEMCTL_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout) => resume(Effect.succeed(error === null ? parseControlGroup(stdout) : null)),
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

export class BoardCgroupReader extends Context.Reference<BoardCgroupReaderShape>(
  "t3/board/actuals/BoardCgroupReader",
  {
    defaultValue: () => ({
      readFile: readCgroupFile,
      unitControlGroup: showUnitControlGroup,
      finalSnapshot: { script: finalScript, read: readFinal },
    }),
  },
) {}
