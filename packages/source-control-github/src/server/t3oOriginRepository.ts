import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

import type { GitHubRepositoryLocator } from "./gitHubRepositoryResolution.ts";

/**
 * T3O-48: the checkout's `origin` repository on `host`, or null.
 *
 * Upstream picks the repository the way `gh` does, and gh PREFERS a remote named
 * `upstream`. In a fork that has an upstream remote, every pull request lookup then
 * asks the parent, truthfully hears "no pull request", and a finished card sits at
 * Ready for merge with no link. T3o acts on `origin` whenever it is on the host, the
 * same remote a plain `git push` uses; without one, upstream's selection stands.
 */
export function t3oOriginRepository(
  remotes: ReadonlyArray<{ readonly name: string; readonly url: string; readonly host: string | null }>,
  host: string,
): GitHubRepositoryLocator | null {
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin === undefined) return null;
  const [remoteHost, owner, name, ...rest] = normalizeGitRemoteUrl(origin.url).split("/");
  if (origin.host !== host && remoteHost !== host) return null;
  return owner && name && rest.length === 0 ? { host, owner, name } : null;
}
