// @effect-diagnostics nodeBuiltinImport:off - argv0 and a whole-group kill need node's spawn.
/**
 * T3o: how a readiness check runs a program (T3O-124). `processRunner` merges `env` over the
 * worker's, pipes stdin and can't set `argv0`, so checks spawn here: a resolved absolute path, a
 * replaced environment, cwd `/` (shims read version pins from the cwd and its parents), stdin
 * ignored, its own process group killed on timeout, and at most 64 KB of output kept.
 */
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";

import type { ReadinessRun } from "./readinessChecks.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
/** How long to wait for output after the program exits; a daemon it left may hold the pipes. */
const EXIT_GRACE_MS = 1000;

export interface ReadinessSpawnInput {
  /** An absolute path t3o resolved and vetted; never looked up on PATH again. */
  readonly path: string;
  /** What the program sees as its name, so shims (rustup, volta, mise) act as themselves. */
  readonly argv0: string;
  readonly args: ReadonlyArray<string>;
  /** The whole environment: nothing of the worker's passes unless it is here. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export const spawnReadinessProbe = (
  input: ReadinessSpawnInput,
  platform: NodeJS.Platform,
): Effect.Effect<ReadinessRun> =>
  Effect.callback<ReadinessRun>((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(input.path, [...input.args], {
        argv0: input.argv0,
        cwd: "/",
        env: { ...input.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
        shell: false,
        windowsHide: true,
      });
    } catch {
      resume(
        Effect.succeed({ exitCode: null, stdout: "", stderr: "could not start", timedOut: false }),
      );
      return;
    }
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let kept = 0;
    let timedOut = false;
    let done = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // The group outlives its leader, so it is killed even after the program itself exited.
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        if (platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const keep = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = MAX_OUTPUT_BYTES - kept;
      if (room <= 0) return;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      kept += part.length;
      chunks[stream].push(part);
    };
    child.stdout?.on("data", keep("stdout"));
    child.stderr?.on("data", keep("stderr"));
    // @effect-diagnostics-next-line globalTimersInEffect:off - a node callback, not an Effect.
    const timer = setTimeout(
      () => {
        timedOut = true;
        killGroup();
        // A process outside the group can still hold the pipes; stop waiting for it.
        finish(null);
      },
      Math.max(1, Math.min(input.timeoutMs, 600_000)),
    );
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resume(
        Effect.succeed({
          exitCode: timedOut ? null : exitCode,
          stdout: Buffer.concat(chunks.stdout).toString("utf8"),
          stderr: Buffer.concat(chunks.stderr).toString("utf8"),
          timedOut,
        }),
      );
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => {
      // @effect-diagnostics-next-line globalTimers:off - a node callback, not an Effect.
      grace = setTimeout(() => finish(code), EXIT_GRACE_MS);
    });
    return Effect.sync(() => {
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      killGroup();
    });
  });
