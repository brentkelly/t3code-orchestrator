/**
 * Run a project's publish-on-done shell command in its default checkout.
 *
 * Not a board step and not a worktree setup terminal: there is no thread to
 * attach a PTY to. The command is the one the project named in t3.json /
 * Project Actions (`runOnCardDone`). Timeout is 15 minutes.
 *
 * The child PID is captured at spawn so a timeout kills only that process.
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
}) {
  const timeoutMs = input.timeoutMs ?? BOARD_PUBLISH_ON_DONE_TIMEOUT_MS;
  const run = Effect.callback<PublishScriptResult>((resume) => {
    const child = NodeChildProcess.spawn(input.command, {
      cwd: input.cwd,
      env: {
        ...process.env,
        T3CODE_PROJECT_ROOT: input.cwd,
        ...input.extraEnv,
      },
      shell: true,
    });
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: PublishScriptResult) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(result));
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
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
      settle({
        exitCode: null,
        timedOut: false,
        detail: error.message,
      });
    });
    return Effect.sync(() => {
      if (!settled && pid !== undefined) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    });
  });
  return yield* run.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.succeed({
          exitCode: null,
          timedOut: true,
          detail: "Publish timed out after 15 minutes.",
        } satisfies PublishScriptResult),
    }),
  );
});
