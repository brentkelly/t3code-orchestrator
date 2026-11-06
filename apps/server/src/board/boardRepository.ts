/**
 * T3o (T3O-24): the repository the board's pull requests live on.
 *
 * Upstream's `RepositoryIdentityResolver` deliberately prefers a remote named
 * `upstream` over `origin`, which suits a contributor-style fork whose pull
 * requests are opened against upstream. The board is the other case. It
 * pushes `board/<key>` to `origin` and opens its pull requests there, so in a
 * fork such as T3o the project's identity names the wrong repository: Merge
 * would act on `pingdotgg/t3code#N`, and linking the fork's own pull request
 * was refused as "not in this card's repository".
 *
 * So the board addresses `origin`, the same default as a plain `git push`,
 * and leaves the project identity alone for everything else. A project with
 * no `origin` falls back to its identity, so a checkout with only some other
 * remote behaves exactly as before.
 *
 * Pure. The caller reads `remote.origin.url`.
 */
import { type RepositoryIdentity, SourceControlProviderKind } from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

const { canonicalRepositoryKey, changeRequestHost, recognizeRemote, repositorySelector } =
  sourceControlDefinitions;

export interface BoardRepository {
  /** The selector `PullRequestService` addresses a repository by — `owner/repo`. */
  readonly repository: string;
  /** Set only when the board's repository is not the project identity's.
      With it, `PullRequestService` acts on `repository` instead of refusing it
      as another project's; without it the reference stays byte-identical to
      what it was before this existed. */
  readonly host?: string;
  /** The repository's path below its host, lower case — for comparing a pull
      request URL against. */
  readonly path: string;
}

function pathBelowHost(canonicalKey: string): string | null {
  const canonical = canonicalRepositoryKey(canonicalKey.trim().toLowerCase());
  const separator = canonical.indexOf("/");
  return separator === -1 ? null : canonical.slice(separator + 1);
}

function fromIdentity(identity: RepositoryIdentity | null | undefined): BoardRepository | null {
  const repository = repositorySelector(identity);
  const path = identity ? pathBelowHost(identity.canonicalKey) : null;
  return repository === null || path === null ? null : { repository, path };
}

/**
 * The board's repository: `origin` when the project has one, else the
 * project identity. Null when neither names a repository.
 */
export function boardRepositoryOf(
  identity: RepositoryIdentity | null | undefined,
  originUrl: string | null,
): BoardRepository | null {
  const own = fromIdentity(identity);
  const url = originUrl?.trim() ?? "";
  if (url.length === 0) return own;
  const canonicalKey = normalizeGitRemoteUrl(url);
  const originKey = canonicalRepositoryKey(canonicalKey);
  // The identity already IS origin — every project without an `upstream`
  // remote. Nothing to redirect.
  if (identity && canonicalRepositoryKey(identity.canonicalKey.toLowerCase()) === originKey) {
    return own;
  }
  const originHost = originKey.split("/")[0] ?? "";
  const identityHost = identity?.canonicalKey.toLowerCase().split("/")[0];
  // Same host: the identity's provider kind is the refined one (a self-hosted
  // Forgejo detects as `unknown` from its URL alone), so it is the better
  // guess for a fork on that host.
  const kind: SourceControlProviderKind =
    (identity && identityHost === originHost
      ? (identity.provider as SourceControlProviderKind | undefined)
      : undefined) ??
    recognizeRemote(url)?.kind ??
    SourceControlProviderKind.make("unknown");
  const segments = originKey
    .split("/")
    .slice(1)
    .filter((segment) => segment.length > 0);
  const [owner] = segments;
  const name = segments.at(-1);
  const origin = {
    canonicalKey,
    locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: url },
    ...(identity?.rootPath !== undefined ? { rootPath: identity.rootPath } : {}),
    displayName: segments.join("/"),
    provider: kind,
    ...(owner ? { owner } : {}),
    ...(name ? { name } : {}),
  } satisfies RepositoryIdentity;
  const resolved = fromIdentity(origin);
  if (resolved === null) return own;
  return { ...resolved, host: changeRequestHost(origin, kind) };
}
