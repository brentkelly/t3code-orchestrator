// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off
/**
 * Runs a CI pass's steps in a card's worktree (T3O-44).
 *
 * Each step is a shell command run with the worktree as its cwd, stdout and
 * stderr merged into one log. Steps run in order and the pass stops at the
 * first non-zero exit or timeout. Every step change is reported through
 * `emit`, with the last `BOARD_CI_TAIL_LINES` lines of output; the full log
 * goes to `<logDir>/<index>.log`.
 *
 * Each step runs in its own process group, so a timeout or an interrupted
 * pass (Skip CI, the card leaving CI) kills the whole tree, not just the
 * shell.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BOARD_CI_TAIL_LINES,
  type BoardCiPassStep,
  type BoardCiStepDefinition,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export interface BoardCiRunRequest {
  readonly runId: string;
  readonly cwd: string;
  readonly steps: ReadonlyArray<BoardCiStepDefinition>;
  /** Where each step's full log is written; created if missing. */
  readonly logDir: string;
}

export interface BoardCiStepProgress {
  readonly index: number;
  readonly step: BoardCiPassStep;
}

export type BoardCiRunResult =
  | {
      readonly result: "passed" | "failed";
      /** The step that failed or timed out, or null on a pass. */
      readonly failedIndex: number | null;
    }
  /** The pass could not run at all (a placed worker out of reach): not a CI
      failure, so no fix agent is started. */
  | { readonly result: "unavailable"; readonly failedIndex: null; readonly detail: string };

export interface BoardCiRunnerShape {
  readonly run: (
    request: BoardCiRunRequest,
    emit: (progress: BoardCiStepProgress) => Effect.Effect<void>,
  ) => Effect.Effect<BoardCiRunResult>;
}

/** The worktree-relative log directory of one pass. The runner keeps it out
    of git through the repository's `info/exclude` (`ensureCiLogsExcluded`). */
export function boardCiLogDir(worktreePath: string, runId: string): string {
  return NodePath.join(worktreePath, ".t3", "ci", runId);
}

const CI_LOG_EXCLUDE = "/.t3/ci/";

/** Keep CI logs out of `git status` (worktree reclaim refuses an untracked
    file) and out of the fix agent's commits, in repos that don't ignore
    `.t3/`. `info/exclude` is shared by every worktree of the repository. */
export const ensureCiLogsExcluded = (cwd: string): Effect.Effect<void> =>
  Effect.callback<string | null>((resume) => {
    NodeChildProcess.execFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { cwd },
      (error, stdout) => resume(Effect.succeed(error === null ? stdout.trim() : null)),
    );
  }).pipe(
    Effect.flatMap((excludePath) =>
      excludePath === null || excludePath.length === 0
        ? Effect.void
        : Effect.try(() => {
            const current = NodeFS.existsSync(excludePath)
              ? NodeFS.readFileSync(excludePath, "utf8")
              : "";
            if (current.split(/\r?\n/).includes(CI_LOG_EXCLUDE)) return;
            NodeFS.mkdirSync(NodePath.dirname(excludePath), { recursive: true });
            const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
            NodeFS.appendFileSync(excludePath, `${separator}${CI_LOG_EXCLUDE}\n`);
          }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("board CI could not exclude its logs from git", {
        cwd,
        cause: Cause.pretty(cause),
      }),
    ),
  );

/** How long a killed step's process group gets to exit before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** A rolling buffer of the last `max` output lines. */
export class BoardCiTail {
  private lines: string[] = [];
  private partial = "";
  private readonly max: number;
  constructor(max: number = BOARD_CI_TAIL_LINES) {
    this.max = max;
  }

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    if (parts.length === 0) return;
    this.lines.push(...parts);
    if (this.lines.length > this.max) this.lines = this.lines.slice(-this.max);
  }

  text(): string {
    const all = this.partial.length > 0 ? [...this.lines, this.partial] : this.lines;
    return all.slice(-this.max).join("\n");
  }
}

interface StepExit {
  readonly status: "passed" | "failed" | "timed-out";
  readonly exitCode: number | null;
}

const killGroup = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
};

/** Run one step to completion, killing its process group on timeout or when
    the surrounding fiber is interrupted. */
const runStep = (input: {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly tail: BoardCiTail;
  readonly logPath: string;
}): Effect.Effect<StepExit> =>
  Effect.callback<StepExit>((resume) => {
    const log = NodeFS.createWriteStream(input.logPath, { flags: "w" });
    let logBroken = false;
    // Without a listener a write error (ENOSPC, EACCES) is an uncaught
    // exception; the step still runs and its tail still reports.
    log.on("error", (error) => {
      if (logBroken) return;
      logBroken = true;
      input.tail.push(`\n[board] Could not write the step's log: ${error.message}\n`);
    });
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const child = NodeChildProcess.spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: process.env.CI ?? "1" },
    });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      input.tail.push(text);
      if (!logBroken) log.write(text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const finish = (exit: StepExit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      log.end();
      resume(Effect.succeed(exit));
    };
    const terminate = () => {
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      input.tail.push(
        `\n[board] Step timed out after ${Math.round(input.timeoutMs / 60_000)} min; killed.\n`,
      );
      terminate();
    }, input.timeoutMs);
    child.on("error", (error) => {
      input.tail.push(`\n[board] Could not run the step: ${error.message}\n`);
      finish({ status: "failed", exitCode: null });
    });
    child.on("close", (code) => {
      if (timedOut) finish({ status: "timed-out", exitCode: code });
      else finish({ status: code === 0 ? "passed" : "failed", exitCode: code });
    });
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Interrupted: kill now, and make sure nothing survives the grace.
      killGroup(child, "SIGTERM");
      const hard = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      hard.unref?.();
      log.end();
    });
  });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const runBoardCiPass: BoardCiRunnerShape["run"] = Effect.fn("BoardCiRunner.run")(
  function* (request, emit) {
    yield* ensureCiLogsExcluded(request.cwd);
    const logDirError = yield* Effect.try({
      try: () => NodeFS.mkdirSync(request.logDir, { recursive: true }),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(
      Effect.as(null),
      Effect.catch((message) => Effect.succeed(message)),
    );
    if (logDirError !== null) {
      return {
        result: "unavailable",
        failedIndex: null,
        detail: `CI could not create its log directory: ${logDirError}.`,
      } as const;
    }
    for (const [index, definition] of request.steps.entries()) {
      const tail = new BoardCiTail();
      const startedAt = yield* nowIso;
      const base = {
        name: definition.name,
        command: definition.command,
        timeoutMinutes: definition.timeoutMinutes,
      };
      yield* emit({
        index,
        step: { ...base, status: "running", startedAt, finishedAt: null, exitCode: null, tail: "" },
      });
      const exit = yield* runStep({
        command: definition.command,
        cwd: request.cwd,
        timeoutMs: definition.timeoutMinutes * 60_000,
        tail,
        logPath: NodePath.join(request.logDir, `${index}.log`),
      });
      yield* emit({
        index,
        step: {
          ...base,
          status: exit.status,
          startedAt,
          finishedAt: yield* nowIso,
          exitCode: exit.exitCode,
          tail: tail.text(),
        },
      });
      if (exit.status !== "passed") return { result: "failed", failedIndex: index } as const;
    }
    return { result: "passed", failedIndex: null } as const;
  },
);

/** A Reference, like `BoardProjectConfig`, so every board layer gets the real
    runner and a test swaps in a scripted one. */
export class BoardCiRunner extends Context.Reference<BoardCiRunnerShape>("t3/board/BoardCiRunner", {
  defaultValue: () => ({ run: runBoardCiPass }),
}) {}
