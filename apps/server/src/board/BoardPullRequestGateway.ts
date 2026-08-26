/**
 * The board's narrow window onto the forge: resolve a branch's pull request,
 * and merge one.
 *
 * Deliberately NOT a direct `GitManager` dependency. The board needs two
 * operations out of a service that exposes stacked git actions, commit-message
 * generation, PR-thread preparation and more; taking the whole thing would
 * couple the supervisor reactor's type graph to all of it, and would let any
 * future board code reach for git operations the board has no business
 * performing. Two methods, one seam, and the reactor is testable against a
 * stub instead of a real git checkout.
 *
 * The error type is flattened to one shape carrying the forge's own words,
 * because that text is what the board actually does with a failure: shows it
 * to the user on the card. Nothing downstream branches on the error's variant
 * — only on whether the detail reads like a merge conflict.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ChangeRequestMergeStrategy, VcsStatusChangeRequest } from "@t3tools/contracts";

import * as GitManager from "../git/GitManager.ts";

export class BoardPullRequestGatewayError extends Schema.TaggedErrorClass<BoardPullRequestGatewayError>()(
  "BoardPullRequestGatewayError",
  {
    operation: Schema.String,
    /** The forge's own explanation where there is one — a failing status check,
        a missing approval, an unmergeable branch. Shown verbatim on the card,
        so the user reads GitHub's reason rather than a paraphrase of it. */
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
    }) => Effect.Effect<VcsStatusChangeRequest | null, BoardPullRequestGatewayError>;
    readonly merge: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly strategy: ChangeRequestMergeStrategy;
    }) => Effect.Effect<void, BoardPullRequestGatewayError>;
  }
>()("t3/board/BoardPullRequestGateway") {}

/**
 * Explicitly annotated rather than inferred. The server's layer graph is deep
 * enough that adding an un-annotated layer to it pushes TypeScript past its
 * inference budget, and the whole composition silently degrades to `any` —
 * which the Effect lint rules then flag across every file that touches the
 * runtime. Stating the type here cuts the inference chain at this layer.
 */
export const layer: Layer.Layer<BoardPullRequestGateway, never, GitManager.GitManager> =
  Layer.effect(
    BoardPullRequestGateway,
    Effect.gen(function* () {
      const gitManager = yield* GitManager.GitManager;
      return BoardPullRequestGateway.of({
        find: (input) =>
          gitManager.findBranchPullRequest(input).pipe(
            Effect.catch((error: unknown) =>
              Effect.fail(
                new BoardPullRequestGatewayError({
                  operation: "find",
                  detail: failureDetail(error),
                }),
              ),
            ),
          ),
        merge: (input) =>
          gitManager.mergeBranchPullRequest(input).pipe(
            Effect.catch((error: unknown) =>
              Effect.fail(
                new BoardPullRequestGatewayError({
                  operation: "merge",
                  detail: failureDetail(error),
                }),
              ),
            ),
          ),
      });
    }),
  );
