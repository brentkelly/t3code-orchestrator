/**
 * T3o (T3O-48): where a GitHub repository lives, read from its git remote.
 *
 * `gh` resolves the base repository itself when no `--repo` is given, and its rule PREFERS a
 * remote literally named `upstream` over `origin`. In a fork — which is what this repository is —
 * every unpinned `gh pr list` therefore asks the wrong repository and truthfully answers "no pull
 * request", which is how a card reached Ready for merge with no PR link and no Merge button.
 *
 * T3 Code acts on the project's `origin` remote, always: the same default as plain `git push`.
 * `SourceControlProviderRegistry` already resolves an origin-preferring provider context and binds
 * it into every provider call, so this module's only job is to turn that context's remote URL into
 * the pair `gh --repo` wants.
 *
 * Host-agnostic on purpose: `parseGitHubRepositoryNameWithOwnerFromRemoteUrl` in
 * `@t3tools/shared/git` hardcodes `github.com` and drops the host, so a GitHub Enterprise remote
 * would silently resolve against github.com instead of its own install.
 */
export interface GitHubRemote {
  /** Host with its port, as `gh` qualifies a repository: `github.com`, `ghe.example.com`. */
  readonly host: string;
  /** `owner/name`. */
  readonly nameWithOwner: string;
}

const SCP_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/\s]+):(.+)$/u;

/**
 * The last two path segments, `.git` dropped. GitHub repositories are always `owner/name`; a
 * longer path (an enterprise install served below a prefix) keeps its final pair, which is what
 * `--repo` wants.
 */
function parseNameWithOwner(path: string): string | null {
  const segments = path
    .replace(/\.git$/u, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }
  const owner = segments.at(-2);
  const name = segments.at(-1);
  return owner && name ? `${owner}/${name}` : null;
}

export function parseGitHubRemoteUrl(remoteUrl: string): GitHubRemote | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const scpMatch = SCP_REMOTE_PATTERN.exec(trimmed);
  if (scpMatch?.[1] && scpMatch[2]) {
    const nameWithOwner = parseNameWithOwner(scpMatch[2]);
    return nameWithOwner ? { host: scpMatch[1].toLowerCase(), nameWithOwner } : null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.host.length === 0) {
    return null;
  }
  const nameWithOwner = parseNameWithOwner(decodeURIComponent(url.pathname));
  return nameWithOwner ? { host: url.host.toLowerCase(), nameWithOwner } : null;
}

/**
 * The `--repo` flag pair for a resolved remote, or nothing when the registry could not resolve
 * one.
 *
 * Host-QUALIFIED, matching what upstream's own `GitHubPullRequestCli.repositoryArgs` does: `gh`
 * resolves a bare `owner/repo` against whichever host it defaults to, so a GHES repository would
 * otherwise collide with a same-named repository on github.com.
 *
 * An absent remote yields NO flag, leaving the invocation byte-identical to what it was before
 * this existed. The registry only fails to resolve a context when the checkout has no usable
 * remote at all, and `gh`'s own error there is better than one of ours.
 */
export function gitHubRepositoryArgs(
  repository: GitHubRemote | null | undefined,
): ReadonlyArray<string> {
  return repository == null ? [] : ["--repo", `${repository.host}/${repository.nameWithOwner}`];
}

/**
 * The same repository as ONE positional argument, for the `gh` commands that take it that way.
 *
 * `gh repo view` has no `--repo` flag — it reads `[HOST/]OWNER/REPO` positionally — so pinning it
 * needs this rather than `gitHubRepositoryArgs`. Same host-qualified form, same "absent means no
 * argument at all, and `gh` falls back to its own resolution" rule.
 */
export function gitHubRepositoryPositionalArgs(
  repository: GitHubRemote | null | undefined,
): ReadonlyArray<string> {
  return repository == null ? [] : [`${repository.host}/${repository.nameWithOwner}`];
}
