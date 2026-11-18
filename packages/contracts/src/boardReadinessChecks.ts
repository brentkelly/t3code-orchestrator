/**
 * T3o: declarative readiness checks (T3O-124). A project's `t3o.json` names checks that t3o runs
 * itself with fixed arguments, so no project code runs on the hourly readiness timer. A leaf
 * module: `boardCapacity.ts` imports it.
 */
import * as Schema from "effect/Schema";

const BOARD_READINESS_GIT_PROBES = ["identity", "fetch", "push"] as const;
export type BoardReadinessGitProbe = (typeof BOARD_READINESS_GIT_PROBES)[number];

/** One check, stored and sent normalized: exactly one kind key, plus the common fields. */
export const BoardReadinessCheck = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  fix: Schema.optionalKey(Schema.String),
  warn: Schema.optionalKey(Schema.Boolean),
  command: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(
    Schema.Struct({
      atLeast: Schema.optionalKey(Schema.String),
      from: Schema.optionalKey(Schema.String),
    }),
  ),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  rustToolchain: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  contains: Schema.optionalKey(Schema.String),
  exists: Schema.optionalKey(Schema.String),
  docker: Schema.optionalKey(Schema.Struct({ plugins: Schema.Array(Schema.String) })),
  git: Schema.optionalKey(Schema.Literals(BOARD_READINESS_GIT_PROBES)),
  gh: Schema.optionalKey(Schema.String),
  writable: Schema.optionalKey(Schema.String),
});
export type BoardReadinessCheck = typeof BoardReadinessCheck.Type;

const BOARD_READINESS_CHECK_KINDS = [
  "command",
  "rustToolchain",
  "file",
  "exists",
  "docker",
  "git",
  "gh",
  "writable",
] as const;
export type BoardReadinessCheckKind = (typeof BOARD_READINESS_CHECK_KINDS)[number];

const COMMON_KEYS = ["name", "fix", "warn"] as const;
const KIND_EXTRA_KEYS: Readonly<Record<BoardReadinessCheckKind, ReadonlyArray<string>>> = {
  command: ["version", "paths"],
  rustToolchain: [],
  file: ["contains"],
  exists: [],
  docker: [],
  git: [],
  gh: [],
  writable: [],
};

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
    case "file":
      return check.file!;
    case "exists":
      return check.exists!;
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

const MACHINE_PREFIXES = ["~", "$HOME", "$TMPDIR"] as const;

/**
 * A check's path: `machine` (absolute, `~`, `$HOME` or `$TMPDIR`) or `repo` (relative, read from
 * the default branch). `*` stays within one segment of a machine path, and only where `glob`
 * allows it; `**`, `..` and backslashes are refused. Null when unusable.
 */
export function classifyBoardReadinessCheckPath(
  path: string,
  options: { readonly glob: boolean; readonly repo: boolean },
): { readonly kind: "machine" | "repo"; readonly path: string } | null {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed.includes("\\") || trimmed.includes("**")) return null;
  const head = trimmed.split("/")[0]!;
  const machine =
    trimmed.startsWith("/") || (MACHINE_PREFIXES as ReadonlyArray<string>).includes(head);
  const rest = trimmed.split("/").slice(trimmed.startsWith("/") ? 1 : machine ? 1 : 0);
  if (rest.some((segment) => segment === "..")) return null;
  if ((head.startsWith("$") || head.startsWith("~")) && !machine) return null;
  if (/^[A-Za-z]:/.test(trimmed)) return null;
  const globbed = trimmed.includes("*");
  if (machine) {
    if (globbed && !options.glob) return null;
    return { kind: "machine", path: trimmed };
  }
  if (!options.repo || globbed) return null;
  const segments = rest.filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return null;
  return { kind: "repo", path: segments.join("/") };
}

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const VERSION_NUMBER = /^\d+(\.\d+)*$/;
const DOCKER_PLUGIN = /^[a-z0-9][a-z0-9-]*$/;
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

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
  if (raw.name !== undefined) {
    if (typeof raw.name === "string" && raw.name.trim() !== "") out.name = raw.name.trim();
    else warnings.push(`${where}.name: expected text; ignored.`);
  }
  if (raw.fix !== undefined) {
    if (typeof raw.fix === "string" && raw.fix.trim() !== "") out.fix = raw.fix.trim();
    else warnings.push(`${where}.fix: expected text; ignored.`);
  }
  if (raw.warn !== undefined) {
    if (typeof raw.warn === "boolean") {
      if (raw.warn) out.warn = true;
    } else warnings.push(`${where}.warn: expected true or false; ignored.`);
  }
  const value = raw[kind];
  switch (kind) {
    case "command": {
      if (typeof value !== "string" || !COMMAND_NAME.test(value)) {
        return bad("command", "expected a command name with no slash");
      }
      out.command = value;
      if (raw.version !== undefined) {
        const version = raw.version;
        if (!isRecord(version)) return bad("version", "expected { atLeast } or { from }");
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
        } else {
          const from =
            typeof version.from === "string"
              ? classifyBoardReadinessCheckPath(version.from, { glob: false, repo: true })
              : null;
          if (from === null || from.kind !== "repo") {
            return bad("version.from", "must be a file inside the repository");
          }
          out.version = { from: from.path };
        }
      }
      if (raw.paths !== undefined) {
        if (!Array.isArray(raw.paths)) return bad("paths", "expected a list of folders");
        const paths: string[] = [];
        for (const entry of raw.paths) {
          const classified =
            typeof entry === "string"
              ? classifyBoardReadinessCheckPath(entry, { glob: true, repo: false })
              : null;
          if (classified === null) {
            return bad(
              "paths",
              "each must be absolute or start with ~, with * only inside one folder name",
            );
          }
          paths.push(classified.path);
        }
        if (paths.length > 0) out.paths = paths;
      }
      break;
    }
    case "rustToolchain": {
      const path =
        typeof value === "string"
          ? classifyBoardReadinessCheckPath(value, { glob: false, repo: true })
          : null;
      if (path === null || path.kind !== "repo") {
        return bad("rustToolchain", "must be a file inside the repository");
      }
      out.rustToolchain = path.path;
      break;
    }
    case "file": {
      const path =
        typeof value === "string"
          ? classifyBoardReadinessCheckPath(value, { glob: false, repo: true })
          : null;
      if (path === null)
        return bad("file", "must be absolute, ~, $HOME, $TMPDIR or in the repository");
      if (typeof raw.contains !== "string" || raw.contains === "") {
        return bad("contains", "a file check needs the text it must contain");
      }
      out.file = path.path;
      out.contains = raw.contains;
      break;
    }
    case "exists": {
      const path =
        typeof value === "string"
          ? classifyBoardReadinessCheckPath(value, { glob: true, repo: true })
          : null;
      if (path === null) {
        return bad(
          "exists",
          "must be absolute, ~, $HOME, $TMPDIR or in the repository, with * only inside one folder name",
        );
      }
      out.exists = path.path;
      break;
    }
    case "docker": {
      if (value === true) {
        out.docker = { plugins: [] };
        break;
      }
      if (!isRecord(value)) return bad("docker", "expected true or { plugins }");
      const plugins = value.plugins ?? [];
      if (
        !Array.isArray(plugins) ||
        plugins.some((p) => typeof p !== "string" || !DOCKER_PLUGIN.test(p))
      ) {
        return bad("docker.plugins", "expected plugin names like compose");
      }
      out.docker = { plugins: plugins as string[] };
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
      if (typeof value !== "string" || !HOSTNAME.test(value))
        return bad("gh", "expected a host name");
      out.gh = value;
      break;
    }
    case "writable": {
      const path =
        typeof value === "string"
          ? classifyBoardReadinessCheckPath(value, { glob: false, repo: false })
          : null;
      if (path === null) return bad("writable", "must be absolute, ~, $HOME or $TMPDIR");
      out.writable = path.path;
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
  return value.flatMap((entry, index) => {
    const check = decodeCheck(entry, `${where}[${index}]`, warnings);
    return check === null ? [] : [check];
  });
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
