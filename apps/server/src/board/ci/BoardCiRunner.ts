// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off globalDate:off
/**
 * Runs a CI pass's steps in a card's worktree (T3O-44/49).
 *
 * Each step is a shell command run with the worktree as its cwd, stdout and
 * stderr merged into one log. Steps run in groups (a step marked `parallel`
 * joins the one before it); groups run in order. With stop on failure (the
 * default) a failure stops later groups once its own group finishes; without
 * it every group runs and the pass fails at the end (T3O-57). The exit code
 * alone decides a step; a
 * result file at `$T3O_CI_RESULT` adds detail. A group that leaves tracked
 * changes in the worktree fails. Every step change is reported through
 * `emit`, with the last `BOARD_CI_TAIL_LINES` lines of output; the full log
 * goes to `<logDir>/<index>.log`.
 *
 * Each step runs in its own process group, so a timeout or an interrupted
 * pass (Skip CI, the card leaving CI) kills the whole tree, not just the
 * shell.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BOARD_CI_TAIL_LINES,
  boardCiStepGroups,
  parseBoardCiResultFile,
  type BoardCiHeadline,
  type BoardCiPassStep,
  type BoardCiStepDefinition,
  type BoardCiStepResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  makeBoardCiStepReporter,
  type BoardCiStepLive,
  type BoardCiStepReporter,
} from "./ciStepReporter.ts";
import {
  boardCiDirtyHeadline,
  boardCiFailureHeadline,
  BoardCiFailureFacts,
} from "./ciFailureHeadline.ts";
import { BoardDiskSpace, boardCiLowDiskReason } from "./diskSpace.ts";

export interface BoardCiRunRequest {
  readonly runId: string;
  readonly cwd: string;
  readonly steps: ReadonlyArray<BoardCiStepDefinition>;
  /** Where each step's full log is written; created if missing. */
  readonly logDir: string;
  /** The pass index of `steps[0]`, so a later segment's logs don't overwrite
      an earlier one's (T3O-49). */
  readonly indexOffset?: number;
  /** False runs every group even after a failure (T3O-57). Absent is true. */
  readonly stopOnFailure?: boolean;
  /** Each complete output line of a step, by its pass index (T3O-59), in
      order, delivered before the step settles. */
  readonly onLine?: (index: number, line: BoardCiLine) => Effect.Effect<void>;
}

export interface BoardCiStepProgress {
  readonly index: number;
  readonly step: BoardCiPassStep;
}

export type BoardCiRunResult =
  | {
      readonly result: "passed" | "failed";
      /** The step that failed or timed out (the first, unless a later one is a
          machine problem), or null on a pass. */
      readonly failedIndex: number | null;
      /** Every step of the request ran, rather than stopping at a failure. */
      readonly ranAll: boolean;
      /** The failed step's exit code (T3O-59), so a result that can't be
          saved can still say how the script ended. */
      readonly exitCode?: number | null;
      /** The failed step's headline (T3O-61), so whether it is a machine
          problem never waits on the step's own record landing. */
      readonly headline?: BoardCiHeadline;
    }
  /** The pass could not run at all (a placed worker out of reach): not a CI
      failure, so no fix agent is started. */
  | {
      readonly result: "unavailable";
      readonly failedIndex: null;
      readonly detail: string;
      /** The machine, not the code, stopped it: a full disk (T3O-59). */
      readonly machine?: boolean;
    };

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
  /** The signal that ended the shell, when one did (T3O-61). */
  readonly signal?: string | null;
}

/** False when the group is already empty, so nothing is left to signal. */
const killGroup = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
};

/** One output line of a step (T3O-59): numbered from 1, with the byte offset
    of its start in the step's `<n>.log`. */
export interface BoardCiLine {
  readonly line: string;
  readonly lineNo: number;
  readonly byteOffset: number;
}

/** Most characters a line keeps; its bytes are still counted in full. */
const BOARD_CI_LINE_MAX_CHARS = 64 * 1024;

/**
 * Splits a step's output into lines on `\n` only (a `\r\n`'s `\r` is dropped
 * from the text, a bare `\r` stays), tracking each line's byte offset so it
 * matches the step's log file, and when output last arrived.
 */
export class BoardCiLineReader {
  private partial = "";
  private partialBytes = 0;
  private nextLineNo = 1;
  private offset = 0;
  lastOutputAt: number | null = null;

  push(chunk: string, nowMs: number = Date.now()): ReadonlyArray<BoardCiLine> {
    if (chunk.length === 0) return [];
    this.lastOutputAt = nowMs;
    const lines: BoardCiLine[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      const segment = chunk.slice(start, newline === -1 ? undefined : newline);
      this.partialBytes += Buffer.byteLength(segment, "utf8");
      if (this.partial.length < BOARD_CI_LINE_MAX_CHARS) {
        this.partial += segment.slice(0, BOARD_CI_LINE_MAX_CHARS - this.partial.length);
      }
      if (newline === -1) break;
      lines.push(this.take(1));
      start = newline + 1;
    }
    return lines;
  }

  /** The last line, when the output didn't end with a newline. */
  flush(): ReadonlyArray<BoardCiLine> {
    return this.partialBytes === 0 ? [] : [this.take(0)];
  }

  private take(terminatorBytes: number): BoardCiLine {
    const line: BoardCiLine = {
      line: this.partial.endsWith("\r") ? this.partial.slice(0, -1) : this.partial,
      lineNo: this.nextLineNo,
      byteOffset: this.offset,
    };
    this.nextLineNo += 1;
    this.offset += this.partialBytes + terminatorBytes;
    this.partial = "";
    this.partialBytes = 0;
    return line;
  }
}

/** How a step is stopped; tests shorten the waits and stub the kill. */
export interface BoardCiStepTiming {
  readonly killGraceMs: number;
  readonly exitDrainMs: number;
  readonly killGroup: (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) => boolean;
}

const DEFAULT_STEP_TIMING: BoardCiStepTiming = {
  killGraceMs: KILL_GRACE_MS,
  exitDrainMs: EXIT_DRAIN_MS,
  killGroup,
};

/** Run one step to completion, killing its process group on timeout or when
    the surrounding fiber is interrupted. Every way out is bounded (T3O-59): a
    step past its time limit settles `timed-out` a grace after its kill even if
    the child never exits, and a log that won't flush is not waited on. */
export const runBoardCiStep = (input: {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly tail: BoardCiTail;
  readonly logPath: string;
  readonly resultPath: string;
  /** Every chunk of output, as it arrives. Must not block. */
  readonly onOutput?: (text: string) => void;
  readonly timing?: BoardCiStepTiming;
}): Effect.Effect<StepExit> =>
  Effect.callback<StepExit>((resume) => {
    const timing = input.timing ?? DEFAULT_STEP_TIMING;
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
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const child = NodeChildProcess.spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: process.env.CI ?? "1", T3O_CI_RESULT: input.resultPath },
    });
    // Per-stream decoders keep a multi-byte character split across chunks whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const onData = (text: string) => {
      input.tail.push(text);
      input.onOutput?.(text);
      if (!logBroken) log.write(text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const destroyPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const clearTimers = () => {
      clearTimeout(timer);
      if (hardTimer !== null) clearTimeout(hardTimer);
      if (drainTimer !== null) clearTimeout(drainTimer);
    };
    // Normally resolves once the log is flushed (or has failed), so a reader
    // of the step's log after it settles sees all of it; never waits longer
    // than the drain bound, and not at all on the hard-settle path.
    const finish = (exit: StepExit, waitForLog: boolean) => {
      if (settled) return;
      settled = true;
      clearTimers();
      let resumed = false;
      const done = () => {
        if (resumed) return;
        resumed = true;
        resume(Effect.succeed(exit));
      };
      if (!waitForLog || logBroken || log.destroyed) {
        if (!log.destroyed) log.end();
        return done();
      }
      const bound = setTimeout(done, timing.exitDrainMs);
      const flushed = () => {
        clearTimeout(bound);
        done();
      };
      log.once("error", flushed);
      log.end(flushed);
    };
    // Not unref()'d: on shutdown the SIGKILL must still land, or a step that
    // ignores TERM outlives the server and overlaps the recovered pass.
    // An empty group arms no SIGKILL: its pgid could be reused by then.
    const terminate = () => {
      if (!timing.killGroup(child, "SIGTERM")) return;
      if (killTimer === null) {
        killTimer = setTimeout(() => timing.killGroup(child, "SIGKILL"), timing.killGraceMs);
      }
    };
    const settleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) finish({ status: "timed-out", exitCode: code, signal }, true);
      else finish({ status: code === 0 ? "passed" : "failed", exitCode: code, signal }, true);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      input.tail.push(
        `\n[board] Step timed out after ${Math.round(input.timeoutMs / 60_000)} min; killed.\n`,
      );
      terminate();
      // A child that never reports its exit (stuck in the kernel, or a kill
      // that can't land) must not hold the pass for ever.
      hardTimer = setTimeout(() => {
        destroyPipes();
        finish({ status: "timed-out", exitCode: null }, false);
      }, timing.killGraceMs + timing.exitDrainMs);
    }, input.timeoutMs);
    child.on("error", (error) => {
      input.tail.push(`\n[board] Could not run the step: ${error.message}\n`);
      finish({ status: "failed", exitCode: null }, true);
    });
    child.on("exit", (code, signal) => {
      if (settled || drainTimer !== null) return;
      // What the step left running in its group is stopped with it.
      terminate();
      drainTimer = setTimeout(() => {
        destroyPipes();
        settleExit(code, signal);
      }, timing.exitDrainMs);
    });
    child.on("close", (code, signal) => settleExit(code, signal));
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      clearTimers();
      // Interrupted: kill now, and make sure nothing survives the grace. The
      // pipes stay open: a shell that can't report its killed child dies of
      // SIGPIPE before its TERM trap runs.
      terminate();
      log.end();
    });
  });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Run a step with its output split into lines for its reporter (T3O-60),
    `onLine` (T3O-59) and its failure facts (T3O-61). Node's callbacks only
    push onto a queue; a fiber scoped to the step delivers them, and the last
    line lands before the step's result. */
const withStepLines = <A>(
  index: number,
  onLine: BoardCiRunRequest["onLine"],
  reporter: BoardCiStepReporter,
  facts: BoardCiFailureFacts,
  run: (onOutput: (text: string) => void) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Effect.scoped(
    Effect.gen(function* () {
      const reader = new BoardCiLineReader();
      // `null` marks a chunk of output, ahead of the lines it completes.
      const events = yield* Queue.unbounded<BoardCiLine | null, Cause.Done>();
      const delivery = yield* Stream.fromQueue(events).pipe(
        Stream.runForEach((event) =>
          event === null
            ? reporter.output
            : onLine === undefined
              ? reporter.line(event.line)
              : Effect.andThen(reporter.line(event.line), onLine(index, event)),
        ),
        Effect.forkScoped,
      );
      const result = yield* run((text) => {
        Queue.offerUnsafe(events, null);
        for (const line of reader.push(text)) {
          facts.push(line);
          Queue.offerUnsafe(events, line);
        }
      });
      for (const line of reader.flush()) {
        facts.push(line);
        Queue.offerUnsafe(events, line);
      }
      Queue.endUnsafe(events);
      yield* Fiber.join(delivery);
      return result;
    }),
  );

/** The step's `$T3O_CI_RESULT` file, if it wrote one. A malformed file is a
    line in the tail, never a failure; an empty one is noted (T3O-61). */
const readStepResult = (
  resultPath: string,
  tail: BoardCiTail,
): { readonly result: BoardCiStepResult | null; readonly empty: boolean } => {
  let text: string;
  try {
    text = NodeFS.readFileSync(resultPath, "utf8");
  } catch {
    return { result: null, empty: false };
  }
  if (text.trim().length === 0) return { result: null, empty: true };
  const parsed = parseBoardCiResultFile(text);
  if (parsed.warning !== null) tail.push(`\n[board] ${parsed.warning}\n`);
  return { result: parsed.result, empty: false };
};

const changedLines = (status: string | null): ReadonlyArray<string> =>
  status === null ? [] : status.split("\n").filter((line) => line.trim().length > 0);

/** Each changed line keyed with its file's content hash, since a re-edit to an
    already-dirty file prints the same porcelain line. */
const changedSnapshot = (cwd: string, status: string | null): ReadonlyMap<string, string> => {
  const snapshot = new Map<string, string>();
  for (const line of changedLines(status)) {
    const path = line.slice(3).split(" -> ").at(-1)!;
    let digest = "absent";
    try {
      digest = NodeCrypto.createHash("sha1")
        .update(NodeFS.readFileSync(NodePath.join(cwd, path)))
        .digest("hex");
    } catch {
      // Deleted, or a quoted path: the porcelain line alone decides.
    }
    snapshot.set(`${line}\0${digest}`, line);
  }
  return snapshot;
};

/** Tracked files the group changed (`git status`, untracked ignored), or
    null when git can't say. A CI step must not edit the branch it checks. */
const trackedChanges = (cwd: string): Effect.Effect<string | null> =>
  Effect.callback<string | null>((resume) => {
    NodeChildProcess.execFile(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd },
      (error, stdout) => resume(Effect.succeed(error === null ? stdout.trimEnd() : null)),
    );
  });

/** The step's disk's free bytes now, for a disk headline; null when unknown. */
const freeBytesNow = (path: string) =>
  Effect.gen(function* () {
    const disk = yield* BoardDiskSpace;
    return yield* disk.freeBytes(path);
  }).pipe(Effect.catchCause(() => Effect.succeed(null)));

export const runBoardCiPass: BoardCiRunnerShape["run"] = Effect.fn("BoardCiRunner.run")(
  function* (request, emit) {
    // T3O-59: a full disk is the machine's problem, said before any step runs.
    const lowDisk = yield* boardCiLowDiskReason(request.cwd);
    if (lowDisk !== null) {
      return { result: "unavailable", failedIndex: null, detail: lowDisk, machine: true } as const;
    }
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
    const indexed = request.steps.map((definition, index) => ({
      definition,
      index,
      kind: "script" as const,
      parallel: definition.parallel === true,
    }));
    const groups = boardCiStepGroups(indexed);
    let firstFailed: {
      readonly failedIndex: number;
      readonly exitCode: number | null;
      readonly headline?: BoardCiHeadline;
    } | null = null;
    for (const [groupIndex, group] of groups.entries()) {
      // What was already changed is not this group's doing.
      const before = changedSnapshot(request.cwd, yield* trackedChanges(request.cwd));
      const settled = yield* Effect.forEach(
        group,
        ({ definition, index }) =>
          Effect.gen(function* () {
            const tail = new BoardCiTail();
            const startedAt = yield* nowIso;
            const base = {
              name: definition.name,
              command: definition.command,
              timeoutMinutes: definition.timeoutMinutes,
              ...(definition.parallel === true ? { parallel: true } : {}),
            };
            // T3O-60: every running report has an empty tail; the output
            // itself is read from the step's log.
            const running = (live: BoardCiStepLive) =>
              emit({
                index,
                step: {
                  ...base,
                  status: "running",
                  startedAt,
                  finishedAt: null,
                  exitCode: null,
                  tail: "",
                  ...live,
                },
              });
            yield* running({});
            const fileIndex = index + (request.indexOffset ?? 0);
            const resultPath = NodePath.join(request.logDir, `${fileIndex}.result.json`);
            // The reporter's scope ends with the step, before its settled row.
            const facts = new BoardCiFailureFacts();
            const { exit, progress } = yield* Effect.scoped(
              Effect.gen(function* () {
                const reporter = yield* makeBoardCiStepReporter(running);
                const exit = yield* withStepLines(
                  fileIndex,
                  request.onLine,
                  reporter,
                  facts,
                  (onOutput) =>
                    runBoardCiStep({
                      command: definition.command,
                      cwd: request.cwd,
                      timeoutMs: definition.timeoutMinutes * 60_000,
                      tail,
                      logPath: NodePath.join(request.logDir, `${fileIndex}.log`),
                      resultPath,
                      onOutput,
                    }),
                );
                return { exit, progress: reporter.progress() };
              }),
            );
            const { result, empty } = readStepResult(resultPath, tail);
            // T3O-61: a failed step says what failed and why, read here, on
            // the machine it ran on.
            const headline =
              exit.status === "passed"
                ? null
                : boardCiFailureHeadline(facts, {
                    stepName: definition.name,
                    status: exit.status,
                    exitCode: exit.exitCode,
                    signal: exit.signal ?? null,
                    timeoutMinutes: definition.timeoutMinutes,
                    result,
                    resultEmpty: empty,
                    host: NodeOS.hostname(),
                    freeBytes: yield* freeBytesNow(request.cwd),
                  });
            return { index, base, startedAt, exit, tail, result, progress, headline };
          }),
        { concurrency: "unbounded" },
      );
      // A group that edited tracked files fails as a whole: CI checks the
      // branch, it never changes it.
      const after = yield* trackedChanges(request.cwd);
      const dirty = [...changedSnapshot(request.cwd, after)]
        .filter(([key]) => !before.has(key))
        .map(([, line]) => line)
        .join("\n");
      const finishedAt = yield* nowIso;
      let failedIndex: number | null = null;
      let exitCode: number | null = null;
      let failedHeadline: BoardCiHeadline | undefined;
      for (const step of settled) {
        const status =
          step.exit.status === "passed" && dirty.length > 0 ? "failed" : step.exit.status;
        let headline = step.headline;
        if (status === "failed" && step.exit.status === "passed") {
          step.tail.push(
            `\n[board] The step group left tracked changes in the worktree:\n${dirty}\n`,
          );
          headline = boardCiDirtyHeadline(step.base.name, dirty);
        }
        yield* emit({
          index: step.index,
          step: {
            ...step.base,
            status,
            startedAt: step.startedAt,
            finishedAt,
            exitCode: step.exit.exitCode,
            tail: step.tail.text(),
            ...(step.result === null ? {} : { result: step.result }),
            // T3O-60: a settled step keeps where its progress got to.
            ...(step.progress === undefined ? {} : { progress: step.progress }),
            ...(headline === null ? {} : { headline }),
          },
        });
        // A machine problem in the group outranks a code failure beside it,
        // so the pass is held rather than sent to a fix round that can't help.
        if (
          status !== "passed" &&
          (failedIndex === null || (failedHeadline?.machine !== true && headline?.machine === true))
        ) {
          failedIndex = step.index;
          exitCode = step.exit.exitCode;
          failedHeadline = headline ?? undefined;
        }
      }
      // A later group's failure only takes over the pass's for a machine
      // problem, by the same rule as within a group.
      if (
        failedIndex !== null &&
        (firstFailed === null ||
          (firstFailed.headline?.machine !== true && failedHeadline?.machine === true))
      ) {
        firstFailed = {
          failedIndex,
          exitCode,
          ...(failedHeadline === undefined ? {} : { headline: failedHeadline }),
        };
      }
      if (firstFailed !== null && request.stopOnFailure !== false) {
        return {
          result: "failed",
          ...firstFailed,
          ranAll: groupIndex === groups.length - 1,
        } as const;
      }
    }
    return firstFailed === null
      ? ({ result: "passed", failedIndex: null, ranAll: true } as const)
      : ({ result: "failed", ...firstFailed, ranAll: true } as const);
  },
);

/** A Reference, like `BoardProjectFile`, so every board layer gets the real
    runner and a test swaps in a scripted one. */
export class BoardCiRunner extends Context.Reference<BoardCiRunnerShape>("t3/board/BoardCiRunner", {
  defaultValue: () => ({ run: runBoardCiPass }),
}) {}
