/**
 * Where a Forgejo repository lives, read from its git remote.
 *
 * `fgj` cannot work this out for itself inside a linked git worktree — it looks for a `.git`
 * directory and a worktree has a `.git` file — and every board card runs in one. So every `fgj`
 * invocation is given `-R <owner>/<name>` and `--hostname <host>` explicitly, and this is where
 * both come from. Host-agnostic by design: unlike GitHub's parser in `@t3tools/shared/git`, a
 * Forgejo instance is served from whatever hostname its admin chose.
 */
export interface ForgejoRemote {
  /** Host with its port, as `fgj` names an instance in its config: `codeberg.org`, `git.example.com:3000`. */
  readonly host: string;
  readonly nameWithOwner: string;
}

const SCP_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/\s]+):(.+)$/u;

/**
 * The last two path segments, `.git` dropped. Forgejo repositories are always `owner/name`; a
 * longer path (a reverse proxy serving Forgejo below a prefix) keeps its final pair, which is
 * what `-R` wants.
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

export function parseForgejoRemoteUrl(remoteUrl: string): ForgejoRemote | null {
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
