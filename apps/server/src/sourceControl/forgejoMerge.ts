/**
 * T3o: the board's two merge seams for Forgejo / Gitea (t3o-16, T3O-38).
 *
 * Upstream's `ForgejoSourceControlProvider` reads and opens pull requests; the
 * board also MERGES them (its Ready-for-merge stage) and, after a refusal, asks
 * why in machine-readable form. Both live here so the provider carries one
 * delegating line, and both are built on the provider-neutral surface upstream
 * already exposes — `ForgejoCli.api`, which speaks the REST API through
 * whichever of `fj` / `tea` owns the server's credentials. Nothing here shells
 * out to a CLI subcommand of its own.
 */
import { SourceControlProviderError, type ChangeRequestMergeStrategy } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ForgejoCli from "./ForgejoCli.ts";
import {
  forgejoMergeState,
  forgejoRefusalDetail,
  parseForgejoCommitStatuses,
  parseForgejoPullRequestMergeability,
  parseForgejoPullRequestMerged,
} from "./forgejoMergeState.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";

type Provider = SourceControlProvider.SourceControlProvider["Service"];

const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);

const NO_CHECKS = { total: 0, passed: 0, pending: 0, failed: 0, failing: [], running: [] };

/**
 * Gitea's `Do` values. `rebase` is the plain replay the abstraction names;
 * Gitea's `rebase-merge` (replay, then a merge commit) has no counterpart in
 * `ChangeRequestMergeStrategy` and is never sent.
 */
const MERGE_STYLE: Record<ChangeRequestMergeStrategy, string> = {
  squash: "squash",
  merge: "merge",
  rebase: "rebase",
};

/** `#12`, `12`, or the URL Forgejo writes: `https://host/owner/name/pulls/12`. */
export function forgejoPullRequestNumber(reference: string): string | null {
  return /(?:^#?|\/pulls?\/)(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/u.exec(reference.trim())?.[1] ?? null;
}

const repositoryPath = (repository: string) =>
  `repos/${repository.split("/").map(encodeURIComponent).join("/")}`;

export function makeForgejoMergeSeams(
  cli: ForgejoCli.ForgejoCli["Service"],
): Pick<Provider, "mergeChangeRequest" | "changeRequestMergeState"> {
  const fail = (
    operation: "mergeChangeRequest" | "changeRequestMergeState",
    input: { readonly cwd: string; readonly reference: string },
  ) =>
    Effect.mapError(
      (cause: ForgejoCli.ForgejoCliError) =>
        new SourceControlProviderError({
          provider: "forgejo",
          operation,
          cwd: input.cwd,
          command: cause.command,
          reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
          detail: SourceControlProvider.transportSafeSourceControlErrorValue(
            forgejoRefusalDetail(cause.detail, cause.httpStatus),
          ),
          cause,
        }),
    );

  /** The API path of the pull request a board reference names. */
  const pullPath = Effect.fn("forgejoMerge.pullPath")(function* (
    input:
      | Parameters<Provider["mergeChangeRequest"]>[0]
      | Parameters<Provider["changeRequestMergeState"]>[0],
  ) {
    const number = forgejoPullRequestNumber(input.reference);
    if (number === null) {
      return yield* new ForgejoCli.ForgejoCliError({
        command: "tea",
        cwd: input.cwd,
        detail: "Specify a pull request number or Forgejo pull request URL.",
      });
    }
    const repository = yield* cli.resolveRepository(input);
    const root = repositoryPath(repository.repository);
    return { root, pull: `${root}/pulls/${number}` };
  });

  return {
    mergeChangeRequest: (input) =>
      Effect.gen(function* () {
        const { pull } = yield* pullPath(input);
        yield* cli.api({
          ...input,
          path: `${pull}/merge`,
          method: "POST",
          body: { Do: MERGE_STYLE[input.strategy] },
        });

        // Confirmed rather than taken on the status line's word: a card moved
        // to Done on a merge that did not happen is wrong in the one direction
        // that is hard to undo.
        const after = yield* cli.api({ ...input, path: pull });
        if (!parseForgejoPullRequestMerged(after.stdout)) {
          return yield* new ForgejoCli.ForgejoCliError({
            command: "tea",
            cwd: input.cwd,
            detail: `Forgejo did not merge pull request ${input.reference}. Open it on the host to see what it is waiting on.`,
          });
        }
      }).pipe(fail("mergeChangeRequest", input)),

    changeRequestMergeState: (input) =>
      Effect.gen(function* () {
        const { root, pull } = yield* pullPath(input);
        const viewed = yield* cli.api({ ...input, path: pull });
        const { mergeable, headSha, behind } = parseForgejoPullRequestMergeability(viewed.stdout);

        // Best-effort, and the ONE place where "we could not look" must not
        // read as "there is nothing to wait for": a status read that fails, or
        // a body this build cannot parse, leaves the state `unknown`, which
        // retries. Claiming every check is green when we never saw one would
        // stop the ladder on the first refusal.
        const checks =
          headSha === null
            ? null
            : yield* cli
                .api({ ...input, path: `${root}/commits/${encodeURIComponent(headSha)}/status` })
                .pipe(
                  Effect.map((result) => parseForgejoCommitStatuses(result.stdout)),
                  Effect.catchIf(isForgejoCliError, () => Effect.succeed(null)),
                );

        return forgejoMergeState({
          mergeable,
          headSha,
          behind,
          checks: checks ?? NO_CHECKS,
          checksReadable: checks !== null,
        });
      }).pipe(fail("changeRequestMergeState", input)),
  };
}
