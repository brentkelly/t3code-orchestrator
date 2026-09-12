import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as DateTime from "effect/DateTime";

import {
  NonNegativeInt,
  type ChangeRequestChecks,
  type ChangeRequestMergeState,
  type ChangeRequestMergeStrategy,
  type VcsError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
// T3o: the structured refusal probe (T3O-38, D7).
import {
  forgejoMergeState,
  parseForgejoChecks,
  parseForgejoPullRequestMergeability,
} from "./forgejoMergeState.ts";
import {
  decodeForgejoPullRequestJson,
  decodeForgejoPullRequestListJson,
} from "./forgejoPullRequests.ts";
import { parseForgejoRemoteUrl, type ForgejoRemote } from "./forgejoRemote.ts";
import { parseForgejoRepositoryView, type ForgejoRepositoryView } from "./forgejoRepositoryView.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `fgj pr list` has no `--limit`, no head filter and no pagination, so a repository's whole
 * history comes back at roughly 10 KB per change request. A generous ceiling keeps a busy
 * repository readable; past it the output is refused rather than handed to the JSON decoder,
 * because a truncated body would fail to parse and read as "no change request found" — a blank
 * badge on a card that has one.
 */
const LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// T3o (T3O-38, D7): how many recent workflow runs the refusal probe reads.
// The listing is repository-wide and filtered by head sha here, so the limit
// only has to cover "the runs for the branch we are about to merge"; twenty is
// several pushes' worth and keeps the call small.
const ACTIONS_RUN_LIST_LIMIT = 20;

/** No check evidence at all — what the probe reports when the run listing
    could not be read. Paired with `checksReadable: false`, which is what keeps
    it from being classified as "all green and still refused". */
const EMPTY_FORGEJO_CHECKS: ChangeRequestChecks = {
  total: 0,
  passed: 0,
  pending: 0,
  failed: 0,
  failing: [],
  running: [],
};

/**
 * `fgj pr create` has no `--body-file`, so the body travels as one argv entry — and Linux caps a
 * single entry at 128 KiB (`MAX_ARG_STRLEN`). Past that the spawn fails with `E2BIG`, which reads
 * as "`fgj` is not on PATH" by the time it reaches the error mapping. The margin leaves room for
 * the rest of the command line.
 */
const MAX_BODY_BYTES = 120 * 1024;

const forgejoCliExecutionErrorContext = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal("fgj"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

const forgejoCliDecodeErrorContext = {
  command: Schema.Literal("fgj"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

export class ForgejoCliUnavailableError extends Schema.TaggedErrorClass<ForgejoCliUnavailableError>()(
  "ForgejoCliUnavailableError",
  forgejoCliExecutionErrorContext,
) {
  get detail(): string {
    return "Forgejo CLI (`fgj`) is required but not available on PATH.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoCliAuthenticationError extends Schema.TaggedErrorClass<ForgejoCliAuthenticationError>()(
  "ForgejoCliAuthenticationError",
  forgejoCliExecutionErrorContext,
) {
  get detail(): string {
    return "Forgejo CLI is not authenticated for this host. Run `fgj auth login` and retry.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoCliRateLimitError extends Schema.TaggedErrorClass<ForgejoCliRateLimitError>()(
  "ForgejoCliRateLimitError",
  forgejoCliExecutionErrorContext,
) {
  get detail(): string {
    return "Forgejo API rate limit exceeded.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoPullRequestNotFoundError extends Schema.TaggedErrorClass<ForgejoPullRequestNotFoundError>()(
  "ForgejoPullRequestNotFoundError",
  {
    ...forgejoCliExecutionErrorContext,
    reference: Schema.String,
  },
) {
  get detail(): string {
    return `Pull request ${this.reference} was not found. Check the PR number or URL and try again.`;
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "fgj";
      readonly cwd: string;
      readonly reference: string;
    },
    error: VcsError,
  ): ForgejoCliError {
    if (error._tag === "VcsProcessExitError" && error.failureKind === "not-found") {
      return new ForgejoPullRequestNotFoundError({ ...context, cause: error });
    }

    return ForgejoCliCommandError.fromVcsError(
      { operation: context.operation, command: context.command, cwd: context.cwd },
      error,
    );
  }
}

export class ForgejoCliCommandError extends Schema.TaggedErrorClass<ForgejoCliCommandError>()(
  "ForgejoCliCommandError",
  forgejoCliExecutionErrorContext,
) {
  get detail(): string {
    return "Forgejo CLI command failed.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "fgj";
      readonly cwd: string;
    },
    error: VcsError,
  ): ForgejoCliError {
    return Match.valueTags(error, {
      VcsProcessSpawnError: (cause) => new ForgejoCliUnavailableError({ ...context, cause }),
      VcsProcessExitError: (cause) => {
        switch (cause.failureKind) {
          case "authentication":
            return new ForgejoCliAuthenticationError({ ...context, cause });
          case "rate-limited":
            return new ForgejoCliRateLimitError({ ...context, cause });
          case "not-found":
          case "command-failed":
          case undefined:
            return new ForgejoCliCommandError({ ...context, cause });
        }
      },
      VcsProcessTimeoutError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsProcessStdinWriteError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsProcessOutputReadError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsProcessOutputLimitError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsProcessMissingExitCodeError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsRepositoryDetectionError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
      VcsUnsupportedOperationError: (cause) => new ForgejoCliCommandError({ ...context, cause }),
    });
  }
}

/**
 * No Forgejo remote to address. `fgj` would otherwise fall back to its own inference, which
 * fails inside a linked git worktree and defaults to codeberg.org outside one — both of which
 * report a confusing error about a host nobody asked for.
 */
export class ForgejoRemoteContextError extends Schema.TaggedErrorClass<ForgejoRemoteContextError>()(
  "ForgejoRemoteContextError",
  {
    command: Schema.Literal("fgj"),
    cwd: Schema.String,
    remoteUrl: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return "No Forgejo remote was found for this repository, so there is no owner/name and host to address.";
  }

  override get message(): string {
    return `Forgejo CLI failed in resolveRemote: ${this.detail}`;
  }
}

/**
 * The list came back cut short. Raised instead of decoding, so the caller sees a repository too
 * large to list rather than an empty result that looks like "no pull request for this branch".
 */
export class ForgejoOutputTruncatedError extends Schema.TaggedErrorClass<ForgejoOutputTruncatedError>()(
  "ForgejoOutputTruncatedError",
  {
    operation: Schema.Literal("listPullRequests"),
    command: Schema.Literal("fgj"),
    cwd: Schema.String,
    maxOutputBytes: NonNegativeInt,
  },
) {
  get detail(): string {
    return "Forgejo returned more pull request data than can be read at once. `fgj` cannot limit or paginate `pr list`.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoPullRequestListDecodeError extends Schema.TaggedErrorClass<ForgejoPullRequestListDecodeError>()(
  "ForgejoPullRequestListDecodeError",
  {
    ...forgejoCliDecodeErrorContext,
    operation: Schema.Literal("listPullRequests"),
  },
) {
  get detail(): string {
    return "Forgejo CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoPullRequestDecodeError extends Schema.TaggedErrorClass<ForgejoPullRequestDecodeError>()(
  "ForgejoPullRequestDecodeError",
  {
    ...forgejoCliDecodeErrorContext,
    operation: Schema.Literal("getPullRequest"),
    reference: Schema.String,
  },
) {
  get detail(): string {
    return "Forgejo CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoRepositoryDecodeError extends Schema.TaggedErrorClass<ForgejoRepositoryDecodeError>()(
  "ForgejoRepositoryDecodeError",
  {
    command: Schema.Literal("fgj"),
    cwd: Schema.String,
    operation: Schema.Literals(["getRepositoryCloneUrls", "getDefaultBranch"]),
    repository: Schema.String,
    missingField: Schema.String,
  },
) {
  get detail(): string {
    return `Forgejo CLI did not report ${this.missingField} for ${this.repository}.`;
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * `fgj pr merge` said it merged and the host says otherwise.
 *
 * `fgj` v0.4.0 prints "Pull request #N merged successfully" and exits 0 without reading what the
 * API answered — verified live against a closed-unmerged pull request and against one that does
 * not exist. So the merge is not believed on its word: the change request is read back, and this
 * is what a card sees when the merge did not happen.
 */
export class ForgejoMergeNotAppliedError extends Schema.TaggedErrorClass<ForgejoMergeNotAppliedError>()(
  "ForgejoMergeNotAppliedError",
  {
    operation: Schema.Literal("mergePullRequest"),
    command: Schema.Literal("fgj"),
    cwd: Schema.String,
    reference: Schema.String,
    state: Schema.Literals(["open", "closed", "merged"]),
  },
) {
  get detail(): string {
    return `Forgejo did not merge pull request ${this.reference}; it is still ${this.state}. Open it on the host to see what it is waiting on.`;
  }

  override get message(): string {
    return `Forgejo CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class ForgejoPullRequestBodyReadError extends Schema.TaggedErrorClass<ForgejoPullRequestBodyReadError>()(
  "ForgejoPullRequestBodyReadError",
  {
    command: Schema.Literal("fgj"),
    cwd: Schema.String,
    bodyFile: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to read the pull request body file.";
  }

  override get message(): string {
    return `Forgejo CLI failed in createPullRequest: ${this.detail}`;
  }
}

export class ForgejoPullRequestBodyTooLargeError extends Schema.TaggedErrorClass<ForgejoPullRequestBodyTooLargeError>()(
  "ForgejoPullRequestBodyTooLargeError",
  {
    command: Schema.Literal("fgj"),
    cwd: Schema.String,
    bodyBytes: NonNegativeInt,
    maxBodyBytes: NonNegativeInt,
  },
) {
  get detail(): string {
    return `The pull request body is ${this.bodyBytes} bytes, over the ${this.maxBodyBytes} \`fgj\` can take. \`fgj pr create\` has no --body-file, so the body must fit on the command line.`;
  }

  override get message(): string {
    return `Forgejo CLI failed in createPullRequest: ${this.detail}`;
  }
}

export class ForgejoCheckoutError extends Schema.TaggedErrorClass<ForgejoCheckoutError>()(
  "ForgejoCheckoutError",
  {
    command: Schema.Literal("fgj"),
    cwd: Schema.String,
    reference: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to check out the pull request branch.";
  }

  override get message(): string {
    return `Forgejo CLI failed in checkoutPullRequest: ${this.detail}`;
  }
}

export const ForgejoCliError = Schema.Union([
  ForgejoCliUnavailableError,
  ForgejoCliAuthenticationError,
  ForgejoCliRateLimitError,
  ForgejoPullRequestNotFoundError,
  ForgejoCliCommandError,
  ForgejoRemoteContextError,
  ForgejoOutputTruncatedError,
  ForgejoPullRequestListDecodeError,
  ForgejoPullRequestDecodeError,
  ForgejoRepositoryDecodeError,
  ForgejoMergeNotAppliedError,
  ForgejoPullRequestBodyReadError,
  ForgejoPullRequestBodyTooLargeError,
  ForgejoCheckoutError,
]);
export type ForgejoCliError = typeof ForgejoCliError.Type;
export const isForgejoCliError = Schema.is(ForgejoCliError);

export interface ForgejoPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt?: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface ForgejoRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

type ForgejoContext = SourceControlProvider.SourceControlProviderContext | undefined;

export class ForgejoCli extends Context.Service<
  ForgejoCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, ForgejoCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly context?: ForgejoContext;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<ForgejoPullRequestSummary>, ForgejoCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly context?: ForgejoContext;
      readonly reference: string;
    }) => Effect.Effect<ForgejoPullRequestSummary, ForgejoCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly context?: ForgejoContext;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, ForgejoCliError>;

    readonly mergePullRequest: (input: {
      readonly cwd: string;
      readonly context?: ForgejoContext;
      readonly reference: string;
      readonly strategy: ChangeRequestMergeStrategy;
    }) => Effect.Effect<void, ForgejoCliError>;

    /** T3o: the structured refusal probe (T3O-38, D7). */
    readonly pullRequestMergeState: (input: {
      readonly cwd: string;
      readonly context?: ForgejoContext;
      readonly reference: string;
    }) => Effect.Effect<ChangeRequestMergeState, ForgejoCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: ForgejoContext;
      readonly repository: string;
    }) => Effect.Effect<ForgejoRepositoryCloneUrls, ForgejoCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: ForgejoContext;
    }) => Effect.Effect<string | null, ForgejoCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly context?: ForgejoContext;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, ForgejoCliError>;
  }
>()("t3/sourceControl/ForgejoCli") {}

/** `#12`, `12`, or the URL Forgejo writes: `https://host/owner/name/pulls/12`. */
export function normalizeForgejoPullRequestReference(reference: string): string {
  const trimmed = reference.trim().replace(/^#/u, "");
  const urlMatch = /(?:pulls|pull)\/(\d+)(?:\D.*)?$/iu.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function forgejoStateArg(state: "open" | "closed" | "merged" | "all"): string {
  // `fgj pr list -s` knows open, closed and all only. Forgejo files a merged PR under `closed`
  // and marks it `merged`, so the merged filter is a closed listing narrowed after decoding.
  switch (state) {
    case "open":
      return "open";
    case "closed":
    case "merged":
      return "closed";
    case "all":
      return "all";
  }
}

function toSummaryWithOptionalUpdatedAt(
  record: {
    readonly updatedAt: Option.Option<DateTime.Utc>;
  } & Omit<ForgejoPullRequestSummary, "updatedAt">,
): ForgejoPullRequestSummary {
  const { updatedAt, ...summary } = record;
  return Option.isSome(updatedAt) ? { ...summary, updatedAt } : summary;
}

/**
 * The local branch a checked-out pull request lands on. A same-repository PR keeps its own head
 * branch name; a fork's branch is namespaced, because two forks can offer `main`.
 */
export function forgejoCheckoutBranchName(input: {
  readonly number: number;
  readonly headRefName: string;
  readonly isCrossRepository: boolean;
}): string {
  return input.isCrossRepository
    ? `t3code/pr-${input.number}/${sanitizeBranchFragment(input.headRefName)}`
    : input.headRefName;
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;

  /**
   * Both flags, always. `fgj` recognises only a `.git` directory, so inside a linked git worktree
   * — which is where every board card runs — it cannot find the repository or the host on its
   * own.
   */
  const requireRemote = (input: {
    readonly cwd: string;
    readonly context?: ForgejoContext;
  }): Effect.Effect<ForgejoRemote, ForgejoCliError> => {
    const remoteUrl = input.context?.remoteUrl;
    const remote = remoteUrl === undefined ? null : parseForgejoRemoteUrl(remoteUrl);
    return remote === null
      ? Effect.fail(
          new ForgejoRemoteContextError({
            command: "fgj",
            cwd: input.cwd,
            ...(remoteUrl === undefined
              ? {}
              : {
                  remoteUrl: SourceControlProvider.transportSafeSourceControlErrorValue(remoteUrl),
                }),
          }),
        )
      : Effect.succeed(remote);
  };

  const targetArgs = (remote: ForgejoRemote): ReadonlyArray<string> => [
    "-R",
    remote.nameWithOwner,
    "--hostname",
    remote.host,
  ];

  const run = (
    input: Parameters<ForgejoCli["Service"]["execute"]>[0],
    mapError: (error: VcsError) => ForgejoCliError,
  ) =>
    process
      .run({
        operation: "ForgejoCli.execute",
        command: "fgj",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      })
      .pipe(Effect.mapError(mapError));

  const execute: ForgejoCli["Service"]["execute"] = (input) =>
    run(input, (error) =>
      ForgejoCliCommandError.fromVcsError(
        { operation: "execute", command: "fgj", cwd: input.cwd },
        error,
      ),
    );

  const executePullRequest = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    run(input, (error) =>
      ForgejoPullRequestNotFoundError.fromVcsError(
        { operation: "execute", command: "fgj", cwd: input.cwd, reference: input.reference },
        error,
      ),
    );

  /**
   * `fgj repo view` is the odd one out: a positional `owner/name`, no `-R`, and no `--json`.
   * Without a host it falls back to `fgj`'s configured default, which is all a bare repository
   * lookup can offer.
   */
  const viewRepository = (input: {
    readonly cwd: string;
    readonly host: string | null;
    readonly repository: string;
  }): Effect.Effect<ForgejoRepositoryView, ForgejoCliError> =>
    execute({
      cwd: input.cwd,
      args: [
        "repo",
        "view",
        input.repository,
        ...(input.host === null ? [] : ["--hostname", input.host]),
      ],
    }).pipe(Effect.map((result) => parseForgejoRepositoryView(result.stdout)));

  const optionalRemote = (context: ForgejoContext): ForgejoRemote | null =>
    context?.remoteUrl === undefined ? null : parseForgejoRemoteUrl(context.remoteUrl);

  const getPullRequest: ForgejoCli["Service"]["getPullRequest"] = (input) =>
    Effect.gen(function* () {
      const remote = yield* requireRemote(input);
      const reference = normalizeForgejoPullRequestReference(input.reference);
      const result = yield* executePullRequest({
        cwd: input.cwd,
        reference,
        args: ["pr", "view", reference, "--json", ...targetArgs(remote)],
      });
      const decoded = decodeForgejoPullRequestJson(result.stdout.trim());
      if (!Result.isSuccess(decoded)) {
        return yield* new ForgejoPullRequestDecodeError({
          operation: "getPullRequest",
          command: "fgj",
          cwd: input.cwd,
          reference,
          cause: decoded.failure,
        });
      }
      return toSummaryWithOptionalUpdatedAt(decoded.success);
    });

  return ForgejoCli.of({
    execute,
    listPullRequests: (input) =>
      Effect.gen(function* () {
        const remote = yield* requireRemote(input);
        const result = yield* execute({
          cwd: input.cwd,
          args: ["pr", "list", "--json", "-s", forgejoStateArg(input.state), ...targetArgs(remote)],
          maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
        });

        if (result.stdoutTruncated) {
          return yield* new ForgejoOutputTruncatedError({
            operation: "listPullRequests",
            command: "fgj",
            cwd: input.cwd,
            maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
          });
        }

        const raw = result.stdout.trim();
        if (raw.length === 0) {
          return [];
        }

        const decoded = decodeForgejoPullRequestListJson(raw);
        if (!Result.isSuccess(decoded)) {
          return yield* new ForgejoPullRequestListDecodeError({
            operation: "listPullRequests",
            command: "fgj",
            cwd: input.cwd,
            cause: decoded.failure,
          });
        }

        // `fgj` filters by state alone, so the head branch, the merged/closed split and the
        // caller's limit are all applied here. That costs: `-s all`, which is what a branch's
        // status check asks for, transfers and decodes every pull request the repository has ever
        // had (~10 KB each), bounded only by the truncation guard above. `fgj pr list` offers no
        // head, limit or pagination flag, so the fix is a REST-backed provider, not a better call.
        const headRefName = SourceControlProvider.sourceBranch(input);
        const matches = decoded.success.filter(
          (record) =>
            record.headRefName === headRefName &&
            (input.state === "all" || input.state === record.state),
        );
        matches.sort((left, right) => right.number - left.number);
        return matches.slice(0, input.limit ?? matches.length).map(toSummaryWithOptionalUpdatedAt);
      }),
    getPullRequest,
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const remote = yield* requireRemote(input);
        // `fgj pr create` has no `--body-file`, so the body travels in argv. `VcsProcess` errors
        // carry only the argument count, never argv, so it cannot leak into a persisted error.
        const body = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoPullRequestBodyReadError({
                command: "fgj",
                cwd: input.cwd,
                bodyFile: input.bodyFile,
                cause,
              }),
          ),
        );
        const bodyBytes = Buffer.byteLength(body, "utf8");
        if (bodyBytes > MAX_BODY_BYTES) {
          return yield* new ForgejoPullRequestBodyTooLargeError({
            command: "fgj",
            cwd: input.cwd,
            bodyBytes,
            maxBodyBytes: MAX_BODY_BYTES,
          });
        }
        yield* execute({
          cwd: input.cwd,
          args: [
            "pr",
            "create",
            ...targetArgs(remote),
            "-B",
            input.target?.refName ?? input.baseBranch,
            "-H",
            SourceControlProvider.sourceBranch(input),
            "-t",
            input.title,
            "-b",
            body,
          ],
        });
      }),
    mergePullRequest: (input) =>
      Effect.gen(function* () {
        const remote = yield* requireRemote(input);
        const reference = normalizeForgejoPullRequestReference(input.reference);
        yield* executePullRequest({
          cwd: input.cwd,
          reference,
          args: ["pr", "merge", reference, "--merge-method", input.strategy, ...targetArgs(remote)],
        });

        // `fgj` reports success whatever the host answered, so the merge is confirmed rather than
        // taken on its word. A card moved to Done on a merge that did not happen is wrong in the
        // one direction that is hard to undo.
        const after = yield* getPullRequest({ ...input, reference });
        if (after.state !== "merged") {
          return yield* new ForgejoMergeNotAppliedError({
            operation: "mergePullRequest",
            command: "fgj",
            cwd: input.cwd,
            reference,
            state: after.state,
          });
        }
      }),
    // T3o: the structured refusal probe (T3O-38, D7). Two calls, because
    // Forgejo splits the answer: the pull request carries `mergeable` and its
    // head sha, the checks live with Forgejo Actions.
    pullRequestMergeState: (input) =>
      Effect.gen(function* () {
        const remote = yield* requireRemote(input);
        const reference = normalizeForgejoPullRequestReference(input.reference);
        const viewed = yield* executePullRequest({
          cwd: input.cwd,
          reference,
          args: ["pr", "view", reference, "--json", ...targetArgs(remote)],
        });
        const { mergeable, headSha } = parseForgejoPullRequestMergeability(viewed.stdout);

        // Best-effort, and the ONE place where "we could not look" must not
        // read as "there is nothing to wait for": an instance without Actions,
        // or an `fgj` whose listing we cannot parse, leaves the state
        // `unknown`, which retries. Claiming every check is green when we
        // never saw one would stop the ladder on the first refusal.
        const runs = yield* execute({
          cwd: input.cwd,
          args: [
            "actions",
            "run",
            "list",
            "--json",
            "-L",
            String(ACTIONS_RUN_LIST_LIMIT),
            ...targetArgs(remote),
          ],
          maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
        }).pipe(Effect.catchCause(() => Effect.succeed(null)));

        return forgejoMergeState({
          mergeable,
          headSha,
          checks: runs === null ? EMPTY_FORGEJO_CHECKS : parseForgejoChecks(runs.stdout, headSha),
          checksReadable: runs !== null,
        });
      }),
    getRepositoryCloneUrls: (input) =>
      viewRepository({
        cwd: input.cwd,
        host: optionalRemote(input.context)?.host ?? null,
        repository: input.repository,
      }).pipe(
        Effect.flatMap((view) => {
          const nameWithOwner = view.nameWithOwner ?? input.repository;
          const url = view.httpsCloneUrl ?? view.url;
          const sshUrl = view.sshCloneUrl;
          if (url === null || sshUrl === null) {
            return Effect.fail(
              new ForgejoRepositoryDecodeError({
                command: "fgj",
                cwd: input.cwd,
                operation: "getRepositoryCloneUrls",
                repository: input.repository,
                missingField: url === null ? "an HTTPS clone URL" : "an SSH clone URL",
              }),
            );
          }
          return Effect.succeed({ nameWithOwner, url, sshUrl });
        }),
      ),
    getDefaultBranch: (input) =>
      Effect.gen(function* () {
        const remote = yield* requireRemote(input);
        const view = yield* viewRepository({
          cwd: input.cwd,
          host: remote.host,
          repository: remote.nameWithOwner,
        });
        return view.defaultBranch;
      }),
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const pullRequest = yield* getPullRequest(input);
        // Forgejo publishes `refs/pull/<n>/head` exactly as GitHub does, which is the only way
        // in: `fgj` has no checkout subcommand.
        const localBranch = forgejoCheckoutBranchName({
          number: pullRequest.number,
          headRefName: pullRequest.headRefName,
          isCrossRepository: pullRequest.isCrossRepository === true,
        });
        const localBranchNames = yield* git.listLocalBranchNames(input.cwd);
        if (input.force === true || !localBranchNames.includes(localBranch)) {
          yield* git.fetchPullRequestBranch({
            cwd: input.cwd,
            prNumber: pullRequest.number,
            branch: localBranch,
          });
        }
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause) =>
          isForgejoCliError(cause)
            ? cause
            : new ForgejoCheckoutError({
                command: "fgj",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                cause,
              }),
        ),
      ),
  });
});

export const layer = Layer.effect(ForgejoCli, make);
