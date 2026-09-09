/**
 * `fgj auth status`, which prints one bullet per instance it holds a token for:
 *
 * ```
 * Authenticated instances:
 *   • codeberg.org (user: octocat)
 * ```
 *
 * and, with nothing configured, `Not authenticated with any Forgejo instances`. Both exit 0, so
 * the exit code says nothing and only the bullet lines do. The generic `parseCliHost` helper
 * cannot read these: after the bullet the line still carries ` (user: …)`, which its host
 * pattern rejects.
 */
export interface ForgejoAuthStatusHost {
  readonly host: string;
  readonly account: string | null;
}

/** `  • git.example.com:3000 (user: octocat)` — the account is optional so an unfamiliar
 *  spelling still yields its host rather than being dropped. */
const INSTANCE_LINE_PATTERN =
  /^[•*-]\s*((?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(?::\d+)?)\s*(?:\(user:\s*([^)]+)\))?$/iu;

export function parseForgejoAuthStatusHosts(text: string): ReadonlyArray<ForgejoAuthStatusHost> {
  const hosts: ForgejoAuthStatusHost[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = INSTANCE_LINE_PATTERN.exec(rawLine.trim());
    if (match === null) continue;
    const host = match[1]?.trim();
    if (!host) continue;
    const account = match[2]?.trim();
    hosts.push({
      host: host.toLowerCase(),
      account: account !== undefined && account.length > 0 ? account : null,
    });
  }
  return hosts;
}

export function findAuthenticatedForgejoHost(
  hosts: ReadonlyArray<ForgejoAuthStatusHost>,
): ForgejoAuthStatusHost | undefined {
  return hosts.find((host) => host.account !== null);
}

/**
 * Whether `fgj` holds a token for this host. Hosts are compared with their port, because that is
 * how `fgj` keys its own config and how a remote URL addresses the instance.
 */
export function isAuthenticatedForgejoHost(
  hosts: ReadonlyArray<ForgejoAuthStatusHost>,
  host: string,
): boolean {
  const normalized = host.trim().toLowerCase();
  return hosts.some((entry) => entry.account !== null && entry.host === normalized);
}
