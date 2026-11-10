// @effect-diagnostics nodeBuiltinImport:off - git runs this on every fetch and push, so it
// stays plain synchronous Node with no Effect runtime to boot.
/**
 * T3o (T3O-58): git credential helper and `gh` shim over the gitenv file, so terminals,
 * scripts and CI pick the same GitHub token T3 does. Built to `dist/t3oGitCredential.mjs`;
 * `scripts/t3o-service.mjs` installs the `t3-git-credential` and `gh` shims that run it.
 * See docs/t3o/gitenv.md.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type GitenvTokenMatch,
  type GitHubRepoRef,
  githubRepoFromUrl,
  gitenvToken,
  gitenvTokenForRepo,
} from "@t3tools/shared/gitenv";

/** Carried near the top of every shim the installer writes; the gh shim skips such files. */
export const T3O_SHIM_MARKER = "# t3o-managed shim";

/**
 * The gitenv file to read: `--file <path>` (or `--file=<path>`) at the front of `argv`, else
 * `$T3CODE_HOME/userdata/gitenv`, else `~/.t3/userdata/gitenv` (the server's base-dir rule,
 * duplicated because importing it would boot Effect). Returns the remaining arguments.
 */
export function resolveGitenvFile(
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): { readonly file: string; readonly rest: ReadonlyArray<string> } {
  const [first, second, ...others] = argv;
  if (first === "--file" && second !== undefined) {
    return { file: NodePath.resolve(second), rest: others };
  }
  if (first?.startsWith("--file=")) {
    return { file: NodePath.resolve(first.slice("--file=".length)), rest: argv.slice(1) };
  }
  const home = env.T3CODE_HOME?.trim() || NodePath.join(homeDir, ".t3");
  return { file: NodePath.join(home, "userdata", "gitenv"), rest: argv };
}

/** git's credential protocol input: `key=value` lines up to a blank line. */
export function parseCredentialRequest(text: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "") break;
    const separator = line.indexOf("=");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return fields;
}

/** `Owner/repo(.git)` from a credential `path=` or `gh -R`, or null. */
function ownerRepoOf(value: string): GitHubRepoRef | null {
  const match = /^\/?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(value.trim());
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : null;
}

/**
 * The answer to a credential `get`: the token for github.com over https, chosen by the repo
 * git names in `path=` (folder entry for `cwd` first), or by `cwd`'s origin when git sends no
 * path (`useHttpPath` off). Null means print nothing so git asks its next helper.
 */
export function credentialAnswer(request: ReadonlyMap<string, string>, cwd: string): string | null {
  if (request.get("protocol") !== "https" || request.get("host")?.toLowerCase() !== "github.com") {
    return null;
  }
  const path = request.get("path");
  let match: GitenvTokenMatch | undefined;
  if (path === undefined) {
    match = gitenvToken(cwd);
  } else {
    const repo = ownerRepoOf(path);
    match = repo === null ? undefined : gitenvTokenForRepo({ ...repo, cwd });
  }
  return match === undefined ? null : `username=x-access-token\npassword=${match.token}\n`;
}

/** A `gh -R` / `GH_REPO` value: `OWNER/REPO`, `github.com/OWNER/REPO` or a URL. */
function ghRepoValue(value: string): GitHubRepoRef | null {
  const fromUrl = githubRepoFromUrl(value);
  if (fromUrl !== null) return fromUrl;
  const parts = value.trim().split("/");
  if (parts.length === 3 && parts[0]?.toLowerCase() === "github.com") {
    return ownerRepoOf(parts.slice(1).join("/"));
  }
  return parts.length === 2 ? ownerRepoOf(value) : null;
}

/**
 * The repo a gh invocation acts on: `-R`/`--repo` (stopping at `--`), else `$GH_REPO`. An
 * explicit value naming a host other than github.com gives `{ explicit: true, repo: null }`
 * so the caller never falls back to the folder's origin.
 */
export function ghTargetRepo(
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): { readonly explicit: boolean; readonly repo: GitHubRepoRef | null } {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") break;
    let value: string | undefined;
    if (arg === "-R" || arg === "--repo") value = args[index + 1];
    else if (arg.startsWith("--repo=")) value = arg.slice("--repo=".length);
    else if (arg.startsWith("-R") && arg.length > 2) value = arg.slice(2);
    if (value !== undefined) return { explicit: true, repo: ghRepoValue(value) };
  }
  const fromEnv = env.GH_REPO?.trim();
  if (fromEnv) return { explicit: true, repo: ghRepoValue(fromEnv) };
  return { explicit: false, repo: null };
}

/** The gitenv token for a gh invocation from `cwd`, or undefined to leave gh's env alone. */
export function ghToken(
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): GitenvTokenMatch | undefined {
  const target = ghTargetRepo(args, env);
  if (!target.explicit) return gitenvToken(cwd);
  return target.repo === null ? undefined : gitenvTokenForRepo({ ...target.repo, cwd });
}

function isShim(file: string): boolean {
  try {
    const fd = NodeFS.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(512);
      const read = NodeFS.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, read).toString("utf8").includes(T3O_SHIM_MARKER);
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * The real `gh` on `pathEnv`: the first executable `gh` that is neither a T3o shim nor (by
 * realpath) one of `selfPaths`. Null when there is none.
 */
export function findRealGh(
  pathEnv: string | undefined,
  selfPaths: ReadonlyArray<string>,
  executableName: string,
): string | null {
  const selves = new Set(selfPaths.map((path) => realpathOrSelf(path)));
  for (const dir of (pathEnv ?? "").split(NodePath.delimiter)) {
    if (dir === "") continue;
    const candidate = NodePath.join(dir, executableName);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      if (!NodeFS.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    if (selves.has(realpathOrSelf(candidate)) || isShim(candidate)) continue;
    return candidate;
  }
  return null;
}

function realpathOrSelf(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
}
