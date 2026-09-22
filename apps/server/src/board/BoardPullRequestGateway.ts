/**
 * The board's narrow window onto the forge: resolve a branch's pull request,
 * merge one, and ask why a merge was refused.
 *
 * Deliberately NOT a direct `GitManager` / `PullRequestService` dependency.
 * The board needs three operations out of two services that between them
 * expose stacked git actions, commit-message generation, listings, diffs,
 * reviews, labels and more; taking either whole would couple the supervisor
 * reactor's type graph to all of it, and would let any future board code reach
 * for forge operations the board has no business performing. Three methods,
 * one seam, and the reactor is testable against a stub instead of a real git
 * checkout.
 *
 * Since T3O-47 the merge and the refusal probe run on upstream's
 * `apps/server/src/pullRequest/` module rather than on a hand-rolled path
 * through `SourceControlProvider`. That is what lets the board merge on every
 * host upstream supports — GitHub, GitLab, Bitbucket, Azure DevOps and Forgejo
 * — instead of the two the fork had implemented, and it is why the fork owns
 * no merge code below this file any more.
 *
 * The error type is flattened to one shape carrying the forge's own words,
 * because that text is what the board actually does with a failure: shows it
 * to the user on the card.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import type { ProjectId, PullRequestMergeMethod, VcsStatusChangeRequest } from "@t3tools/contracts";

import * as GitManager from "../git/GitManager.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { boardMergeStateOf, type BoardMergeState } from "./boardMergeState.ts";

export class BoardPullRequestGatewayError extends Schema.TaggedError<BoardPullRequestGatewayError>()(
  "BoardPullRequestGatewayError",
  {
    operation: Schema.String,
    /** The forge's own explanation where there is one — a failing status check,
        a missing approval, an unmergeable branch. Shown verbatim on the card,
        so the user reads the host's reason rather than a paraphrase of it. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Board pull-request operation '${this.operation}' failed: ${this.detail}`;
  }
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

/** A pull request as the board addresses it. `repository` is resolved here
    rather than carried on the card: it is the project's own remote, which the
    read model already records, and a card that predates the field would
    otherwise be unmergeable. */
export interface BoardPullRequestRef {
  readonly projectId: ProjectId;
  readonly number: number;
}

export class BoardPullRequestGateway extends Context.Service<
  BoardPullRequestGateway,
  {
    /**
     * The pull request open on `branch`, or null when there is none.
     *
     * A FAILURE (rate limit, unauthenticated, network) is an error, not a
     * null: the caller must be able to tell "we looked and there is no PR"
     * from "we could not look", because recording the first over an existing
     * link would blank a card's badge on a transient blip.
     */
    readonly find: (input: {
      readonly cwd: string;
      readonly branch: string;
      /** T3o (T3O-48): skip the cache and ask the forge now.
       *
       * The lookup is cached per branch, with an exponential backoff on top
       * for a branch that keeps failing. That is right for the automatic
       * refresh, whose cost model depends on a burst of card opens costing one
       * forge call — and wrong for a human pressing "Check again", who has just
       * read "no pull request" and is asking whether it is still true. A button
       * answered out of the cache that produced the answer being questioned is
       * a button that does nothing. */
      readonly force?: boolean;
    }) => Effect.Effect<VcsStatusChangeRequest | null, BoardPullRequestGatewayError>;
    readonly merge: (
      input: BoardPullRequestRef & { readonly method: PullRequestMergeMethod },
    ) => Effect.Effect<void, BoardPullRequestGatewayError>;
    /**
     * Why the forge refused (T3O-38, D7) — asked only AFTER a refusal, so the
     * happy path stays one call.
     *
     * A FAILURE is an error rather than a null answer, and the caller reads
     * that error as "unclassifiable" and retries: on a host the workspace has
     * no credentials for this fails every time, which is exactly the plain
     * ladder those projects are meant to get.
     */
    readonly mergeState: (
      input: BoardPullRequestRef,
    ) => Effect.Effect<BoardMergeState, BoardPullRequestGatewayError>;
  }
>()("t3/board/BoardPullRequestGateway") {}

/**
 * Explicitly annotated rather than inferred. The server's layer graph is deep
 * enough that adding an un-annotated layer to it pushes TypeScript past its
 * inference budget, and the whole composition silently degrades to `any` —
 * which the Effect lint rules then flag across every file that touches the
 * runtime. Stating the type here cuts the inference chain at this layer.
 */
export const layer: Layer.Layer<
  BoardPullRequestGateway,
  never,
  | GitManager.GitManager
  | PullRequestService.PullRequestService
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
> = Layer.effect(
  BoardPullRequestGateway,
  Effect.gen(function* () {
    const gitManager = yield* GitManager.GitManager;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

    const fail = (operation: string) => (error: unknown) =>
      Effect.fail(new BoardPullRequestGatewayError({ operation, detail: failureDetail(error) }));

    /**
     * The `owner/repo` selector `PullRequestService` addresses a project by,
     * read from the same place the service reads its own: the project shell's
     * repository identity. A project whose remote was never resolved has no
     * pull requests to act on, and saying so names the reason.
     */
    const repositoryOf = (operation: string, projectId: ProjectId) =>
      projections.getProjectShellById(projectId).pipe(
        Effect.catch(fail(operation)),
        Effect.flatMap((project) => {
          const repository = sourceControlRepositorySelector(
            Option.getOrUndefined(project)?.repositoryIdentity,
          );
          return repository === null
            ? Effect.fail(
                new BoardPullRequestGatewayError({
                  operation,
                  detail: "This project has no recognised source-control remote.",
                }),
              )
            : Effect.succeed(repository);
        }),
      );

    return BoardPullRequestGateway.of({
      find: (input) =>
        // T3o (T3O-48): a forced lookup bumps this checkout's PR-lookup epoch,
        // which is part of the cache key — so it bypasses the lookup TTL and
        // the per-branch failure backoff together. `{ refresh: true }` alone is
        // not enough: upstream applies it to SUCCESSFUL answers only (see
        // `GitManager.branchPullRequest`, "keep failed lookups' retry
        // backoff"), so the very case the button exists for — a user who just
        // read a lookup error — would be re-served that cached error for up to
        // 15 minutes without a forge call.
        (input.force === true ? gitManager.invalidateStatus(input.cwd) : Effect.void).pipe(
          Effect.andThen(gitManager.branchPullRequest({ cwd: input.cwd, branch: input.branch })),
          Effect.catch(fail("find")),
        ),
      merge: (input) =>
        repositoryOf("merge", input.projectId).pipe(
          Effect.flatMap((repository) =>
            pullRequests.runAction({
              projectId: input.projectId,
              repository,
              number: input.number,
              action: "merge",
              mergeMethod: input.method,
            }),
          ),
          Effect.catch(fail("merge")),
        ),
      mergeState: (input) =>
        repositoryOf("mergeState", input.projectId).pipe(
          Effect.flatMap((repository) => {
            const reference = {
              projectId: input.projectId,
              repository,
              number: input.number,
              // The probe runs immediately after a refused merge, and it is the
              // refusal it has to explain. `runAction` leaves the in-process
              // detail cache alone when the action FAILED, so without both of
              // these the answer could be the state that was read before the
              // merge was even attempted.
              allowStale: false,
            } as const;
            return pullRequests
              .invalidate({ reference })
              .pipe(Effect.andThen(pullRequests.detail(reference)));
          }),
          Effect.map(boardMergeStateOf),
          Effect.catch(fail("mergeState")),
        ),
    });
  }),
);
