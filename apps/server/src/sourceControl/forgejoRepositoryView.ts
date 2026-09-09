/**
 * `fgj repo view` breaks the pattern its siblings follow: it takes a positional `owner/name`
 * rather than `-R`, and it has no `--json`. What it does have is a stable block of `Key: Value`
 * lines, so the labels are read directly:
 *
 * ```
 * Repository: owner/name
 * Description: …
 * URL: https://codeberg.org/owner/name
 * Clone URL (HTTPS): https://codeberg.org/owner/name.git
 * Clone URL (SSH): ssh://git@codeberg.org/owner/name.git
 * Default Branch: main
 * ```
 */
export interface ForgejoRepositoryView {
  readonly nameWithOwner: string | null;
  readonly url: string | null;
  readonly httpsCloneUrl: string | null;
  readonly sshCloneUrl: string | null;
  readonly defaultBranch: string | null;
}

/** Labels are matched case-insensitively but otherwise verbatim, so an added line is ignored
 *  rather than mistaken for one of these. */
const LABELS = {
  repository: "repository",
  url: "url",
  https: "clone url (https)",
  ssh: "clone url (ssh)",
  defaultBranch: "default branch",
} as const;

export function parseForgejoRepositoryView(output: string): ForgejoRepositoryView {
  const values = new Map<string, string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const label = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (value.length === 0 || values.has(label)) continue;
    values.set(label, value);
  }

  return {
    nameWithOwner: values.get(LABELS.repository) ?? null,
    url: values.get(LABELS.url) ?? null,
    httpsCloneUrl: values.get(LABELS.https) ?? null,
    sshCloneUrl: values.get(LABELS.ssh) ?? null,
    defaultBranch: values.get(LABELS.defaultBranch) ?? null,
  };
}
