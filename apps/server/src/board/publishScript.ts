/**
 * Run a project's publish-on-done shell command in its default checkout.
 *
 * Not a board step and not a worktree setup terminal: there is no thread to
 * attach a PTY to. The command is the one the project named in t3.json /
 * Project Actions (`runOnCardDone`). Timeout is 15 minutes.
 *
 * On Unix the child is a process-group leader so timeout can SIGTERM the
 * whole tree, wait a short grace, then SIGKILL. Fiber interrupt and effect
 * finalizers SIGKILL immediately, so a SIGTERM-ignoring group does not
 * survive a server restart. Windows still signals only the shell.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { BOARD_PUBLISH_ON_DONE_TIMEOUT_MS } from "./publishOnDone.ts";

export interface PublishScriptResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly detail: string;
}

const DETAIL_MAX = 400;
const KILL_GRACE_MS = 2_000;

const inFlight = new Set<number>();

function killProcessTree(
  pid: number | undefined,
  child: NodeChildProcess.ChildProcess | undefined,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") child?.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    // Already gone, or not a process group.
  }
}

process.on("exit", () => {
  for (const pid of inFlight) {
    killProcessTree(pid, undefined, "SIGKILL");
  }
});

function trimDetail(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= DETAIL_MAX) return cleaned;
  return cleaned.slice(cleaned.length - DETAIL_MAX);
}

export const runPublishScript = Effect.fn("board-runPublishScript")(function* (input: {
  readonly cwd: string;
  readonly command: string;
  readonly extraEnv?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? BOARD_PUBLISH_ON_DONE_TIMEOUT_MS;
  const killGraceMs = input.killGraceMs ?? KILL_GRACE_MS;
  let pid: number | undefined;
  let child: NodeChildProcess.ChildProcess | undefined;
  let killing = false;
  const killTree = (signal: NodeJS.Signals) => killProcessTree(pid, child, signal);
  const run = Effect.callback<PublishScriptResult>((resume) => {
    child = NodeChildProcess.spawn(input.command, {
      cwd: input.cwd,
      env: {
        ...process.env,
        T3CODE_PROJECT_ROOT: input.cwd,
        ...input.extraEnv,
      },
      shell: true,
      detached: process.platform !== "win32",
    });
    pid = child.pid;
    if (pid !== undefined) inFlight.add(pid);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const appendTail = (current: string, chunk: Buffer | string): string => {
      const next = current + String(chunk);
      return next.length <= DETAIL_MAX ? next : next.slice(next.length - DETAIL_MAX);
    };
    const settle = (result: PublishScriptResult) => {
      if (settled) return;
      settled = true;
      if (pid !== undefined) inFlight.delete(pid);
      resume(Effect.succeed(result));
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendTail(stderr, chunk);
    });
    child.on("close", (code) => {
      if (killing) return;
      const detail = trimDetail(stderr.length > 0 ? stderr : stdout);
      settle({
        exitCode: code,
        timedOut: false,
        detail:
          code === 0
            ? detail
            : detail.length > 0
              ? detail
              : `Publish command exited ${code === null ? "without a code" : String(code)}.`,
      });
    });
    child.on("error", (error) => {
      if (killing) return;
      settle({
        exitCode: null,
        timedOut: false,
        detail: error.message,
      });
    });
    return Effect.sync(() => {
      if (!settled) {
        killing = true;
        killTree("SIGKILL");
      }
    });
  });
  return yield* run.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.sync(() => {
          killing = true;
          killTree("SIGTERM");
        }).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(killGraceMs))),
          Effect.andThen(Effect.sync(() => killTree("SIGKILL"))),
          Effect.map(
            () =>
              ({
                exitCode: null,
                timedOut: true,
                detail: `Publish timed out after ${Math.round(timeoutMs / 60_000)} minutes.`,
              }) satisfies PublishScriptResult,
          ),
        ),
    }),
    Effect.ensuring(
      Effect.sync(() => {
        if (pid === undefined) return;
        if (inFlight.has(pid)) killTree("SIGKILL");
        inFlight.delete(pid);
      }),
    ),
  );
});
