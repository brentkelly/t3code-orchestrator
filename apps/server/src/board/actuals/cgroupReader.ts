// @effect-diagnostics nodeBuiltinImport:off - reads cgroup files and asks systemd for a unit's group.
/**
 * T3o (T3O-87): every machine reading the step actuals take, behind one Reference so tests
 * inject them: a control group's stat files, and the group of a CI or setup scope's unit.
 * The worktree's footprint uses the capacity card's bounded `du` (`BoardMachine`).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { parseControlGroup } from "./agentScopeControlGroup.ts";

const SYSTEMCTL_TIMEOUT_MS = 5_000;

export interface BoardCgroupReaderShape {
  /** A file under `/sys/fs/cgroup/<controlGroup>/`, or null when it can't be read. */
  readonly readFile: (controlGroup: string, file: string) => Effect.Effect<string | null>;
  /** A systemd unit's control group, or null until it exists (or without systemd). */
  readonly unitControlGroup: (unit: string) => Effect.Effect<string | null>;
}

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
    }),
  },
) {}
