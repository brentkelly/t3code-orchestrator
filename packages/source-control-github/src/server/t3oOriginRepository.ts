import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

import type { GitHubRepositoryLocator } from "./gitHubRepositoryResolution.ts";

/**
 * T3O-48: the checkout's `origin` repository on `host`, or null. gh prefers an `upstream`
 * remote, so in a fork every pull request lookup would ask the parent; T3o acts on `origin`,
 * the remote a plain `git push` uses. Without one on the host, upstream's selection stands.
 */
export function t3oOriginRepository(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
    readonly host: string | null;
  }>,
  host: string,
): GitHubRepositoryLocator | null {
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin === undefined) return null;
  const [remoteHost, owner, name, ...rest] = normalizeGitRemoteUrl(origin.url).split("/");
  if (origin.host !== host && remoteHost !== host) return null;
  return owner && name && rest.length === 0 ? { host, owner, name } : null;
}
