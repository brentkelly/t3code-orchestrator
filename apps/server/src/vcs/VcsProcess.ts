import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type VcsError,
  VcsProcessExitError,
  type VcsProcessExitFailureKind,
  VcsProcessMissingExitCodeError,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
  VcsProcessSpawnError,
  VcsProcessStdinWriteError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
// T3o: per-project GitHub token overrides for `gh` subprocesses (t3o-34).
import { scrubGitenvTokens, withGitenvTokenEnv } from "../sourceControl/gitenv.ts";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly spawnCwd?: string;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Present on real process output; optional so narrow test doubles remain lightweight. */
  readonly stdoutInvalidUtf8?: boolean;
  readonly stderrInvalidUtf8?: boolean;
}

export class VcsProcess extends Context.Service<
  VcsProcess,
  {
    readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
  }
>()("t3/vcs/VcsProcess") {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

const classifyNonZeroExit = (command: string, stderr: string): VcsProcessExitFailureKind => {
  const normalized = stderr.toLowerCase();

  if (
    normalized.includes("authentication failed") ||
    normalized.includes("not logged in") ||
    normalized.includes("gh auth login") ||
    normalized.includes("glab auth login") ||
    normalized.includes("az devops login") ||
    normalized.includes("please run az login") ||
    normalized.includes("no oauth token") ||
    normalized.includes("unauthorized")
  ) {
    return "authentication";
  }

  if (
    normalized.includes("api rate limit") ||
    normalized.includes("rate limit exceeded") ||
    normalized.includes("secondary rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("http 429")
  ) {
    return "rate-limited";
  }

  if (
    (command === "gh" &&
      (normalized.includes("could not resolve to a pullrequest") ||
        normalized.includes("repository.pullrequest") ||
        normalized.includes("no pull requests found for branch") ||
        normalized.includes("pull request not found"))) ||
    (command === "glab" &&
      (normalized.includes("merge request not found") ||
        normalized.includes("not found") ||
        normalized.includes("404"))) ||
    (command === "az" &&
      normalized.includes("pull request") &&
      (normalized.includes("not found") || normalized.includes("does not exist")))
  ) {
    return "not-found";
  }

  return "command-failed";
};

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    // T3o: `gh` gets the matched project's token merged over its env (t3o-34).
    const env = input.command === "gh" ? withGitenvTokenEnv(input.env, input.cwd) : input.env;
    const baseError = {
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      argumentCount: input.args.length,
    };

    const result = yield* processRunner
      .run({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(env !== undefined ? { env } : {}),
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        truncatedMarker: input.appendTruncationMarker ? OUTPUT_TRUNCATED_MARKER : "",
        timeoutBehavior: "error",
      })
      .pipe(
        Effect.mapError(
          Match.valueTags({
            ProcessSpawnError: (error) =>
              VcsProcessSpawnError.fromProcessSpawnError(baseError, error),
            ProcessOutputLimitError: (error) =>
              new VcsProcessOutputLimitError({
                ...baseError,
                stream: error.stream,
                maxBytes: error.maxBytes,
                observedBytes: error.observedBytes,
              }),
            ProcessTimeoutError: (error) =>
              VcsProcessTimeoutError.fromProcessTimeoutError(baseError, error),
            ProcessStdinError: (error) =>
              new VcsProcessStdinWriteError({
                ...baseError,
                stdinBytes: error.stdinBytes,
                cause: error.cause,
              }),
            ProcessReadError: (error) =>
              new VcsProcessOutputReadError({
                ...baseError,
                stream: error.stream,
                cause: error.cause,
              }),
          }),
        ),
      );

    if (result.code === null) {
      return yield* new VcsProcessMissingExitCodeError(baseError);
    }

    if (!input.allowNonZeroExit && result.code !== 0) {
      return yield* VcsProcessExitError.fromProcessExit(
        baseError,
        {
          exitCode: result.code,
          stderr: result.stderr,
          stderrTruncated: result.stderrTruncated,
        },
        classifyNonZeroExit(input.command, result.stderr),
      );
    }

    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutInvalidUtf8: result.stdoutInvalidUtf8 ?? false,
      stderrInvalidUtf8: result.stderrInvalidUtf8 ?? false,
    } satisfies VcsProcessOutput;
  });

  return VcsProcess.of({ run });
});

export const layer = Layer.effect(VcsProcess, make).pipe(Layer.provide(ProcessRunner.layer));

/** How much process output is worth keeping once it is destined for a durable
    event log and a card in the UI. Long enough for a real forge refusal,
    short enough that a runaway stack trace cannot bloat the log. */
const SAFE_OUTPUT_MAX_LENGTH = 400;

/**
 * Make a process's own output safe to persist and show to a user.
 *
 * `VcsProcessExitError` deliberately drops stderr, because a git or forge
 * process can print a remote URL with an embedded credential
 * (`https://user:token@host/...`), a token in an error body, or a raw carriage
 * return that would corrupt a rendered line. Anything that deliberately keeps
 * that output — the merge refusal the card shows, the branch-cleanup summary
 * on the activity rail — has to do this scrubbing itself, because it is
 * writing to an EVENT LOG that is never rewritten and to a UI a person reads.
 *
 * Not the same job as `transportSafeSourceControlErrorValue`: that one parses
 * the whole value AS a URL and strips its credentials, which is right for an
 * identifier field and does nothing at all for a credential embedded in a
 * sentence — the parse simply throws and the string passes through untouched.
 * This works on free text.
 */
export function safeProcessOutput(raw: string): string {
  const collapsed = [...raw]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();

  // `scheme://user:secret@host` → `scheme://***@host`, anywhere in the text.
  // Also covers the userinfo-without-password form, which is still an identity
  // worth not persisting.
  const withoutUrlCredentials = collapsed.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu,
    "$1***@",
  );

  // Bare tokens that never belong in a log line, matched by their published
  // prefixes rather than by shape, so ordinary words are never mangled.
  const withoutBareTokens = withoutUrlCredentials.replace(
    /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/gu,
    "***",
  );

  // T3o: also drop the exact gitenv-configured token values, whatever their
  // shape — the prefix patterns above only know published formats (t3o-34).
  const withoutGitenvTokens = scrubGitenvTokens(withoutBareTokens);

  return withoutGitenvTokens.length > SAFE_OUTPUT_MAX_LENGTH
    ? `${withoutGitenvTokens.slice(0, SAFE_OUTPUT_MAX_LENGTH)}…`
    : withoutGitenvTokens;
}
