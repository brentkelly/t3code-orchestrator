/**
 * The board's narrow window onto the forge, so the supervisor never depends on
 * `GitManager` / `PullRequestService` whole. Errors flatten to the forge's own
 * words, because the card shows them to the user.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  ProjectId,
  PullRequestMergeMethod,
  PullRequestSummary,
  VcsStatusChangeRequest,
} from "@t3tools/contracts";

import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { boardMergeStateOf, type BoardMergeState } from "./boardMergeState.ts";
import { boardRepositoryOf, type BoardRepository } from "./boardRepository.ts";
import { BoardGitStatus } from "./ports/BoardGitStatus.ts";
import { ThreadGateway } from "./ThreadGateway.ts";

/**
 * Where a refused merge was refused: `host` (the host said no; probe `mergeState`),
 * `blocked` (refused before the host was asked; no retry helps), or `unavailable`
 * (CLI missing, unauthenticated or rate limited; a retry may work). Only `host` is
 * worth a merge-state probe: otherwise the pull request was never the problem.
 */
export type BoardPullRequestRefusal = "host" | "blocked" | "unavailable";

export class BoardPullRequestGatewayError extends Schema.TaggedError<BoardPullRequestGatewayError>()(
  "BoardPullRequestGatewayError",
  {
    operation: Schema.String,
    /** The forge's own explanation where there is one — a failing status check,
        a missing approval, an unmergeable branch. Shown verbatim on the card,
        so the user reads the host's reason rather than a paraphrase of it. */
    detail: Schema.String,
    /** T3o (T3O-47): set by `merge`, which is the only caller whose next move
        depends on it. Absent on a read, where there is nothing to decide. */
    refusal: Schema.optional(Schema.Literals(["host", "blocked", "unavailable"])),
  },
) {
  override get message(): string {
    return `Board pull-request operation '${this.operation}' failed: ${this.detail}`;
  }
}

const isProviderError = Schema.is(PullRequestProviderError);

/**
 * `PullRequestOperationError` covers both upstream's pre-flight refusal and the
 * host's, so its `cause` separates them: a provider error is the host's answer,
 * unless it is `rate-limited`, which never reached the host.
 */
function refusalOf(error: unknown): BoardPullRequestRefusal {
  if (typeof error !== "object" || error === null) return "unavailable";
  const tag = (error as { readonly _tag?: unknown })._tag;
  // Already classified: the pull request could not even be addressed, which
  // `repositoryOf` decides before any of this.
  if (tag === "BoardPullRequestGatewayError") {
    return (error as BoardPullRequestGatewayError).refusal ?? "unavailable";
  }
  if (tag === "PullRequestUnavailableError") return "unavailable";
  if (tag !== "PullRequestOperationError") return "unavailable";
  const cause = (error as { readonly cause?: unknown }).cause;
  if (!isProviderError(cause)) return "blocked";
  return cause.reason === "failed" ? "host" : "unavailable";
}

/** Pull the most specific human-readable text out of an unknown failure.
    Provider errors carry `detail`; everything else has at least a message. */
function failureDetail(error: unknown): string {
  for (const key of ["detail", "message"] as const) {
    if (typeof error === "object" && error !== null && key in error) {
      const value = String((error as Record<string, unknown>)[key] ?? "").trim();
      if (value.length > 0) return value;
    }
  }
  return "The forge did not say why.";
}

/**
 * A draft title with its `WIP:` / `[WIP]` marker taken off (T3O-12) — how
 * Forgejo and Gitea mark a pull request ready, since neither has a ready
 * action. Null when nothing would be left of the title, which no host takes.
 * A title without the marker comes back unchanged.
 */
export function boardTitleWithoutWipPrefix(title: string): string | null {
  const stripped = title.replace(/^\s*(?:\[WIP\]|WIP:)\s*/i, "");
  if (stripped === title) return title;
  const trimmed = stripped.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** A pull request as the board addresses it. `repository` is resolved here
    rather than carried on the card: it is the project's `origin` remote
    (T3O-24, see `boardRepository.ts`), and a card that predates the field
    would otherwise be unmergeable. */
export interface BoardPullRequestRef {
  readonly projectId: ProjectId;
  readonly number: number;
}

function vcsStatusOf(summary: PullRequestSummary): BoardFoundPullRequest {
  return {
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRef: summary.baseBranch,
    headRef: summary.headBranch,
    state: summary.state,
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    ...(summary.updatedAt !== undefined ? { updatedAt: summary.updatedAt } : {}),
    ...(summary.mergedAt !== undefined ? { mergedAt: summary.mergedAt } : {}),
    ...(summary.closedAt !== undefined ? { closedAt: summary.closedAt } : {}),
  };
}

/**
 * A pull request as the board reads it: the VCS status shape, plus when it
 * merged or closed (T3O-24) — what tells a pull request this card opened from
 * one an earlier card left on the same branch name. Absent where the host
 * does not report it.
 */
export type BoardFoundPullRequest = VcsStatusChangeRequest & {
  readonly mergedAt?: string | null;
  readonly closedAt?: string | null;
};

export class BoardPullRequestGateway extends Context.Service<
  BoardPullRequestGateway,
  {
    /**
     * The pull request open on `branch`, or null when there is none. A failure
     * is an error, not a null, so a transient blip never blanks a card's link.
     */
    readonly find: (input: {
      readonly cwd: string;
      readonly branch: string;
      /** Skip the lookup cache and its failure backoff and ask the forge now:
       * a human's "Check again" questions the very answer the cache holds. */
      readonly force?: boolean;
    }) => Effect.Effect<BoardFoundPullRequest | null, BoardPullRequestGatewayError>;
    /**
     * The pull request with this number on the board's repository, independent
     * of a branch Done may have deleted. Failures are errors (no null answer).
     * Never served from `lastGoodSummary`, which can say "open" after a merge.
     */
    readonly get: (
      input: BoardPullRequestRef & { readonly force?: boolean },
    ) => Effect.Effect<BoardFoundPullRequest, BoardPullRequestGatewayError>;
    /**
     * Merge it, with the strategy the merge stage is configured for.
     *
     * A failure always carries `refusal`, because "the host refused this
     * merge" and "this merge was never put to the host" need opposite
     * responses from the caller — see `BoardPullRequestRefusal`.
     */
    readonly merge: (
      input: BoardPullRequestRef & { readonly method: PullRequestMergeMethod },
    ) => Effect.Effect<void, BoardPullRequestGatewayError>;
    /**
     * Why the forge refused, asked only after a refusal. A failure is read by
     * the caller as "unclassifiable" and retried, which is the plain ladder a
     * host without credentials is meant to get.
     */
    readonly mergeState: (
      input: BoardPullRequestRef,
    ) => Effect.Effect<BoardMergeState, BoardPullRequestGatewayError>;
    /**
     * Idempotent: reads the forge live and acts only on an open draft, else
     * `not-draft` with no write. A host without a `ready` action (Forgejo,
     * Gitea) marks drafts with a `WIP:` / `[WIP]` title prefix, which is removed.
     */
    readonly markReady: (
      input: BoardPullRequestRef,
    ) => Effect.Effect<"readied" | "not-draft", BoardPullRequestGatewayError>;
    /**
     * Close an open pull request without merging it (T3O-28) — archiving a
     * group, or cancelling a started card's work. Reads the forge LIVE first
     * and acts only on an open one, so it is idempotent: a pull request that
     * is already closed or merged comes back `not-open` with no write.
     */
    readonly close: (
      input: BoardPullRequestRef,
    ) => Effect.Effect<"closed" | "not-open", BoardPullRequestGatewayError>;
    /**
     * The repository the board's pull requests live on (T3O-24): the
     * project's `origin`, falling back to its identity. Null when the project
     * has neither. Every other operation here addresses this one, so a pull
     * request linked to a card is checked against it too.
     */
    readonly repository: (
      projectId: ProjectId,
    ) => Effect.Effect<BoardRepository | null, BoardPullRequestGatewayError>;
  }
>()("t3/board/BoardPullRequestGateway") {}

/**
 * Annotated, not inferred: un-annotated, this layer pushes the server's layer
 * graph past TypeScript's inference budget and the composition degrades to `any`.
 */
export const layer: Layer.Layer<
  BoardPullRequestGateway,
  never,
  BoardGitStatus | GitVcsDriver.GitVcsDriver | PullRequestService.PullRequestService | ThreadGateway
> = Layer.effect(
  BoardPullRequestGateway,
  Effect.gen(function* () {
    const gitManager = yield* BoardGitStatus;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const threads = yield* ThreadGateway;

    const fail = (operation: string) => (error: unknown) =>
      Effect.fail(new BoardPullRequestGatewayError({ operation, detail: failureDetail(error) }));

    /**
     * The project's `origin`, host-qualified when it is not the project
     * identity's own repository (see `boardRepository.ts`).
     */
    const repository = (projectId: ProjectId, operation = "repository") =>
      threads.project(projectId).pipe(
        Effect.catch(fail(operation)),
        Effect.flatMap((project) => {
          if (project === null) return Effect.succeed(null);
          return git.readConfigValue(project.workspaceRoot, "remote.origin.url").pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((originUrl) => boardRepositoryOf(project.repositoryIdentity, originUrl)),
          );
        }),
      );

    const repositoryOf = (
      operation: string,
      projectId: ProjectId,
      refusal?: BoardPullRequestRefusal,
    ) =>
      repository(projectId, operation).pipe(
        Effect.filterOrFail(
          (repository): repository is BoardRepository => repository !== null,
          () =>
            new BoardPullRequestGatewayError({
              operation,
              detail: "This project has no recognised source-control remote.",
              ...(refusal === undefined ? {} : { refusal }),
            }),
        ),
      );

    /** The `PullRequestService` reference fields for a board repository. */
    const addressOf = ({ repository, host }: BoardRepository) =>
      host === undefined ? { repository } : { repository, host };

    const markReady = (input: BoardPullRequestRef) =>
      repositoryOf("markReady", input.projectId, "blocked").pipe(
        Effect.flatMap((repository) => {
          const reference = {
            projectId: input.projectId,
            ...addressOf(repository),
            number: input.number,
            allowStale: false,
          } as const;
          return pullRequests.invalidate({ reference }).pipe(
            Effect.andThen(pullRequests.detail(reference)),
            Effect.flatMap((detail): Effect.Effect<"readied" | "not-draft", unknown> => {
              if (detail.state !== "open" || !detail.isDraft) return Effect.succeed("not-draft");
              if (detail.capabilities.actions.includes("ready")) {
                return pullRequests
                  .runAction({ ...reference, action: "ready" })
                  .pipe(Effect.as("readied" as const));
              }
              const title = boardTitleWithoutWipPrefix(detail.title);
              if (title === null || title === detail.title) {
                return Effect.fail(
                  new BoardPullRequestGatewayError({
                    operation: "markReady",
                    detail: "This host cannot mark a draft pull request ready for review.",
                    refusal: "blocked",
                  }),
                );
              }
              return pullRequests
                .update({ ...reference, title })
                .pipe(Effect.as("readied" as const));
            }),
          );
        }),
        Effect.mapError(
          (error) =>
            new BoardPullRequestGatewayError({
              operation: "markReady",
              detail: failureDetail(error),
              refusal: refusalOf(error),
            }),
        ),
      );

    const close = (input: BoardPullRequestRef) =>
      repositoryOf("close", input.projectId, "blocked").pipe(
        Effect.flatMap((repository) => {
          const reference = {
            projectId: input.projectId,
            ...addressOf(repository),
            number: input.number,
            allowStale: false,
          } as const;
          return pullRequests.invalidate({ reference }).pipe(
            Effect.andThen(pullRequests.summary(reference)),
            Effect.flatMap((summary): Effect.Effect<"closed" | "not-open", unknown> =>
              summary.state !== "open"
                ? Effect.succeed("not-open")
                : pullRequests
                    .runAction({ ...reference, action: "close" })
                    .pipe(Effect.as("closed" as const)),
            ),
          );
        }),
        Effect.mapError(
          (error) =>
            new BoardPullRequestGatewayError({
              operation: "close",
              detail: failureDetail(error),
              refusal: refusalOf(error),
            }),
        ),
      );

    return BoardPullRequestGateway.of({
      repository: Effect.fn("BoardPullRequestGateway.repository")((projectId) =>
        repository(projectId),
      ),
      markReady,
      close,
      find: Effect.fn("BoardPullRequestGateway.find")((input) =>
        // The epoch is part of the cache key, so bumping it bypasses both the
        // lookup TTL and the failure backoff. `{ refresh: true }` applies to
        // successful answers only and would re-serve a cached lookup error.
        (input.force === true ? gitManager.invalidateStatus(input.cwd) : Effect.void).pipe(
          Effect.andThen(gitManager.branchPullRequest({ cwd: input.cwd, branch: input.branch })),
          Effect.catch(fail("find")),
        ),
      ),
      get: Effect.fn("BoardPullRequestGateway.get")((input) =>
        repositoryOf("get", input.projectId).pipe(
          Effect.flatMap((repository) => {
            const reference = {
              projectId: input.projectId,
              ...addressOf(repository),
              number: input.number,
              allowStale: false,
            } as const;
            const load =
              input.force === true
                ? pullRequests
                    .invalidate({ reference })
                    .pipe(Effect.andThen(pullRequests.summary(reference)))
                : pullRequests.summary(reference);
            return load.pipe(Effect.map(vcsStatusOf));
          }),
          Effect.catch(fail("get")),
        ),
      ),
      merge: Effect.fn("BoardPullRequestGateway.merge")((input) =>
        repositoryOf("merge", input.projectId, "blocked").pipe(
          Effect.flatMap((repository) =>
            pullRequests.runAction({
              projectId: input.projectId,
              ...addressOf(repository),
              number: input.number,
              action: "merge",
              mergeMethod: input.method,
            }),
          ),
          Effect.mapError(
            (error) =>
              new BoardPullRequestGatewayError({
                operation: "merge",
                detail: failureDetail(error),
                refusal: refusalOf(error),
              }),
          ),
        ),
      ),
      mergeState: Effect.fn("BoardPullRequestGateway.mergeState")((input) =>
        repositoryOf("mergeState", input.projectId).pipe(
          Effect.flatMap((repository) => {
            const reference = {
              projectId: input.projectId,
              ...addressOf(repository),
              number: input.number,
              // `runAction` leaves the detail cache alone when the merge fails,
              // so without both of these the probe could read pre-merge state.
              allowStale: false,
            } as const;
            return pullRequests
              .invalidate({ reference })
              .pipe(Effect.andThen(pullRequests.detail(reference)));
          }),
          Effect.map(boardMergeStateOf),
          Effect.catch(fail("mergeState")),
        ),
      ),
    });
  }),
);
