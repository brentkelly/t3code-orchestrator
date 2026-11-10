// @effect-diagnostics nodeBuiltinImport:off - deliberately synchronous and
// dependency-free so each seam in an upstream file stays a one-line expression.
// @effect-diagnostics globalConsole:off - the permissions warning fires from
// sync spawn paths that have no Effect logger in scope.
/**
 * T3o gitenv — per-project GitHub token overrides (t3o-34).
 *
 * A hand-edited file at `<stateDir>/gitenv` maps keys to PATs, one `<key>=<pat>`
 * per line (`#` comments and blank lines allowed). A key is a project's
 * absolute folder path, `github.com/<owner>/<repo>` or `github.com/<owner>`
 * (T3O-58); a lookup tries them in that order, the repo coming from the main
 * checkout's `origin` remote. When
 * a subprocess that talks to GitHub is spawned for a directory inside a
 * matched project, `{ GH_TOKEN, GITHUB_TOKEN }` is merged over its inherited
 * environment so `gh` — and https git auth through gh's credential helper —
 * act as that project's identity instead of the machine's ambient login.
 *
 * The token only ever rides in a spawn `env` option: never in argv, never in
 * a shell string, never in T3o's own persisted or logged output.
 * `scrubGitenvTokens` exists so persisted process output can also drop the
 * exact configured values, whatever their shape. Note the containment stops at
 * the agent's process boundary: an agent session gets the token in its
 * environment so its own `gh` authenticates, and — exactly as with any ambient
 * credential the process inherits — an agent that deliberately reads its
 * environment can observe it. The guarantee is that T3o never places the token
 * in a prompt, a tool argument, argv, or a log, not that the value is invisible
 * to the agent.
 *
 * Matching is worktree-aware: the calling cwd is resolved to its main
 * repository root by walking up to the nearest `.git` entry and, for linked
 * worktrees (a `.git` *file* pointing at `<main>/.git/worktrees/<name>`),
 * following it back to the main checkout. Board worktrees live under
 * `<T3 home>/worktrees/`, outside the project directory, so a plain prefix
 * match on cwd would miss every board build.
 *
 * The module is intentionally synchronous and dependency-free so each seam in
 * an upstream file stays a one-line expression. `initGitenv` is called from
 * `resolveServerConfig` (the resolver every `t3` server boot goes through:
 * `start`, `serve`, the desktop bootstrap, `vp run dev` — and, through
 * `resolveCliAuthConfig`, `auth`, `connect` and `project`) and from
 * `ServerConfig.make`, which only `pair` still reaches with a hand-built
 * config; it is idempotent on the same path. Before either runs, or when the
 * file is absent, every lookup returns undefined and behavior is exactly
 * stock.
 *
 * GitHub-only for now: no cross-forge token variable exists. A forge-aware
 * variant can later pick the variable per detected remote without changing
 * the file format.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type GitenvEntryKind = "folder" | "repo" | "owner";

interface GitenvEntry {
  /** The key as written in the file (a folder entry's resolved root), for messages. */
  readonly key: string;
  readonly token: string;
}

/** Which line of the file a token came from. Never carries the token. */
export interface GitenvEntryRef {
  readonly kind: GitenvEntryKind;
  readonly key: string;
}

export interface GitenvTokenMatch {
  readonly token: string;
  /** Hex SHA-256 of the token; safe for cache keys and logs, the token itself never is. */
  readonly digest: string;
  readonly entry: GitenvEntryRef;
}

export interface GitHubRepoRef {
  readonly owner: string;
  readonly repo: string;
}

const GITHUB_KEY_PREFIX = "github.com/";

interface GitenvFileCache {
  readonly mtimeMs: number;
  readonly size: number;
  /** Folder entries keyed by resolved main root; GitHub entries by lowercased `github.com/o[/r]`. */
  readonly entries: ReadonlyMap<string, GitenvEntry>;
  /** Token → hex SHA-256, filled on first use and dropped with the file cache. */
  readonly digests: Map<string, string>;
}

let gitenvPath: string | undefined;
let fileCache: GitenvFileCache | undefined;
let warnedLoosePermissions = false;
/** `.git/config` path → its `origin`'s GitHub repo, keyed by the config's mtime. */
const repoCache = new Map<string, { readonly mtimeMs: number; readonly repo: GitHubRepoRef | null }>();


/** Shortest value `scrubGitenvTokens` will redact. A real PAT is far longer;
    the floor keeps a placeholder value from mangling unrelated output. */
const MIN_SCRUBBABLE_TOKEN_LENGTH = 16;

export function initGitenv(stateDir: string): void {
  initGitenvFile(NodePath.join(stateDir, "gitenv"));
}

/** Point the reader at a file directly; the credential helper's `--file`. */
export function initGitenvFile(next: string): void {
  if (next === gitenvPath) {
    return;
  }
  gitenvPath = next;
  fileCache = undefined;
  warnedLoosePermissions = false;
}

/** Test seam: forget everything, including the configured file path. */
export function resetGitenvForTesting(): void {
  gitenvPath = undefined;
  fileCache = undefined;
  warnedLoosePermissions = false;
  repoCache.clear();
}

function realpathOrSelf(target: string): string {
  try {
    return NodeFS.realpathSync(target);
  } catch {
    return NodePath.resolve(target);
  }
}

/** `github.com/<owner>` or `github.com/<owner>/<repo>(.git)`, as a lowercased map key. */
function githubEntryKey(key: string): string | null {
  const match = /^github\.com\/([^/\s]+)(?:\/([^/\s]+?))?\/?$/i.exec(key);
  if (!match?.[1]) return null;
  const repo = match[2]?.replace(/\.git$/i, "");
  if (repo === "") return null;
  return githubMapKey(match[1], repo);
}

function githubMapKey(owner: string, repo: string | undefined): string {
  return `${GITHUB_KEY_PREFIX}${owner}${repo === undefined ? "" : `/${repo}`}`.toLowerCase();
}

function parseGitenv(text: string): ReadonlyMap<string, GitenvEntry> {
  const entries = new Map<string, GitenvEntry>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }
    const githubKey = githubEntryKey(key);
    if (githubKey !== null) {
      entries.set(githubKey, { key, token: value });
      continue;
    }
    if (!NodePath.isAbsolute(key)) {
      continue;
    }
    // Keys resolve to their main checkout exactly as lookups do, so an entry
    // keyed by a linked worktree's path still matches.
    const root = resolveMainRepositoryRoot(key) ?? realpathOrSelf(key);
    entries.set(root, { key: root, token: value });
  }
  return entries;
}

function readEntries(): ReadonlyMap<string, GitenvEntry> | undefined {
  if (gitenvPath === undefined) {
    return undefined;
  }
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.statSync(gitenvPath);
  } catch {
    fileCache = undefined;
    return undefined;
  }
  if (
    fileCache !== undefined &&
    fileCache.mtimeMs === stat.mtimeMs &&
    fileCache.size === stat.size
  ) {
    return fileCache.entries;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- sync spawn-path module, outside any Effect runtime.
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0 && !warnedLoosePermissions) {
    warnedLoosePermissions = true;
    console.warn(`[t3o] ${gitenvPath} is readable by group/other; chmod 600 is recommended.`);
  }
  let text: string;
  try {
    text = NodeFS.readFileSync(gitenvPath, "utf8");
  } catch {
    return undefined;
  }
  fileCache = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    entries: parseGitenv(text),
    digests: new Map(),
  };
  return fileCache.entries;
}

/**
 * Resolve a directory to the root of the main checkout of the repository it
 * sits in. Walks up to the nearest `.git`; a directory means we are in the
 * main checkout, a file is a linked worktree/submodule pointer whose gitdir
 * is followed back to the main root. Returns null outside any repository.
 *
 * Deliberately uncached: a cwd can be a board worktree that does not exist
 * yet, or was just reclaimed, and a remembered answer would pin its
 * replacement at the same path to the wrong identity. The walk is a few
 * `stat`s — nothing next to the process spawn it precedes.
 */
function resolveMainRepositoryRoot(cwd: string): string | null {
  const start = realpathOrSelf(cwd);
  let root: string | null = null;
  let current = start;
  for (;;) {
    const gitEntry = NodePath.join(current, ".git");
    let entryStat: NodeFS.Stats | undefined;
    try {
      entryStat = NodeFS.statSync(gitEntry);
    } catch {
      entryStat = undefined;
    }
    if (entryStat?.isDirectory()) {
      root = current;
      break;
    }
    if (entryStat?.isFile()) {
      root = mainRootFromGitFile(gitEntry, current);
      break;
    }
    const parent = NodePath.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return root;
}

/** `.git` file contents are `gitdir: <path>`; a linked worktree's gitdir is
    `<main>/.git/worktrees/<name>`, from which the main root falls out. Any
    other pointer (submodules) keeps the containing directory as the root. */
function mainRootFromGitFile(gitFile: string, containingDir: string): string {
  let contents: string;
  try {
    contents = NodeFS.readFileSync(gitFile, "utf8");
  } catch {
    return containingDir;
  }
  const match = contents.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match?.[1]) {
    return containingDir;
  }
  const gitdir = NodePath.resolve(containingDir, match[1].trim());
  const worktreeMarker = `${NodePath.sep}.git${NodePath.sep}worktrees${NodePath.sep}`;
  const markerIndex = gitdir.lastIndexOf(worktreeMarker);
  if (markerIndex !== -1) {
    return realpathOrSelf(gitdir.slice(0, markerIndex));
  }
  return containingDir;
}

/**
 * The GitHub repo of a remote URL: `https://github.com/O/R(.git)`,
 * `git@github.com:O/R(.git)` or `ssh://git@github.com/O/R(.git)`. Any other
 * host, or a URL of another shape, gives null.
 */
export function githubRepoFromUrl(url: string): GitHubRepoRef | null {
  const trimmed = url.trim();
  const match =
    /^(?:https?|ssh|git\+ssh):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)\/?$/i.exec(
      trimmed,
    ) ?? /^(?:[^@/:\s]+@)?github\.com:\/?([^/\s]+)\/([^/\s]+?)\/?$/i.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  const repo = match[2].replace(/\.git$/i, "");
  return repo === "" ? null : { owner: match[1], repo };
}

/** The `url` of `[remote "origin"]` in a git config file's text, or null. */
export function originUrlFromGitConfig(text: string): string | null {
  let inOrigin = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/i.exec(line);
    if (match?.[1]) return match[1].trim().replace(/^"(.*)"$/, "$1");
  }
  return null;
}

/** The GitHub repo of a main checkout's `origin`, cached by its config's mtime. */
function githubRepoOfRoot(root: string): GitHubRepoRef | null {
  const configPath = NodePath.join(root, ".git", "config");
  let mtimeMs: number;
  try {
    mtimeMs = NodeFS.statSync(configPath).mtimeMs;
  } catch {
    repoCache.delete(configPath);
    return null;
  }
  const cached = repoCache.get(configPath);
  if (cached?.mtimeMs === mtimeMs) return cached.repo;
  let repo: GitHubRepoRef | null = null;
  try {
    const url = originUrlFromGitConfig(NodeFS.readFileSync(configPath, "utf8"));
    repo = url === null ? null : githubRepoFromUrl(url);
  } catch {
    repo = null;
  }
  repoCache.set(configPath, { mtimeMs, repo });
  return repo;
}

/** The GitHub repo a directory's main checkout pushes to (its `origin`), or null. */
export function gitenvGitHubRepo(cwd: string | undefined): GitHubRepoRef | null {
  if (cwd === undefined) return null;
  const root = resolveMainRepositoryRoot(cwd);
  return root === null ? null : githubRepoOfRoot(root);
}

function matchOf(entry: GitenvEntry, kind: GitenvEntryKind): GitenvTokenMatch {
  // The API transport asks on every request; hash each token once per file read.
  let digest = fileCache?.digests.get(entry.token);
  if (digest === undefined) {
    digest = NodeCrypto.createHash("sha256").update(entry.token).digest("hex");
    fileCache?.digests.set(entry.token, digest);
  }
  return { token: entry.token, digest, entry: { kind, key: entry.key } };
}

function matchRepo(
  entries: ReadonlyMap<string, GitenvEntry>,
  repo: GitHubRepoRef,
): GitenvTokenMatch | undefined {
  const byRepo = entries.get(githubMapKey(repo.owner, repo.repo));
  if (byRepo !== undefined) return matchOf(byRepo, "repo");
  const byOwner = entries.get(githubMapKey(repo.owner, undefined));
  return byOwner === undefined ? undefined : matchOf(byOwner, "owner");
}

/**
 * The matched project's token, or undefined when the file, an entry, or a
 * repository is absent. Tries the folder entry for the main checkout, then
 * `github.com/<owner>/<repo>`, then `github.com/<owner>` for its `origin`.
 * `root` is the main checkout the lookup resolved to, whichever entry matched,
 * so batch keys still never mix projects. Used by the server's own GitHub API
 * transport (T3O-67), which sends the token as a bearer header rather than
 * through a spawn env.
 */
export function gitenvToken(
  cwd: string | undefined,
): (GitenvTokenMatch & { readonly root: string }) | undefined {
  if (cwd === undefined) {
    return undefined;
  }
  const entries = readEntries();
  if (entries === undefined || entries.size === 0) {
    return undefined;
  }
  const root = resolveMainRepositoryRoot(cwd);
  if (root === null) {
    return undefined;
  }
  const folder = entries.get(root);
  if (folder !== undefined) {
    return { root, ...matchOf(folder, "folder") };
  }
  const repo = githubRepoOfRoot(root);
  const match = repo === null ? undefined : matchRepo(entries, repo);
  return match === undefined ? undefined : { root, ...match };
}

/**
 * The token for a named GitHub repo, as git's credential `path=` or `gh -R`
 * names it: the folder entry for `cwd`'s main checkout first, then the repo
 * entry, then the owner entry.
 */
export function gitenvTokenForRepo(input: {
  readonly owner: string;
  readonly repo: string;
  readonly cwd?: string | undefined;
}): GitenvTokenMatch | undefined {
  const entries = readEntries();
  if (entries === undefined || entries.size === 0) {
    return undefined;
  }
  const root = input.cwd === undefined ? null : resolveMainRepositoryRoot(input.cwd);
  const folder = root === null ? undefined : entries.get(root);
  if (folder !== undefined) {
    return matchOf(folder, "folder");
  }
  return matchRepo(entries, input);
}

/**
 * The env fragment for a matched project, or undefined when the file, an
 * entry, or a repository is absent. GitHub-only by design.
 */
export function gitenvTokenEnv(cwd: string | undefined): Record<string, string> | undefined {
  const match = gitenvToken(cwd);
  if (match === undefined) {
    return undefined;
  }
  return { GH_TOKEN: match.token, GITHUB_TOKEN: match.token };
}

/**
 * Merge the token fragment over an existing spawn env. Returns the input env
 * untouched (possibly undefined) when nothing matches, so `undefined` keeps
 * meaning "inherit the parent environment" at every call site.
 */
export function withGitenvTokenEnv(
  env: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
): NodeJS.ProcessEnv | undefined {
  const tokens = gitenvTokenEnv(cwd);
  if (tokens === undefined) {
    return env;
  }
  return { ...env, ...tokens };
}

/**
 * Drop every configured token value from free text bound for the event log or
 * UI, whatever the token's shape. Complements the published-prefix scrub in
 * `safeProcessOutput`, which cannot know about nonstandard PATs.
 */
export function scrubGitenvTokens(text: string): string {
  const entries = readEntries();
  if (entries === undefined || entries.size === 0) {
    return text;
  }
  let scrubbed = text;
  for (const { token } of entries.values()) {
    // A usable GitHub token is far longer than this; the floor stops a
    // mistyped or placeholder value from blanket-replacing a common substring
    // across unrelated output.
    if (token.length >= MIN_SCRUBBABLE_TOKEN_LENGTH && scrubbed.includes(token)) {
      scrubbed = scrubbed.split(token).join("***");
    }
  }
  return scrubbed;
}
