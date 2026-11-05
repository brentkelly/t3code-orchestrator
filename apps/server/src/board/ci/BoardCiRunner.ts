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
/** How long output may keep flowing after the step's shell exits. A child that
    escaped the process group (setsid, a daemon) can hold the pipes open for
    ever, so the step settles on exit plus this, not on the pipes closing. */
const EXIT_DRAIN_MS = 2_000;

/** Longest line the tail keeps; the rest of a longer line is dropped. */
export const BOARD_CI_TAIL_LINE_CHARS = 500;
/** Most characters the tail keeps in all. It reaches the event log, the pass
    row, every card-detail frame and the fix agent's prompt. */
const BOARD_CI_TAIL_CHARS = 16_000;

// A bare `\r` (progress bars) ends a line too; one at the very end of a chunk
// waits for the next, which may carry the `\n` of a `\r\n`.
const LINE_BREAK = /\r?\n|\r(?!$)/;

const clipLine = (line: string, clipped: boolean, maxChars: number): string =>
  clipped || line.length > maxChars ? `${line.slice(0, maxChars)} … [line truncated]` : line;

/** A rolling buffer of the last `maxLines` output lines, bounded in size. */
export class BoardCiTail {
  private lines: string[] = [];
  private partial = "";
  private partialClipped = false;
  private readonly maxLines: number;
  private readonly maxLineChars: number;
  private readonly maxChars: number;
  constructor(
    maxLines: number = BOARD_CI_TAIL_LINES,
    maxLineChars: number = BOARD_CI_TAIL_LINE_CHARS,
    maxChars: number = BOARD_CI_TAIL_CHARS,
  ) {
    this.maxLines = maxLines;
    this.maxLineChars = maxLineChars;
    this.maxChars = maxChars;
  }

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(LINE_BREAK);
    const rest = parts.pop() ?? "";
    parts.forEach((line, index) => {
      this.lines.push(clipLine(line, index === 0 && this.partialClipped, this.maxLineChars));
    });
    if (parts.length > 0) this.partialClipped = false;
    if (rest.length > this.maxLineChars) {
      // Keep a held-back `\r` so the next redraw still starts a new line.
      this.partial = rest.slice(0, this.maxLineChars) + (rest.endsWith("\r") ? "\r" : "");
      this.partialClipped = true;
    } else {
      this.partial = rest;
    }
    if (this.lines.length > this.maxLines) this.lines = this.lines.slice(-this.maxLines);
  }

  text(): string {
    const partial = this.partial.replace(/\r$/, "");
    const all =
      partial.length > 0 || this.partialClipped
        ? [...this.lines, clipLine(partial, this.partialClipped, this.maxLineChars)]
        : this.lines;
    const text = all.slice(-this.maxLines).join("\n");
    if (text.length <= this.maxChars) return text;
    const cut = text.slice(-this.maxChars);
    const lineStart = cut.indexOf("\n");
    return lineStart === -1 ? cut : cut.slice(lineStart + 1);
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
    // Per-stream decoders keep a multi-byte character split across chunks whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const onData = (text: string) => {
      input.tail.push(text);
      if (!logBroken) log.write(text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Resolves only once the log is flushed (or has failed), so a reader of
    // the step's log after it settles sees all of it.
    const finish = (exit: StepExit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let resumed = false;
      const done = () => {
        if (resumed) return;
        resumed = true;
        resume(Effect.succeed(exit));
      };
      if (logBroken || log.destroyed) return done();
      log.once("error", done);
      log.end(done);
    };
    // Not unref()'d: on shutdown the SIGKILL must still land, or a step that
    // ignores TERM outlives the server and overlaps the recovered pass.
    const terminate = () => {
      killGroup(child, "SIGTERM");
      if (killTimer === null) {
        killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      }
    };
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const settleExit = (code: number | null) => {
      if (drainTimer !== null) clearTimeout(drainTimer);
      if (timedOut) finish({ status: "timed-out", exitCode: code });
      else finish({ status: code === 0 ? "passed" : "failed", exitCode: code });
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
    child.on("exit", (code) => {
      if (settled) return;
      // What the step left running in its group is stopped with it.
      terminate();
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settleExit(code);
      }, EXIT_DRAIN_MS);
    });
    child.on("close", (code) => settleExit(code));
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Interrupted: kill now, and make sure nothing survives the grace.
      killGroup(child, "SIGTERM");
      if (drainTimer !== null) clearTimeout(drainTimer);
      setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
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
