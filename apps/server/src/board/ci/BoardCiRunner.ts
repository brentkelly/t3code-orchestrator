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

export interface BoardCiRunResult {
  readonly result: "passed" | "failed";
  /** The step that failed or timed out, or null on a pass. */
  readonly failedIndex: number | null;
}

export interface BoardCiRunnerShape {
  readonly run: (
    request: BoardCiRunRequest,
    emit: (progress: BoardCiStepProgress) => Effect.Effect<void>,
  ) => Effect.Effect<BoardCiRunResult>;
}

/** The worktree-relative log directory of one pass. Gitignored by the
    worktree's `.t3/` entry. */
export function boardCiLogDir(worktreePath: string, runId: string): string {
  return NodePath.join(worktreePath, ".t3", "ci", runId);
}

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
      log.write(text);
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
    yield* Effect.sync(() => NodeFS.mkdirSync(request.logDir, { recursive: true }));
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
