// @effect-diagnostics nodeBuiltinImport:off - checks stat and read fixed machine paths directly.
/**
 * T3o: a project's readiness checks on this worker (T3O-124). No string from `t3o.json` picks the
 * program, its argv, or what is read beyond allowlisted shapes. Every filesystem call is async: a
 * FIFO, a device or an automount must never stall the event loop.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  BOARD_READINESS_MAX_CHECKS,
  BOARD_READINESS_NAME,
  BOARD_READINESS_VERSION_ARGS,
  boardReadinessCheckKind,
  boardReadinessCheckLabel,
  stripBoardReadinessText,
  type BoardReadinessCheck,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { ReadinessSpawnInput } from "./readinessSpawn.ts";

const VERSION_TIMEOUT_MS = 10_000;
const DOCKER_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 10_000;
const DETAIL_CHARS = 200;
const FIELD_CHARS = 256;
const CONFIG_READ_BYTES = 1024 * 1024;
const GLOB_MAX_ENTRIES = 10_000;
const GLOB_MAX_MS = 2_000;

export interface ReadinessRun {
  /** Null when the process never started or was killed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** What checks need from the machine. Tests supply their own. */
export interface ReadinessCheckHost {
  /** Run a vetted absolute path with fixed argv (`spawnReadinessProbe` in production). */
  readonly run: (input: ReadinessSpawnInput) => Effect.Effect<ReadinessRun>;
  /** The worker's environment, unfiltered: only allowlisted names are ever passed on. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly tmpdir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** This process's uid; null where there is none (Windows). */
  readonly uid: number | null;
  /** Homebrew prefixes (`READINESS_HOMEBREW_PREFIXES` in production): their `bin` is searched. */
  readonly homebrewPrefixes: ReadonlyArray<string>;
  /**
   * Project checkouts, worktrees, the T3 home and the shared temp folders (`/tmp`, `/var/tmp`):
   * a binary inside one is refused. `$TMPDIR` and the home's package stores are added here.
   */
  readonly forbiddenRoots: Effect.Effect<ReadonlyArray<string>>;
}

export const READINESS_HOMEBREW_PREFIXES = [
  "/opt/homebrew",
  "/usr/local",
  "/home/linuxbrew/.linuxbrew",
] as const;

/** The project's checkout and its default branch, for repository files and git probes. */
export interface ReadinessRepo {
  readonly checkout: string;
  /** The remote `resolvePrimaryRemoteName` picks, or null with none. */
  readonly remote: Effect.Effect<string | null>;
  /** A blob on the default branch, at most 64 KB, read without filters; null when absent. */
  readonly file: (path: string) => Effect.Effect<string | null>;
}

export type ReadinessCheckStatus = "pass" | "fail" | "warn" | "skipped";

export interface ReadinessCheckResult {
  readonly label: string;
  readonly status: ReadinessCheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

const clip = (text: string) =>
  stripBoardReadinessText(text).replace(/\s+/g, " ").trim().slice(0, DETAIL_CHARS);
const lastLine = (run: ReadinessRun) =>
  clip(
    (run.timedOut ? "timed out" : `${run.stderr}\n${run.stdout}`)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ?? `exited ${run.exitCode ?? "without a code"}`,
  );

const PASSED_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "RUSTUP_HOME",
  "CARGO_HOME",
];
const GH_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"];

/**
 * The whole environment a check's program gets. Nothing else of the worker's passes: no
 * `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `RUSTUP_TOOLCHAIN`, `COREPACK_*`, `PYTHON*`, ….
 * `GH_TOKEN`, `GITHUB_TOKEN` and `GH_HOST` only for `gh`.
 */
export function readinessEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly gh: boolean } = { gh: false },
): Record<string, string> {
  const out: Record<string, string> = {};
  const names = Object.keys(env).filter(
    (name) =>
      PASSED_ENV.includes(name) ||
      name.startsWith("LC_") ||
      name.startsWith("XDG_") ||
      (options.gh && GH_ENV.includes(name)),
  );
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  out.PATH = searchPath(env).join(NodePath.delimiter);
  out.COREPACK_ENABLE_NETWORK = "0";
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_CONFIG_NOSYSTEM = "1";
  return out;
}

/** PATH with empty and relative entries dropped. */
const searchPath = (env: Readonly<Record<string, string | undefined>>) =>
  (env.PATH ?? "").split(NodePath.delimiter).filter((dir) => NodePath.isAbsolute(dir));

const NEVER_ROOTS = ["/proc", "/sys", "/run", "/net", "/mnt", "/media", "/Volumes", "/afs"];
const SYSTEM_ROOTS = ["/usr", "/opt", "/etc", "/Library", "/Applications", "/nix", "/dev"];

const isUnder = (path: string, root: string) =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/** `$VAR`'s default where the tool has one, so an unset variable still finds the usual place. */
function pathVarDefault(name: string, host: ReadinessCheckHost): string | null {
  const home = host.home;
  switch (name) {
    case "HOME":
      return home;
    case "TMPDIR":
      return host.tmpdir;
    case "CARGO_HOME":
      return NodePath.join(home, ".cargo");
    case "RUSTUP_HOME":
      return NodePath.join(home, ".rustup");
    case "PLAYWRIGHT_BROWSERS_PATH":
      return host.platform === "darwin"
        ? NodePath.join(home, "Library/Caches/ms-playwright")
        : NodePath.join(home, ".cache/ms-playwright");
    case "XDG_CONFIG_HOME":
      return NodePath.join(home, ".config");
    case "XDG_DATA_HOME":
      return NodePath.join(home, ".local/share");
    case "XDG_STATE_HOME":
      return NodePath.join(home, ".local/state");
    case "XDG_CACHE_HOME":
      return NodePath.join(home, ".cache");
    default:
      return null;
  }
}

/** A classified machine path, absolute; an error when its variable is unset or relative. */
function expandMachinePath(
  path: string,
  host: ReadinessCheckHost,
): { readonly path: string } | { readonly error: string } {
  const [head, ...rest] = path.split("/");
  let base: string | null;
  if (head === "") base = "/";
  else if (head === "~") base = host.home;
  else if (head !== undefined && head.startsWith("$")) {
    const name = head.slice(1);
    const value = name === "HOME" ? host.home : name === "TMPDIR" ? host.tmpdir : host.env[name];
    base = value !== undefined && value !== "" ? value : pathVarDefault(name, host);
    if (base === null) return { error: `$${name} is not set` };
  } else return { error: "unusable path" };
  if (!NodePath.isAbsolute(base)) return { error: `${head} is not an absolute path` };
  return { path: NodePath.join(base, ...rest) };
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await NodeFSP.realpath(path);
  } catch {
    return null;
  }
}

/** The realpath of `path`, or of its deepest existing ancestor with the rest appended. */
async function realpathLoose(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    const real = await realpathOrNull(current);
    if (real !== null) return NodePath.join(real, ...missing.reverse());
    const parent = NodePath.dirname(current);
    if (parent === current) return path;
    missing.push(NodePath.basename(current));
    current = parent;
  }
}

const neverRootOf = (path: string) => NEVER_ROOTS.find((root) => isUnder(path, root)) ?? null;

/** Where a machine path may resolve: home, temp and system roots, each through symlinks. */
async function allowedRoots(host: ReadinessCheckHost): Promise<ReadonlyArray<string>> {
  const roots = [host.home, host.tmpdir, ...SYSTEM_ROOTS];
  const real = await Promise.all(roots.map((root) => realpathOrNull(root)));
  return [...new Set([...roots, ...real.filter((root) => root !== null)])];
}

/**
 * The realpath of a machine path when it is somewhere a check may look, else why not. The
 * never-roots are refused before anything touches the filesystem, so an automount never fires.
 */
export async function confineMachinePath(
  path: string,
  host: ReadinessCheckHost,
): Promise<{ readonly real: string } | { readonly error: string }> {
  const lexical = NodePath.resolve(path);
  const never = neverRootOf(lexical);
  if (never !== null) return { error: `${never} is never read` };
  const real = await realpathLoose(lexical);
  const neverReal = neverRootOf(real);
  if (neverReal !== null)
    return { error: `${path} resolves into ${neverReal}, which is never read` };
  const roots = await allowedRoots(host);
  if (!roots.some((root) => isUnder(real, root))) {
    return { error: `${path} is outside the folders a check may look in` };
  }
  return { real };
}

const globRegex = (segment: string) =>
  new RegExp(
    `^${segment
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );

/**
 * What an absolute pattern matches, `*` within one segment. Reads at most 10,000 directory
 * entries in at most 2 s; the literal folder before the first wildcard must be confined and at
 * least two segments below home.
 */
export async function expandReadinessGlob(
  pattern: string,
  host: ReadinessCheckHost,
): Promise<{ readonly matches: ReadonlyArray<string> } | { readonly error: string }> {
  const segments = pattern.split("/").filter((segment) => segment !== "");
  const first = segments.findIndex((segment) => segment.includes("*"));
  if (first === -1) return { matches: [pattern] };
  if (segments.filter((segment) => segment.includes("*")).length > 2) {
    return { error: "at most two * folders" };
  }
  const prefix = `/${segments.slice(0, first).join("/")}`;
  const confined = await confineMachinePath(prefix, host);
  if ("error" in confined) return confined;
  const realHome = (await realpathOrNull(host.home)) ?? host.home;
  if (first < 2 || isUnder(realHome, confined.real) || isUnder(host.home, prefix)) {
    return { error: "a * directly under home or near / is refused" };
  }
  const started = performance.now();
  let entries = 0;
  let found = [confined.real];
  for (const segment of segments.slice(first)) {
    const next: string[] = [];
    for (const dir of found) {
      if (!segment.includes("*")) {
        next.push(NodePath.join(dir, segment));
        continue;
      }
      const regex = globRegex(segment);
      let handle: NodeFS.Dir | null = null;
      try {
        handle = await NodeFSP.opendir(dir);
        for await (const entry of handle) {
          entries += 1;
          if (entries > GLOB_MAX_ENTRIES || performance.now() - started > GLOB_MAX_MS) {
            return { error: "the pattern reads too many folder entries" };
          }
          if (regex.test(entry.name)) next.push(NodePath.join(dir, entry.name));
        }
        handle = null;
      } catch {
        // An unreadable folder matches nothing.
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    found = next.sort();
    if (found.length === 0) break;
  }
  return { matches: found };
}

const O_NOFOLLOW = NodeFS.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = NodeFS.constants.O_NONBLOCK ?? 0;
const O_NOCTTY = NodeFS.constants.O_NOCTTY ?? 0;

/**
 * A machine file's text, read the only way checks read one: confined and realpath-checked,
 * opened with `O_NOFOLLOW|O_NONBLOCK|O_NOCTTY`, `fstat`ed as the same regular file, at most
 * `maxBytes`. A device, FIFO or oversized file is refused, never read.
 */
export async function readMachineFile(
  path: string,
  host: ReadinessCheckHost,
  maxBytes = CONFIG_READ_BYTES,
): Promise<{ readonly text: string } | { readonly missing: true } | { readonly error: string }> {
  const confined = await confineMachinePath(path, host);
  if ("error" in confined) return confined;
  let before: NodeFS.Stats;
  try {
    before = await NodeFSP.stat(confined.real);
  } catch {
    return { missing: true };
  }
  if (!before.isFile()) return { error: `${path} is not a regular file` };
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(
      confined.real,
      NodeFS.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      return { error: `${path} changed while being read` };
    }
    if (stat.size > maxBytes) return { error: `${path} is larger than ${maxBytes} bytes` };
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return { error: `${path} is larger than ${maxBytes} bytes` };
    return { text: buffer.subarray(0, bytesRead).toString("utf8") };
  } catch {
    return { error: `${path} could not be read` };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Where version managers and Homebrew put binaries, after PATH. A project can't add to it. */
function versionManagerDirs(host: ReadinessCheckHost): ReadonlyArray<string> {
  const home = host.home;
  const cargoHome = host.env.CARGO_HOME ?? NodePath.join(home, ".cargo");
  return [
    NodePath.join(home, ".local/share/mise/shims"),
    NodePath.join(home, ".asdf/shims"),
    NodePath.join(home, ".nvm/versions/node/*/bin"),
    NodePath.join(home, ".local/share/fnm/aliases/default/bin"),
    NodePath.join(home, ".fnm/aliases/default/bin"),
    NodePath.join(home, ".volta/bin"),
    NodePath.join(cargoHome, "bin"),
    ...host.homebrewPrefixes.map((prefix) => NodePath.join(prefix, "bin")),
  ];
}

/** Folders where a project's dependencies, a build or anyone else could have put a binary. */
function storeRoots(host: ReadinessCheckHost): ReadonlyArray<string> {
  const home = host.home;
  return [
    host.tmpdir,
    ...[
      "tmp",
      ".cache",
      ".npm",
      // pnpm's and bun's own binaries live beside their stores, so only the stores are refused.
      ".local/share/pnpm/store",
      ".local/share/pnpm/global",
      ".cargo/registry",
      ".cargo/git",
      "go/pkg",
      ".m2",
      ".gradle",
      ".bun/install",
    ].map((dir) => NodePath.join(home, dir)),
  ];
}

/** A `node_modules` other than an install prefix's `lib/node_modules`. */
const inProjectNodeModules = (path: string) => {
  const segments = path.split("/");
  const index = segments.indexOf("node_modules");
  return index !== -1 && segments[index - 1] !== "lib";
};

interface Vetted {
  readonly path: string;
  readonly real: string;
}

/** Every executable file called `name` on PATH, then in the version-manager folders. */
async function commandCandidates(
  name: string,
  host: ReadinessCheckHost,
): Promise<ReadonlyArray<string>> {
  const dirs: string[] = [...searchPath(host.env)];
  for (const dir of versionManagerDirs(host)) {
    if (!dir.includes("*")) dirs.push(dir);
    else {
      const expanded = await expandReadinessGlob(dir, host);
      if ("matches" in expanded) dirs.push(...expanded.matches);
    }
  }
  const names = host.platform === "win32" ? [`${name}.exe`, name] : [name];
  const out: string[] = [];
  for (const dir of new Set(dirs)) {
    for (const file of names) {
      const candidate = NodePath.join(dir, file);
      try {
        const stat = await NodeFSP.stat(candidate);
        if (!stat.isFile()) continue;
        if (host.platform !== "win32") await NodeFSP.access(candidate, NodeFS.constants.X_OK);
        out.push(candidate);
      } catch {
        // Not here.
      }
    }
  }
  return out;
}

/**
 * Whether t3o may trust a binary's realpath: owned by this user or root (or Homebrew's owner
 * under its prefix), not group- or world-writable, and not anywhere a project, a build or another
 * user could have put it.
 */
async function vetBinary(
  candidate: string,
  host: ReadinessCheckHost,
  forbidden: ReadonlyArray<string>,
): Promise<{ readonly vetted: Vetted } | { readonly refused: string }> {
  const real = await realpathOrNull(candidate);
  if (real === null) return { refused: `${candidate} can't be resolved` };
  let stat: NodeFS.Stats;
  try {
    stat = await NodeFSP.stat(real);
  } catch {
    return { refused: `${real} can't be read` };
  }
  if (host.uid !== null) {
    const owners = [host.uid, 0];
    for (const prefix of host.homebrewPrefixes) {
      if (!isUnder(real, prefix)) continue;
      const prefixStat = await NodeFSP.stat(prefix).catch(() => null);
      if (prefixStat !== null) owners.push(prefixStat.uid);
    }
    if (!owners.includes(stat.uid)) return { refused: `${real} is owned by another user` };
    if ((stat.mode & 0o022) !== 0) return { refused: `${real} is writable by others` };
  }
  const roots = [...forbidden, ...storeRoots(host)];
  const realRoots = await Promise.all(roots.map((root) => realpathOrNull(root)));
  const inside = [...roots, ...realRoots.filter((root) => root !== null)].find(
    (root) => isUnder(real, NodePath.resolve(root)) || isUnder(candidate, NodePath.resolve(root)),
  );
  if (inside !== undefined) {
    return {
      refused: `${real} is inside ${inside}, where a repository or a build could have put it`,
    };
  }
  if (inProjectNodeModules(real) || inProjectNodeModules(candidate)) {
    return { refused: `${real} is inside a node_modules folder` };
  }
  return { vetted: { path: candidate, real } };
}

/** Whether a file starts with ELF or Mach-O magic: a script is never run, its shebang never followed. */
async function isNativeBinary(path: string): Promise<boolean> {
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | O_NONBLOCK | O_NOCTTY);
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    if (bytesRead < 4) return false;
    const magic = buffer.readUInt32BE(0);
    return [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const FIRST_VERSION = /\d{1,4}(?:\.\d{1,4}){0,2}/;

/** The first version number in a program's output. */
function firstVersion(text: string): ReadonlyArray<number> | null {
  const match = FIRST_VERSION.exec(text.slice(0, 4096));
  return match === null ? null : match[0].split(".").map(Number);
}

const compareVersions = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** Parsed JSON, or undefined when malformed or nested past the stack. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `object.a.b`, own keys only, as capped text. */
function ownText(value: unknown, keys: ReadonlyArray<string>): string | null {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current.slice(0, FIELD_CHARS) : null;
}

/**
 * The major version a repository file asks for, parsed by t3o: the first `\d{1,4}` of the field
 * the format names. A malformed file or an alias (`lts/*`) is a warning, never a guess.
 */
export function requiredMajor(
  fileName: string,
  text: string,
  command: string,
): { readonly major: number } | { readonly warning: string } {
  const base = NodePath.posix.basename(fileName);
  let field: string | null;
  const json = (keys: ReadonlyArray<string>) => ownText(parseJson(text), keys);
  switch (base) {
    case "package.json":
      field = json(["engines", command]);
      break;
    case "composer.json":
      field = json(["require", "php"]);
      break;
    case "global.json":
      field = json(["sdk", "version"]);
      break;
    case "pyproject.toml":
      field =
        /^[ \t]*requires-python[ \t]*=[ \t]*["']([^"'\n]{0,256})["']/m.exec(text)?.[1] ?? null;
      break;
    case "go.mod":
      field =
        /^[ \t]*go[ \t]+(\d{1,4}(?:\.\d{1,4}){0,2})/m.exec(text)?.[1] ??
        /^[ \t]*toolchain[ \t]+go(\d{1,4}(?:\.\d{1,4}){0,2})/m.exec(text)?.[1] ??
        null;
      break;
    default:
      field = text.split("\n", 1)[0]?.trim().slice(0, FIELD_CHARS) ?? null;
  }
  if (field === null || field === "") return { warning: `${fileName} names no ${command} version` };
  const match = /\d{1,4}/.exec(field);
  if (match === null) {
    return { warning: `${fileName} names ${clip(field)}, an alias t3o doesn't compare` };
  }
  return { major: Number(match[0]) };
}

/** `channel` from a `rust-toolchain.toml`, or the whole of a legacy `rust-toolchain` file. */
export function rustChannel(text: string): string | null {
  const toml = /^[ \t]*channel[ \t]*=[ \t]*["']([^"'\n]{1,256})["']/m.exec(text);
  const channel = toml !== null ? toml[1]! : text.trim();
  return BOARD_READINESS_NAME.test(channel) ? channel : null;
}

/** On every git call a check makes: no hook runs, and only https and ssh transports are used. */
export const READINESS_GIT_GUARD = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.ssh.allow=always",
] as const;

/** The git argv each probe runs. */
function gitProbeArgs(
  probe: "identity-name" | "identity-email" | "fetch" | "remote-url",
  checkout: string,
  remote: string,
): ReadonlyArray<string> {
  const base = ["-C", checkout, ...READINESS_GIT_GUARD];
  switch (probe) {
    case "identity-name":
      return [...base, "config", "--global", "--includes", "user.name"];
    case "identity-email":
      return [...base, "config", "--global", "--includes", "user.email"];
    case "fetch":
      return [...base, "ls-remote", "--exit-code", remote, "HEAD"];
    case "remote-url":
      return [...base, "remote", "get-url", remote];
  }
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** `owner/repo` of a github.com remote URL, validated; null for any other host. */
export function githubRepository(url: string): string | null {
  const match =
    /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (match === null) return null;
  const [, owner, repo] = match;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner!)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo!) || repo === "." || repo === "..") return null;
  return `${owner}/${repo}`;
}

/** Credentials in a URL never reach the output. */
const redactCredentials = (text: string) => text.replace(/(\w+:\/\/)[^@/\s]+@/g, "$1***@");

type Outcome = { readonly status: ReadinessCheckStatus; readonly detail: string };
const pass = (detail: string): Outcome => ({ status: "pass", detail });
const fail = (detail: string): Outcome => ({ status: "fail", detail });
const warning = (detail: string): Outcome => ({ status: "warn", detail });

const SPAWNING_KINDS = new Set(["rustToolchain", "docker", "git", "gh"]);

/**
 * Run each check in order, every one, with no short-circuit. Checks share `budgetMs` (the
 * project's `timeoutSeconds`); past the 50th they are reported as not run. A failing check marked
 * `warn` is a warning.
 */
export const runReadinessChecks = Effect.fn("Readiness.runChecks")(function* (input: {
  readonly checks: ReadonlyArray<BoardReadinessCheck>;
  readonly host: ReadinessCheckHost;
  readonly repo: ReadinessRepo;
  readonly budgetMs: number;
}) {
  const { host, repo } = input;
  const forbidden = yield* host.forbiddenRoots;
  const deadline = (yield* Clock.currentTimeMillis) + input.budgetMs;
  const promise = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);

  /** The first native, vetted binary called `name`; a reason when there is none. */
  const findTool = Effect.fn("Readiness.findTool")(function* (name: string) {
    const candidates = yield* promise(() => commandCandidates(name, host));
    if (candidates.length === 0) return { error: `${name} not found on PATH` } as const;
    let reason = "";
    for (const candidate of candidates) {
      const vetted = yield* promise(() => vetBinary(candidate, host, forbidden));
      if ("refused" in vetted) {
        reason = `refused ${vetted.refused}`;
        continue;
      }
      if (!(yield* promise(() => isNativeBinary(vetted.vetted.real)))) {
        reason = `${vetted.vetted.real} is a script, which t3o never runs`;
        continue;
      }
      return { tool: vetted.vetted } as const;
    }
    return { error: reason } as const;
  });

  const run = Effect.fn("Readiness.run")(function* (
    tool: Vetted,
    argv0: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
    options: { readonly gh: boolean } = { gh: false },
  ) {
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) {
      return { exitCode: null, stdout: "", stderr: "", timedOut: true } satisfies ReadinessRun;
    }
    return yield* host.run({
      path: tool.path,
      argv0,
      args,
      env: readinessEnv(host.env, options),
      timeoutMs: Math.min(timeoutMs, remaining),
    });
  });

  const checkCommand = Effect.fn("Readiness.checkCommand")(function* (
    check: BoardReadinessCheck,
  ): Effect.fn.Return<Outcome> {
    const name = check.command!;
    if (!BOARD_READINESS_NAME.test(name)) return fail("not a command name");
    const candidates = yield* promise(() => commandCandidates(name, host));
    if (candidates.length === 0) return fail(`${name} not found on PATH`);
    const vetted: Vetted[] = [];
    let refused = "";
    for (const candidate of candidates) {
      const result = yield* promise(() => vetBinary(candidate, host, forbidden));
      if ("vetted" in result) vetted.push(result.vetted);
      else refused = `refused ${result.refused}`;
    }
    if (vetted.length === 0) return fail(refused);
    if (check.version === undefined) return pass(vetted[0]!.path);
    const args = BOARD_READINESS_VERSION_ARGS[name];
    if (args === undefined) {
      return warning(`version not checked: t3o doesn't know how to ask ${name}`);
    }
    if (host.platform === "win32") {
      return { status: "skipped", detail: "version checks are unsupported on Windows workers" };
    }
    let want: ReadonlyArray<number>;
    let wantText: string;
    if (check.version.atLeast !== undefined) {
      want = firstVersion(check.version.atLeast) ?? [0];
      wantText = check.version.atLeast;
    } else {
      const from = check.version.from!;
      const text = yield* repo.file(from);
      if (text === null) return fail(`${from} is not on the default branch`);
      const required = requiredMajor(from, text, name);
      if ("warning" in required) return warning(required.warning);
      want = [required.major];
      wantText = `${required.major} (from ${from})`;
    }
    const native: Vetted[] = [];
    for (const tool of vetted) {
      if (yield* promise(() => isNativeBinary(tool.real))) native.push(tool);
    }
    if (native.length === 0) {
      return warning(`version not checked for script tools (${vetted[0]!.real})`);
    }
    let last = "";
    for (const tool of native) {
      const ran = yield* run(tool, name, args, VERSION_TIMEOUT_MS);
      const have = ran.exitCode === 0 ? firstVersion(`${ran.stdout}\n${ran.stderr}`) : null;
      if (have === null) {
        last = `${name} ${args.join(" ")}: ${ran.exitCode === 0 ? "no version printed" : lastLine(ran)}`;
        continue;
      }
      const haveText = have.join(".");
      const ok =
        check.version.atLeast !== undefined
          ? compareVersions(have, want) >= 0
          : (have[0] ?? 0) >= want[0]!;
      if (ok) return pass(`${haveText} at ${tool.path}`);
      last = `${haveText} at ${tool.path}; needs ${wantText} or later`;
    }
    return fail(last);
  });

  const checkOne = Effect.fn("Readiness.checkOne")(function* (
    check: BoardReadinessCheck,
  ): Effect.fn.Return<Outcome> {
    const kind = boardReadinessCheckKind(check);
    if (kind === null) return fail("not a check this worker knows");
    if (check.os !== undefined && !(check.os as ReadonlyArray<string>).includes(host.platform)) {
      return { status: "skipped", detail: `not for ${host.platform}` };
    }
    if (check.arch !== undefined && !(check.arch as ReadonlyArray<string>).includes(host.arch)) {
      return { status: "skipped", detail: `not for ${host.arch}` };
    }
    if (host.platform === "win32" && SPAWNING_KINDS.has(kind)) {
      return { status: "skipped", detail: "unsupported on Windows workers" };
    }
    switch (kind) {
      case "command":
        return yield* checkCommand(check);
      case "rustToolchain": {
        const file = check.rustToolchain!;
        const text = yield* repo.file(file);
        if (text === null) return fail(`${file} is not on the default branch`);
        const channel = rustChannel(text);
        if (channel === null) return warning(`${file} names no usable channel`);
        const rustup = yield* findTool("rustup");
        if ("error" in rustup) return fail(rustup.error);
        const ran = yield* run(rustup.tool, "rustup", ["toolchain", "list"], LOCAL_TIMEOUT_MS);
        if (ran.exitCode !== 0) return fail(`rustup toolchain list: ${lastLine(ran)}`);
        const installed = ran.stdout
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0] ?? "")
          .some((name) => name === channel || name.startsWith(`${channel}-`));
        return installed
          ? pass(`${channel} installed`)
          : fail(`toolchain ${channel} is not installed`);
      }
      case "cargoConfig": {
        const cargoHome = host.env.CARGO_HOME;
        const path =
          cargoHome !== undefined && NodePath.isAbsolute(cargoHome)
            ? NodePath.join(cargoHome, "config.toml")
            : NodePath.join(host.home, ".cargo/config.toml");
        const read = yield* promise(() => readMachineFile(path, host));
        if ("missing" in read) return fail(`${path} not found`);
        if ("error" in read) return fail(read.error);
        const wanted = check.cargoConfig!.contains;
        const found = read.text
          .split("\n")
          .filter((line) => !/token|password|secret|credential|auth/i.test(line.split("=")[0]!))
          .some((line) => line.includes(wanted));
        return found ? pass(`${path} contains it`) : fail(`${path} doesn't contain it`);
      }
      case "exists": {
        const expanded = expandMachinePath(check.exists!, host);
        if ("error" in expanded) return fail(expanded.error);
        let paths: ReadonlyArray<string>;
        if (expanded.path.includes("*")) {
          const globbed = yield* promise(() => expandReadinessGlob(expanded.path, host));
          if ("error" in globbed) return fail(globbed.error);
          paths = globbed.matches;
        } else paths = [expanded.path];
        let reason = `nothing at ${check.exists!}`;
        for (const path of paths) {
          const confined = yield* promise(() => confineMachinePath(path, host));
          if ("error" in confined) {
            reason = confined.error;
            continue;
          }
          const stat = yield* promise(() => NodeFSP.stat(confined.real).catch(() => null));
          if (stat === null) continue;
          if (check.maxAgeHours !== undefined) {
            const ageHours = ((yield* Clock.currentTimeMillis) - stat.mtimeMs) / 3_600_000;
            if (ageHours > check.maxAgeHours) {
              reason = `${path} is ${Math.floor(ageHours)} hours old; at most ${check.maxAgeHours}`;
              continue;
            }
          }
          return pass(path);
        }
        return fail(reason);
      }
      case "env": {
        const value = host.env[check.env!];
        return value !== undefined && value !== ""
          ? pass(`$${check.env!} is set`)
          : fail(`$${check.env!} is not set`);
      }
      case "docker":
        return yield* checkDocker(check.docker!);
      case "git":
        return yield* checkGit(check.git!);
      case "gh": {
        const host_ = check.gh!;
        const gh = yield* findTool("gh");
        if ("error" in gh) return fail(gh.error);
        const ran = yield* run(
          gh.tool,
          "gh",
          ["auth", "status", "--hostname", host_],
          LOCAL_TIMEOUT_MS,
          {
            gh: true,
          },
        );
        return ran.exitCode === 0
          ? pass(`signed in to ${host_}`)
          : fail(`not signed in to ${host_}`);
      }
      case "writable": {
        const expanded = expandMachinePath(check.writable!, host);
        if ("error" in expanded) return fail(expanded.error);
        const confined = yield* promise(() => confineMachinePath(expanded.path, host));
        if ("error" in confined) return fail(confined.error);
        const ok = yield* promise(() =>
          NodeFSP.access(confined.real, NodeFS.constants.W_OK).then(
            () => true,
            () => false,
          ),
        );
        return ok ? pass(`${expanded.path} is writable`) : fail(`${expanded.path} is not writable`);
      }
    }
  });

  const checkDocker = Effect.fn("Readiness.checkDocker")(function* (
    want: NonNullable<BoardReadinessCheck["docker"]>,
  ): Effect.fn.Return<Outcome> {
    const docker = yield* findTool("docker");
    if ("error" in docker) return fail(docker.error);
    const ran = yield* run(
      docker.tool,
      "docker",
      ["info", "--format", "{{json .}}"],
      DOCKER_TIMEOUT_MS,
    );
    const info = parseJson(ran.stdout);
    if (!isRecord(info)) return fail(`docker info: ${lastLine(ran)}`);
    const errors = Array.isArray(info.ServerErrors) ? info.ServerErrors : [];
    const serverVersion = ownText(info, ["ServerVersion"]);
    if (errors.length > 0 || serverVersion === null || serverVersion === "") {
      return fail(
        `the docker daemon isn't answering${errors.length > 0 ? `: ${clip(String(errors[0]))}` : ""}`,
      );
    }
    const pluginList =
      isRecord(info.ClientInfo) && Array.isArray(info.ClientInfo.Plugins)
        ? info.ClientInfo.Plugins
        : [];
    const present = new Set(
      pluginList.flatMap((plugin) => {
        const name = ownText(plugin, ["Name"]);
        return name === null ? [] : [name];
      }),
    );
    const missing = want.plugins.filter((plugin) => !present.has(plugin));
    if (missing.length > 0) return fail(`missing docker ${missing.join(", ")}`);
    const registries = want.loggedIn ?? [];
    if (registries.length === 0) {
      return pass(["daemon answers", ...want.plugins].join(", "));
    }
    const configDir = host.env.DOCKER_CONFIG;
    const configPath =
      configDir !== undefined && NodePath.isAbsolute(configDir)
        ? NodePath.join(configDir, "config.json")
        : NodePath.join(host.home, ".docker/config.json");
    const read = yield* promise(() => readMachineFile(configPath, host));
    if ("error" in read) return fail(read.error);
    const config = "text" in read ? parseJson(read.text) : null;
    if (config === undefined) return fail(`${configPath} is not JSON`);
    // Only keys are read: a value may hold a credential.
    const hostOf = (key: string) =>
      key
        .replace(/^[a-z]+:\/\//i, "")
        .split("/")[0]!
        .toLowerCase();
    const known = new Set(
      (["auths", "credHelpers"] as const).flatMap((section) =>
        isRecord(config) && Object.hasOwn(config, section) && isRecord(config[section])
          ? Object.keys(config[section]).map(hostOf)
          : [],
      ),
    );
    const notLoggedIn = registries.filter((registry) => !known.has(registry));
    if (notLoggedIn.length === 0)
      return pass(`daemon answers; logged in to ${registries.join(", ")}`);
    if (isRecord(config) && Object.hasOwn(config, "credsStore")) {
      return warning(
        `can't tell whether you are logged in to ${notLoggedIn.join(", ")}: the credential store keeps no per-registry entry`,
      );
    }
    return fail(`not logged in to ${notLoggedIn.join(", ")}`);
  });

  const checkGit = Effect.fn("Readiness.checkGit")(function* (
    probe: NonNullable<BoardReadinessCheck["git"]>,
  ): Effect.fn.Return<Outcome> {
    const git = yield* findTool("git");
    if ("error" in git) return fail(git.error);
    if (probe === "identity") {
      const name = yield* run(
        git.tool,
        "git",
        gitProbeArgs("identity-name", repo.checkout, ""),
        LOCAL_TIMEOUT_MS,
      );
      const email = yield* run(
        git.tool,
        "git",
        gitProbeArgs("identity-email", repo.checkout, ""),
        LOCAL_TIMEOUT_MS,
      );
      const unset = [
        name.exitCode === 0 && name.stdout.trim() !== "" ? null : "user.name",
        email.exitCode === 0 && email.stdout.trim() !== "" ? null : "user.email",
      ].filter((entry) => entry !== null);
      return unset.length === 0
        ? pass("user.name and user.email set")
        : fail(`${unset.join(" and ")} not set; card commits would fail`);
    }
    const remote = yield* repo.remote;
    if (remote === null || !REMOTE_NAME.test(remote))
      return fail("the checkout has no usable remote");
    if (probe === "fetch") {
      const ran = yield* run(
        git.tool,
        "git",
        gitProbeArgs("fetch", repo.checkout, remote),
        NETWORK_TIMEOUT_MS,
      );
      return ran.exitCode === 0
        ? pass(`${remote} answers without a prompt`)
        : fail(`${remote}: ${redactCredentials(lastLine(ran))}`);
    }
    const url = yield* run(
      git.tool,
      "git",
      gitProbeArgs("remote-url", repo.checkout, remote),
      LOCAL_TIMEOUT_MS,
    );
    if (url.exitCode !== 0) return fail(`${remote} has no URL`);
    const repository = githubRepository(url.stdout);
    if (repository === null)
      return warning(`can't check push access to ${remote}: not a github.com remote`);
    const gh = yield* findTool("gh");
    if ("error" in gh) return warning(`can't check push access without gh: ${gh.error}`);
    const ran = yield* run(
      gh.tool,
      "gh",
      ["api", `repos/${repository}`, "--jq", ".permissions.push"],
      NETWORK_TIMEOUT_MS,
      { gh: true },
    );
    if (ran.exitCode !== 0) return fail(`gh api repos/${repository}: ${lastLine(ran)}`);
    return ran.stdout.trim() === "true"
      ? pass(`push access to ${repository}`)
      : fail(`no push access to ${repository}`);
  });

  const results: ReadinessCheckResult[] = [];
  for (const [index, check] of input.checks.entries()) {
    const label = clip(boardReadinessCheckLabel(check));
    if (index >= BOARD_READINESS_MAX_CHECKS) {
      results.push({
        label,
        status: "skipped",
        detail: `not run: a project may have at most ${BOARD_READINESS_MAX_CHECKS} checks`,
      });
      continue;
    }
    const outcome: Outcome =
      (yield* Clock.currentTimeMillis) >= deadline
        ? fail("not run: the project's readiness timeout ran out")
        : yield* checkOne(check).pipe(
            Effect.catchCause(() => Effect.succeed(fail("the check failed to run"))),
          );
    const status = outcome.status === "fail" && check.warn === true ? "warn" : outcome.status;
    results.push({
      label,
      status,
      detail: clip(outcome.detail),
      ...(status === "pass" || status === "skipped" || check.fix === undefined
        ? {}
        : { fix: stripBoardReadinessText(check.fix, { max: DETAIL_CHARS }) }),
    });
  }
  return results;
});

const STATUS_TEXT: Record<ReadinessCheckStatus, string> = {
  pass: "pass",
  fail: "FAIL",
  warn: "warn",
  skipped: "skip",
};

/** The checks as the readiness viewer shows them. */
export function formatReadinessChecks(results: ReadonlyArray<ReadinessCheckResult>): string {
  return results
    .map((result) =>
      [
        `${STATUS_TEXT[result.status]}  ${result.label}: ${result.detail}`,
        ...(result.fix === undefined ? [] : [`      fix suggested by the project: ${result.fix}`]),
      ].join("\n"),
    )
    .join("\n");
}
