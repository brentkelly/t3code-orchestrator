import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as ForgejoCli from "./ForgejoCli.ts";
import {
  findAuthenticatedForgejoHost,
  isAuthenticatedForgejoHost,
  parseForgejoAuthStatusHosts,
} from "./forgejoAuthStatus.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlUnknownRemoteRefinementInput,
} from "./SourceControlProviderDiscovery.ts";

function toChangeRequest(summary: ForgejoCli.ForgejoPullRequestSummary): ChangeRequest {
  return {
    provider: "forgejo",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt ?? Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

/**
 * `fgj auth status` exits 0 either way and says everything in its body: one bullet per instance
 * it holds a token for, or a line saying there are none. So the parse decides, and a body it
 * cannot read is reported as unknown rather than as a failure.
 */
function parseForgejoAuth(input: SourceControlAuthProbeInput) {
  const output = combinedAuthOutput(input);
  const hosts = parseForgejoAuthStatusHosts(output);
  const authenticated = findAuthenticatedForgejoHost(hosts);

  if (authenticated) {
    return providerAuth({
      status: "authenticated",
      account: authenticated.account ?? undefined,
      host: authenticated.host,
    });
  }

  if (/not authenticated/iu.test(output)) {
    return providerAuth({
      status: "unauthenticated",
      detail: "Forgejo CLI is not authenticated. Run `fgj auth login` and retry.",
    });
  }

  return providerAuth({
    status: "unknown",
    detail: firstSafeAuthLine(output) ?? "Forgejo CLI auth status could not be parsed.",
  });
}

/**
 * A self-hosted Forgejo is usually named after the team that runs it, so its remote URL says
 * nothing. What does say something is `fgj` holding a token for that exact host — which is also
 * the only case where claiming the remote buys anything, since every operation needs that token.
 * A Forgejo you are not signed in to stays `unknown`, and nothing happens, which is the honest
 * answer.
 */
function refineUnknownForgejoRemote(input: SourceControlUnknownRemoteRefinementInput) {
  const host = input.context.provider.name.toLowerCase();
  const hosts = parseForgejoAuthStatusHosts(combinedAuthOutput(input.auth));

  if (!isAuthenticatedForgejoHost(hosts, host)) {
    return null;
  }

  return {
    kind: "forgejo",
    name: "Forgejo",
    baseUrl: input.context.provider.baseUrl,
  } as const;
}

export const discovery = {
  type: "cli",
  kind: "forgejo",
  label: "Forgejo",
  executable: "fgj",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: parseForgejoAuth,
  refineUnknownRemote: refineUnknownForgejoRemote,
  installHint:
    "Install the Forgejo command-line tool (`fgj`) from https://codeberg.org/romaintb/fgj, then run `fgj auth login`. Tested against fgj 0.4.0.",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const forgejo = yield* ForgejoCli.ForgejoCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "forgejo",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .listPullRequests({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      forgejo
        .getPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
        })
        .pipe(
          Effect.map(toChangeRequest),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "getChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .createPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          ...(input.target ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      forgejo
        .getRepositoryCloneUrls({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          repository: input.repository,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "getRepositoryCloneUrls",
                command: error.command,
                cwd: input.cwd,
                repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.repository,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
    // `fgj` has no repository-creation command, and the registry binds no provider context to
    // this operation, so there would be no host to create it on. Forgejo is absent from the
    // add-project and publish flows for the same reason.
    createRepository: (input) =>
      new SourceControlProviderError({
        provider: "forgejo",
        operation: "createRepository",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: "Creating a repository is not supported for Forgejo. Create it on the host first.",
      }),
    getDefaultBranch: (input) =>
      forgejo
        .getDefaultBranch({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "getDefaultBranch",
                command: error.command,
                cwd: input.cwd,
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
    // Unlike the other non-GitHub providers, merging is implemented here: `fgj pr merge
    // --merge-method` maps onto `ChangeRequestMergeStrategy` exactly, and one-click merge is the
    // point of the board's Ready-for-merge stage. A refusal by the forge — failing checks, a
    // missing approval, a conflict — comes back as its own words in `detail`, which is what the
    // card shows.
    mergeChangeRequest: (input) =>
      forgejo
        .mergePullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          strategy: input.strategy,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "mergeChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
    checkoutChangeRequest: (input) =>
      forgejo
        .checkoutPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "checkoutChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
