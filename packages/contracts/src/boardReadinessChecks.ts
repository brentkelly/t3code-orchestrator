/**
 * T3o: declarative readiness checks (T3O-124). No string from `t3o.json` picks the program, its
 * argv, or what is read beyond allowlisted shapes. Rejected kinds and why: docs/user/board-workers.md
 * ("Kinds T3o will not add") — read it before adding one.
 */
import * as Schema from "effect/Schema";

const BOARD_READINESS_GIT_PROBES = ["identity", "fetch", "push"] as const;
export type BoardReadinessGitProbe = (typeof BOARD_READINESS_GIT_PROBES)[number];
const BOARD_READINESS_OS = ["linux", "darwin", "win32"] as const;
const BOARD_READINESS_ARCH = ["x64", "arm64"] as const;

/** One check, stored and sent normalized: exactly one kind key, plus the common fields. */
export const BoardReadinessCheck = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  fix: Schema.optionalKey(Schema.String),
  warn: Schema.optionalKey(Schema.Boolean),
  os: Schema.optionalKey(Schema.Array(Schema.Literals(BOARD_READINESS_OS))),
  arch: Schema.optionalKey(Schema.Array(Schema.Literals(BOARD_READINESS_ARCH))),
  command: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(
    Schema.Struct({
      atLeast: Schema.optionalKey(Schema.String),
      from: Schema.optionalKey(Schema.String),
    }),
  ),
  rustToolchain: Schema.optionalKey(Schema.String),
  cargoConfig: Schema.optionalKey(Schema.Struct({ contains: Schema.String })),
  exists: Schema.optionalKey(Schema.String),
  maxAgeHours: Schema.optionalKey(Schema.Finite),
  env: Schema.optionalKey(Schema.String),
  docker: Schema.optionalKey(
    Schema.Struct({
      plugins: Schema.Array(Schema.String),
      loggedIn: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  git: Schema.optionalKey(Schema.Literals(BOARD_READINESS_GIT_PROBES)),
  gh: Schema.optionalKey(Schema.String),
  writable: Schema.optionalKey(Schema.String),
});
export type BoardReadinessCheck = typeof BoardReadinessCheck.Type;

// Rejected, never to be added without redoing that analysis: arbitrary argv, network probes, cloud
// and Kubernetes auth, package-manager queries, gradle/mvn/sdkmanager/simctl, resource checks,
// /proc and sysctl reads, free-path `contains`. Deferred: pkgConfig, listening (loopback only).
const BOARD_READINESS_CHECK_KINDS = [
  "command",
  "rustToolchain",
  "cargoConfig",
  "exists",
  "env",
  "docker",
  "git",
  "gh",
  "writable",
] as const;
export type BoardReadinessCheckKind = (typeof BOARD_READINESS_CHECK_KINDS)[number];

const COMMON_KEYS = ["name", "fix", "warn", "os", "arch"] as const;
const KIND_EXTRA_KEYS: Readonly<Record<BoardReadinessCheckKind, ReadonlyArray<string>>> = {
  command: ["version"],
  rustToolchain: [],
  cargoConfig: [],
  exists: ["maxAgeHours"],
  env: [],
  docker: [],
  git: [],
  gh: [],
  writable: [],
};

/** At most this many checks run per project; the rest are reported as not run. */
export const BOARD_READINESS_MAX_CHECKS = 50;
/** `timeoutSeconds` is clamped to this: Node timers misfire above 2^31 ms. */
export const BOARD_READINESS_MAX_TIMEOUT_SECONDS = 600;
const PROJECT_TEXT_CHARS = 200;

/**
 * Commands whose version t3o asks, and the fixed argv it asks with. A `version` on any other
 * command is refused: the argv would be a guess, and a guess runs project-chosen code paths.
 */
export const BOARD_READINESS_VERSION_ARGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  ...Object.fromEntries(
    [
      "node",
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "deno",
      "cmake",
      "make",
      "gcc",
      "clang",
      "git",
      "docker",
      "gh",
      "python3",
    ].map((name) => [name, ["--version"]]),
  ),
  go: ["version"],
  java: ["-version"],
  ruby: ["-v"],
  php: ["-v"],
  dotnet: ["--list-sdks"],
  rustc: ["-V"],
  cargo: ["-V"],
  xcodebuild: ["-version"],
};

/** Repository files `version.from` can name, by file name: t3o parses each itself. */
const BOARD_READINESS_VERSION_FILES = [
  ".node-version",
  ".nvmrc",
  "package.json",
  ".python-version",
  "pyproject.toml",
  "go.mod",
  ".ruby-version",
  ".java-version",
  "composer.json",
  "global.json",
] as const;
const RUST_TOOLCHAIN_FILES = ["rust-toolchain.toml", "rust-toolchain"];

/** `$<VAR>/…` prefixes a machine path may start with, besides `~`, `$HOME` and `$TMPDIR`. */
const BOARD_READINESS_PATH_VARS = [
  "HOME",
  "TMPDIR",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "JAVA_HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;
const isPathVar = (name: string) =>
  (BOARD_READINESS_PATH_VARS as ReadonlyArray<string>).includes(name) || /^XDG_[A-Z_]+$/.test(name);

/**
 * Project-written text as the board shows it: ANSI and control characters gone, at most `max`
 * characters. Program output goes through the same, with line breaks kept.
 */
export function stripBoardReadinessText(
  text: string,
  options: { readonly max?: number; readonly keepLines?: boolean } = {},
): string {
  const stripped = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g, "")
    .replace(
      options.keepLines === true ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g,
      " ",
    );
  return options.max === undefined ? stripped : stripped.slice(0, options.max);
}

export function boardReadinessCheckKind(
  check: BoardReadinessCheck,
): BoardReadinessCheckKind | null {
  return BOARD_READINESS_CHECK_KINDS.find((kind) => check[kind] !== undefined) ?? null;
}

/** What a check is called in results: its `name`, else what it checks. */
export function boardReadinessCheckLabel(check: BoardReadinessCheck): string {
  if (check.name !== undefined && check.name.trim() !== "") return check.name.trim();
  switch (boardReadinessCheckKind(check)) {
    case "command":
      return check.command!;
    case "rustToolchain":
      return "rust toolchain";
    case "cargoConfig":
      return "cargo config";
    case "exists":
      return check.exists!;
    case "env":
      return `$${check.env!}`;
    case "docker":
      return "docker";
    case "git":
      return `git ${check.git!}`;
    case "gh":
      return `gh ${check.gh!}`;
    case "writable":
      return `writable ${check.writable!}`;
    case null:
      return "check";
  }
}

/**
 * A machine path a check may name: absolute, `~/…`, or `$<VAR>/…` for the allowlisted variables.
 * No `..`, no backslash, no repository-relative path. `*` only where `glob` allows it: within one
 * segment, at most two wildcard segments, never `**`, and never directly under `~` (the first
 * wildcard at least two segments below it). Null when unusable.
 */
function classifyBoardReadinessMachinePath(
  path: string,
  options: { readonly glob: boolean },
): string | null {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.includes("\\") || trimmed.includes("**")) return null;
  if (/[\x00-\x1f]/.test(trimmed)) return null;
  const segments = trimmed.split("/");
  const head = segments[0]!;
  const fromHome = head === "~" || head === "$HOME";
  if (!(head === "" || fromHome || (head.startsWith("$") && isPathVar(head.slice(1))))) {
    return null;
  }
  if (segments.some((segment) => segment === "..")) return null;
  const wildcards = segments.flatMap((segment, index) => (segment.includes("*") ? [index] : []));
  if (wildcards.length > 0) {
    if (!options.glob || wildcards.length > 2) return null;
    if (fromHome && wildcards[0]! < 2) return null;
    if (head === "" && wildcards[0]! < 2) return null;
  }
  return trimmed;
}

/** A repository file (`version.from`, `rustToolchain`): relative, inside, normalized. */
function repoFile(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  if (/[\x00-\x1f*]/.test(trimmed) || trimmed.startsWith("~") || trimmed.startsWith("$")) {
    return null;
  }
  const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

/** Names t3o resolves or passes on: never a leading `-`, never a slash. */
export const BOARD_READINESS_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const VERSION_NUMBER = /^\d{1,4}(\.\d{1,4}){0,3}$/;
const DOCKER_PLUGIN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOSTNAME = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One `t3o.json` check, normalized, or null with a warning. Unknown fields warn and drop. */
function decodeCheck(raw: unknown, where: string, warnings: string[]): BoardReadinessCheck | null {
  if (!isRecord(raw)) {
    warnings.push(`${where}: expected an object; ignored.`);
    return null;
  }
  const kinds = BOARD_READINESS_CHECK_KINDS.filter((kind) => raw[kind] !== undefined);
  if (kinds.length === 0) {
    warnings.push(`${where}: not a check this board knows; ignored.`);
    return null;
  }
  if (kinds.length > 1) {
    warnings.push(`${where}: names more than one check (${kinds.join(", ")}); ignored.`);
    return null;
  }
  const kind = kinds[0]!;
  const allowed = new Set<string>([...COMMON_KEYS, kind, ...KIND_EXTRA_KEYS[kind]]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`${where}.${key}: not a field of this check; ignored.`);
  }
  const bad = (field: string, why: string) => {
    warnings.push(`${where}.${field}: ${why}; check ignored.`);
    return null;
  };
  const out: Record<string, unknown> = {};
  for (const field of ["name", "fix"] as const) {
    if (raw[field] === undefined) continue;
    const text =
      typeof raw[field] === "string"
        ? stripBoardReadinessText(raw[field], { max: PROJECT_TEXT_CHARS }).trim()
        : "";
    if (text !== "") out[field] = text;
    else warnings.push(`${where}.${field}: expected text; ignored.`);
  }
  if (raw.warn !== undefined) {
    if (typeof raw.warn === "boolean") {
      if (raw.warn) out.warn = true;
    } else warnings.push(`${where}.warn: expected true or false; ignored.`);
  }
  for (const [field, values] of [
    ["os", BOARD_READINESS_OS],
    ["arch", BOARD_READINESS_ARCH],
  ] as const) {
    if (raw[field] === undefined) continue;
    const list = raw[field];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.some((entry) => !(values as ReadonlyArray<unknown>).includes(entry))
    ) {
      return bad(field, `expected a list of ${values.join(", ")}`);
    }
    out[field] = [...new Set(list)];
  }
  const value = raw[kind];
  switch (kind) {
    case "command": {
      if (typeof value !== "string" || !BOARD_READINESS_NAME.test(value)) {
        return bad("command", "expected a command name with no slash");
      }
      out.command = value;
      if (raw.version === undefined) break;
      const version = raw.version;
      if (!isRecord(version)) return bad("version", "expected { atLeast } or { from }");
      if (BOARD_READINESS_VERSION_ARGS[value] === undefined) {
        warnings.push(
          `${where}.version: t3o doesn't know how to ask ${value} its version; only that it is installed is checked.`,
        );
        break;
      }
      const hasAtLeast = version.atLeast !== undefined;
      const hasFrom = version.from !== undefined;
      if (hasAtLeast === hasFrom) return bad("version", "needs exactly one of atLeast or from");
      if (hasAtLeast) {
        const atLeast =
          typeof version.atLeast === "number" ? String(version.atLeast) : version.atLeast;
        if (typeof atLeast !== "string" || !VERSION_NUMBER.test(atLeast)) {
          return bad("version.atLeast", "expected a version like 10 or 1.2.3");
        }
        out.version = { atLeast };
        break;
      }
      const from = typeof version.from === "string" ? repoFile(version.from) : null;
      const fileName = from?.split("/").at(-1) ?? "";
      if (
        from === null ||
        !(BOARD_READINESS_VERSION_FILES as ReadonlyArray<string>).includes(fileName)
      ) {
        return bad(
          "version.from",
          `must be a repository file named one of ${BOARD_READINESS_VERSION_FILES.join(", ")}`,
        );
      }
      out.version = { from };
      break;
    }
    case "rustToolchain": {
      const path = typeof value === "string" ? repoFile(value) : null;
      if (path === null || !RUST_TOOLCHAIN_FILES.includes(path.split("/").at(-1)!)) {
        return bad(
          "rustToolchain",
          "must be the repository's rust-toolchain.toml or rust-toolchain",
        );
      }
      out.rustToolchain = path;
      break;
    }
    case "cargoConfig": {
      if (!isRecord(value) || typeof value.contains !== "string" || value.contains === "") {
        return bad("cargoConfig", "expected { contains: text }");
      }
      if (value.contains.length > 256 || value.contains.includes("\n")) {
        return bad("cargoConfig.contains", "expected one line of at most 256 characters");
      }
      out.cargoConfig = { contains: value.contains };
      break;
    }
    case "exists": {
      const path =
        typeof value === "string" ? classifyBoardReadinessMachinePath(value, { glob: true }) : null;
      if (path === null) {
        return bad(
          "exists",
          "must be absolute, ~/…, or $VAR/… for an allowed variable, with no .. and at most two * folders, not directly under ~",
        );
      }
      out.exists = path;
      if (raw.maxAgeHours !== undefined) {
        if (typeof raw.maxAgeHours !== "number" || !(raw.maxAgeHours > 0)) {
          return bad("maxAgeHours", "expected a positive number of hours");
        }
        out.maxAgeHours = raw.maxAgeHours;
      }
      break;
    }
    case "env": {
      if (typeof value !== "string" || !ENV_NAME.test(value)) {
        return bad("env", "expected an environment variable name");
      }
      out.env = value;
      break;
    }
    case "docker": {
      if (value === true) {
        out.docker = { plugins: [] };
        break;
      }
      if (!isRecord(value)) return bad("docker", "expected true or { plugins, loggedIn }");
      for (const key of Object.keys(value)) {
        if (key !== "plugins" && key !== "loggedIn") {
          warnings.push(`${where}.docker.${key}: not a field of this check; ignored.`);
        }
      }
      const plugins = value.plugins ?? [];
      if (
        !Array.isArray(plugins) ||
        plugins.some((p) => typeof p !== "string" || !DOCKER_PLUGIN.test(p))
      ) {
        return bad("docker.plugins", "expected plugin names like compose");
      }
      const loggedIn = value.loggedIn ?? [];
      if (
        !Array.isArray(loggedIn) ||
        loggedIn.some((host) => typeof host !== "string" || !HOSTNAME.test(host))
      ) {
        return bad("docker.loggedIn", "expected registry host names like ghcr.io");
      }
      out.docker = {
        plugins: plugins as string[],
        ...(loggedIn.length === 0 ? {} : { loggedIn: loggedIn as string[] }),
      };
      break;
    }
    case "git": {
      if (!(BOARD_READINESS_GIT_PROBES as ReadonlyArray<unknown>).includes(value)) {
        return bad("git", `expected one of ${BOARD_READINESS_GIT_PROBES.join(", ")}`);
      }
      out.git = value;
      break;
    }
    case "gh": {
      if (typeof value !== "string" || !HOSTNAME.test(value)) {
        return bad("gh", "expected a lower-case host name");
      }
      out.gh = value;
      break;
    }
    case "writable": {
      const path =
        typeof value === "string"
          ? classifyBoardReadinessMachinePath(value, { glob: false })
          : null;
      if (path === null) {
        return bad("writable", "must be absolute, ~/…, or $VAR/… for an allowed variable");
      }
      out.writable = path;
      break;
    }
  }
  return out as BoardReadinessCheck;
}

/** `resources.readiness.checks` from a `t3o.json`: bad or unknown entries warn and drop. */
export function decodeBoardReadinessChecks(
  value: unknown,
  where: string,
  warnings: string[],
): ReadonlyArray<BoardReadinessCheck> {
  if (!Array.isArray(value)) {
    warnings.push(`${where}: expected a list of checks; ignored.`);
    return [];
  }
  const checks = value.flatMap((entry, index) => {
    const check = decodeCheck(entry, `${where}[${index}]`, warnings);
    return check === null ? [] : [check];
  });
  if (checks.length > BOARD_READINESS_MAX_CHECKS) {
    warnings.push(
      `${where}: more than ${BOARD_READINESS_MAX_CHECKS} checks; the rest are reported as not run.`,
    );
  }
  return checks;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * What a worker's readiness entry is keyed by besides repository and path: the checks it runs and
 * whether the script may run. Board and worker compute it alike, so an edit or a trust change
 * reads as a new entry and is checked at once. No `crypto`: it runs on every client.
 */
export function boardReadinessConfigKey(
  checks: ReadonlyArray<BoardReadinessCheck>,
  runScript: boolean,
): string {
  const text = stableJson(checks);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${runScript ? "script" : "checks"}:${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/** The readiness protocol a worker must report before the board sends it readiness requests. */
export const BOARD_READINESS_PROTOCOL = 2;
