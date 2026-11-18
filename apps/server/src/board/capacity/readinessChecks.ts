// @effect-diagnostics nodeBuiltinImport:off - checks stat, read and write machine paths directly.
/**
 * T3o: a project's declarative readiness checks on this worker (T3O-124). t3o runs only its own
 * code with fixed argv, from an empty folder, so nothing a repository commits chooses the binary
 * that answers. Repository files are read as blobs from the default branch.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  boardReadinessCheckKind,
  boardReadinessCheckLabel,
  classifyBoardReadinessCheckPath,
  type BoardReadinessCheck,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const VERSION_TIMEOUT_MS = 10_000;
const DOCKER_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 10_000;
const MAX_GLOB_MATCHES = 200;
const DETAIL_CHARS = 200;

export interface ReadinessRun {
  /** Null when the process never started or was killed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** What checks need from the machine: a process runner (argv only) and three environment values. */
export interface ReadinessCheckHost {
  readonly run: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly timeoutMs: number;
  }) => Effect.Effect<ReadinessRun>;
  readonly env: { readonly PATH: string; readonly HOME: string; readonly TMPDIR: string };
  /** Folders a binary t3o runs may not resolve inside: checkouts, worktrees, temp, caches. */
  readonly forbiddenRoots: Effect.Effect<ReadonlyArray<string>>;
}

/** The project's checkout and its default branch, for repository files and git probes. */
export interface ReadinessRepo {
  readonly checkout: string;
  readonly file: (path: string) => Effect.Effect<string | null>;
  readonly has: (path: string) => Effect.Effect<boolean>;
}

export interface ReadinessCheckResult {
  readonly label: string;
  readonly status: "pass" | "fail" | "warn";
  readonly detail: string;
  readonly fix?: string;
}

const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, DETAIL_CHARS);
const lastLine = (run: ReadinessRun) =>
  clip(
    (run.timedOut ? "timed out" : `${run.stderr}\n${run.stdout}`)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ?? `exited ${run.exitCode ?? "without a code"}`,
  );

/** A machine path with `~`, `$HOME` and `$TMPDIR` expanded. */
export function expandMachinePath(path: string, env: ReadinessCheckHost["env"]): string {
  const [head, ...rest] = path.split("/");
  const base =
    head === "~" || head === "$HOME" ? env.HOME : head === "$TMPDIR" ? env.TMPDIR : head === "" ? "/" : null;
  return base === null ? path : NodePath.join(base, ...rest);
}

const globRegex = (segment: string) =>
  new RegExp(`^${segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);

/** The paths a pattern matches, `*` staying within one segment. */
export function expandGlob(pattern: string): ReadonlyArray<string> {
  if (!pattern.includes("*")) return NodeFS.existsSync(pattern) ? [pattern] : [];
  const segments = pattern.split("/").filter((segment) => segment !== "");
  let found = [pattern.startsWith("/") ? "/" : "."];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of found) {
      if (!segment.includes("*")) {
        const candidate = NodePath.join(dir, segment);
        if (NodeFS.existsSync(candidate)) next.push(candidate);
        continue;
      }
      let names: string[] = [];
      try {
        names = NodeFS.readdirSync(dir).toSorted();
      } catch {
        continue;
      }
      const regex = globRegex(segment);
      for (const name of names) if (regex.test(name)) next.push(NodePath.join(dir, name));
    }
    found = next.slice(0, MAX_GLOB_MATCHES);
    if (found.length === 0) return [];
  }
  return found;
}

const isExecutableFile = (path: string) => {
  try {
    if (!NodeFS.statSync(path).isFile()) return false;
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** A command on PATH, then in `paths`; null when not found. */
export function resolveCommand(
  name: string,
  paths: ReadonlyArray<string>,
  env: ReadinessCheckHost["env"],
): string | null {
  const dirs = [
    ...env.PATH.split(NodePath.delimiter).filter((dir) => NodePath.isAbsolute(dir)),
    ...paths.flatMap((path) => expandGlob(expandMachinePath(path, env))),
  ];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

const realpath = (path: string) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

/** The forbidden root a binary resolves inside, or null. Both sides through symlinks. */
export function forbiddenRootOf(binary: string, roots: ReadonlyArray<string>): string | null {
  const candidates = [NodePath.resolve(binary), realpath(binary)];
  for (const root of roots) {
    for (const form of new Set([NodePath.resolve(root), realpath(root)])) {
      if (candidates.some((path) => path === form || path.startsWith(form + NodePath.sep))) {
        return root;
      }
    }
  }
  return null;
}

/** The first version number in a tool's `--version` output. */
export function firstVersion(text: string): ReadonlyArray<number> | null {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (match === null) return null;
  return match.slice(1).flatMap((part) => (part === undefined ? [] : [Number(part)]));
}

const compareVersions = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * The major version a repo file asks for: `package.json`'s `engines.<command>`, else the file as
 * plain text (`.node-version`). The lowest major named in a range.
 */
export function requiredMajor(fileName: string, text: string, command: string): number | null {
  let spec = text;
  if (NodePath.basename(fileName) === "package.json") {
    try {
      const engines = (JSON.parse(text) as { engines?: Record<string, unknown> }).engines;
      const value = engines?.[command];
      if (typeof value !== "string") return null;
      spec = value;
    } catch {
      return null;
    }
  }
  const majors = [...spec.matchAll(/(?:^|[^\d.])(\d+)(?:\.\d+|\.x|\.\*)*/g)].map((m) => Number(m[1]));
  return majors.length === 0 ? null : Math.min(...majors);
}

/** `channel` from a `rust-toolchain.toml`, or the whole of a legacy `rust-toolchain` file. */
export function rustChannel(text: string): string | null {
  const toml = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(text);
  if (toml !== null) return toml[1]!;
  const plain = text.trim();
  return plain !== "" && !plain.includes("\n") && !plain.includes("=") ? plain : null;
}

/** The git argv each probe runs: never a hook, never a prompt. */
export function gitProbeArgs(
  probe: "identity-name" | "identity-email" | "fetch" | "push",
  checkout: string,
): ReadonlyArray<string> {
  switch (probe) {
    case "identity-name":
      return ["-C", checkout, "config", "--get", "user.name"];
    case "identity-email":
      return ["-C", checkout, "config", "--get", "user.email"];
    case "fetch":
      return ["-C", checkout, "ls-remote", "--exit-code", "origin", "HEAD"];
    case "push":
      return [
        "-C",
        checkout,
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "--dry-run",
        "--no-verify",
        "--porcelain",
        "origin",
        "HEAD:refs/heads/t3o-ready-probe",
      ];
  }
}

type Outcome = { readonly ok: boolean; readonly detail: string };

/**
 * Run each check in order, from `cwd` (an empty folder made for the run). A failing check marked
 * `warn` is a warning.
 */
export const runReadinessChecks = Effect.fn("Readiness.runChecks")(function* (input: {
  readonly checks: ReadonlyArray<BoardReadinessCheck>;
  readonly host: ReadinessCheckHost;
  readonly repo: ReadinessRepo;
  readonly cwd: string;
}) {
  const { host, repo, cwd } = input;
  const roots = yield* host.forbiddenRoots;
  /** A tool t3o itself runs, by absolute path, refused when a repo or a build could have put it there. */
  const tool = (name: string, paths: ReadonlyArray<string> = []): Outcome & { path?: string } => {
    const resolved = resolveCommand(name, paths, host.env);
    if (resolved === null) return { ok: false, detail: `${name} not found on PATH` };
    const root = forbiddenRootOf(resolved, roots);
    if (root !== null) {
      return {
        ok: false,
        detail: `refused ${resolved}: it is inside ${root}, where a repository or a build could have put it`,
      };
    }
    return { ok: true, detail: resolved, path: resolved };
  };
  const run = (command: string, args: ReadonlyArray<string>, timeoutMs: number) =>
    host.run({ command, args, cwd, timeoutMs });

  const checkOne = Effect.fn("Readiness.checkOne")(function* (
    check: BoardReadinessCheck,
  ): Effect.fn.Return<Outcome> {
    switch (boardReadinessCheckKind(check)) {
      case "command": {
        const name = check.command!;
        if (check.version === undefined) {
          const found = resolveCommand(name, check.paths ?? [], host.env);
          return found === null
            ? { ok: false, detail: `${name} not found on PATH${(check.paths ?? []).length > 0 ? " or in its paths" : ""}` }
            : { ok: true, detail: found };
        }
        const found = tool(name, check.paths ?? []);
        if (found.path === undefined) return found;
        let want: ReadonlyArray<number>;
        let wantText: string;
        if (check.version.atLeast !== undefined) {
          want = firstVersion(check.version.atLeast) ?? [0];
          wantText = check.version.atLeast;
        } else {
          const from = check.version.from!;
          const text = yield* repo.file(from);
          if (text === null) return { ok: false, detail: `${from} is not on the default branch` };
          const major = requiredMajor(from, text, name);
          if (major === null) return { ok: false, detail: `${from} names no ${name} version` };
          want = [major];
          wantText = `${major} (from ${from})`;
        }
        const ran = yield* run(found.path, ["--version"], VERSION_TIMEOUT_MS);
        if (ran.exitCode !== 0) return { ok: false, detail: `${name} --version: ${lastLine(ran)}` };
        const have = firstVersion(`${ran.stdout}\n${ran.stderr}`);
        if (have === null) return { ok: false, detail: `${name} --version printed no version` };
        const haveText = have.join(".");
        return compareVersions(have, want) >= 0
          ? { ok: true, detail: `${haveText} at ${found.path}` }
          : { ok: false, detail: `${haveText} at ${found.path}; needs ${wantText} or later` };
      }
      case "rustToolchain": {
        const file = check.rustToolchain!;
        const text = yield* repo.file(file);
        if (text === null) return { ok: false, detail: `${file} is not on the default branch` };
        const channel = rustChannel(text);
        if (channel === null) return { ok: false, detail: `${file} names no channel` };
        const rustup = tool("rustup");
        if (rustup.path === undefined) return rustup;
        const ran = yield* run(rustup.path, ["toolchain", "list"], LOCAL_TIMEOUT_MS);
        if (ran.exitCode !== 0) return { ok: false, detail: `rustup toolchain list: ${lastLine(ran)}` };
        const installed = ran.stdout
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0] ?? "")
          .some((name) => name === channel || name.startsWith(`${channel}-`));
        return installed
          ? { ok: true, detail: `${channel} installed` }
          : { ok: false, detail: `toolchain ${channel} is not installed` };
      }
      case "file": {
        const path = classifyBoardReadinessCheckPath(check.file!, { glob: false, repo: true });
        if (path === null) return { ok: false, detail: "unusable path" };
        const text =
          path.kind === "repo"
            ? yield* repo.file(path.path)
            : readMachineFile(expandMachinePath(path.path, host.env));
        if (text === null) return { ok: false, detail: `${path.path} not found` };
        return text.includes(check.contains ?? "")
          ? { ok: true, detail: `${path.path} contains "${check.contains}"` }
          : { ok: false, detail: `${path.path} doesn't contain "${check.contains}"` };
      }
      case "exists": {
        const path = classifyBoardReadinessCheckPath(check.exists!, { glob: true, repo: true });
        if (path === null) return { ok: false, detail: "unusable path" };
        if (path.kind === "repo") {
          return (yield* repo.has(path.path))
            ? { ok: true, detail: `${path.path} is on the default branch` }
            : { ok: false, detail: `${path.path} is not on the default branch` };
        }
        const matches = expandGlob(expandMachinePath(path.path, host.env));
        return matches.length > 0
          ? { ok: true, detail: matches[0]! }
          : { ok: false, detail: `nothing at ${path.path}` };
      }
      case "docker": {
        const docker = tool("docker");
        if (docker.path === undefined) return docker;
        const info = yield* run(docker.path, ["info"], DOCKER_TIMEOUT_MS);
        if (info.exitCode !== 0) return { ok: false, detail: `docker info: ${lastLine(info)}` };
        const missing: string[] = [];
        for (const plugin of check.docker!.plugins) {
          const ran = yield* run(docker.path, [plugin, "version"], DOCKER_TIMEOUT_MS);
          if (ran.exitCode !== 0) missing.push(plugin);
        }
        return missing.length === 0
          ? { ok: true, detail: ["daemon answers", ...check.docker!.plugins].join(", ") }
          : { ok: false, detail: `missing docker ${missing.join(", ")}` };
      }
      case "git": {
        const git = tool("git");
        if (git.path === undefined) return git;
        if (check.git === "identity") {
          const name = yield* run(git.path, gitProbeArgs("identity-name", repo.checkout), LOCAL_TIMEOUT_MS);
          const email = yield* run(git.path, gitProbeArgs("identity-email", repo.checkout), LOCAL_TIMEOUT_MS);
          const unset = [
            name.exitCode === 0 && name.stdout.trim() !== "" ? null : "user.name",
            email.exitCode === 0 && email.stdout.trim() !== "" ? null : "user.email",
          ].filter((entry) => entry !== null);
          return unset.length === 0
            ? { ok: true, detail: "user.name and user.email set" }
            : { ok: false, detail: `${unset.join(" and ")} not set; card commits would fail` };
        }
        const probe = check.git === "fetch" ? "fetch" : "push";
        const ran = yield* run(git.path, gitProbeArgs(probe, repo.checkout), NETWORK_TIMEOUT_MS);
        if (ran.exitCode === 0) {
          return { ok: true, detail: probe === "fetch" ? "origin answers without a prompt" : "push access confirmed (dry run)" };
        }
        return { ok: false, detail: `${probe === "fetch" ? "origin" : "push"}: ${redactCredentials(lastLine(ran))}` };
      }
      case "gh": {
        const gh = tool("gh");
        if (gh.path === undefined) return gh;
        const ran = yield* run(gh.path, ["auth", "status", "--hostname", check.gh!], LOCAL_TIMEOUT_MS);
        return ran.exitCode === 0
          ? { ok: true, detail: `signed in to ${check.gh!}` }
          : { ok: false, detail: `not signed in to ${check.gh!}` };
      }
      case "writable":
        return probeWritable(expandMachinePath(check.writable!, host.env));
      case null:
        return { ok: false, detail: "not a check this worker knows" };
    }
  });

  const results: ReadinessCheckResult[] = [];
  for (const check of input.checks) {
    const outcome = yield* checkOne(check).pipe(
      Effect.catchCause(() => Effect.succeed<Outcome>({ ok: false, detail: "the check failed to run" })),
    );
    results.push({
      label: boardReadinessCheckLabel(check),
      status: outcome.ok ? "pass" : check.warn === true ? "warn" : "fail",
      detail: outcome.detail,
      ...(outcome.ok || check.fix === undefined ? {} : { fix: check.fix }),
    });
  }
  return results;
});

const readMachineFile = (path: string): string | null => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The folder exists and a file can be created and removed in it. */
function probeWritable(dir: string): Outcome {
  try {
    if (!NodeFS.statSync(dir).isDirectory()) return { ok: false, detail: `${dir} is not a folder` };
    const probe = NodeFS.mkdtempSync(NodePath.join(dir, ".t3o-ready-"));
    NodeFS.writeFileSync(NodePath.join(probe, "probe"), "");
    NodeFS.rmSync(probe, { recursive: true, force: true });
    return { ok: true, detail: `${dir} is writable` };
  } catch (cause) {
    return { ok: false, detail: `${dir}: ${cause instanceof Error ? clip(cause.message) : "not writable"}` };
  }
}

/** Credentials in a URL never reach the output. */
const redactCredentials = (text: string) => text.replace(/(\w+:\/\/)[^@/\s]+@/g, "$1***@");

/** The checks as the readiness viewer shows them. */
export function formatReadinessChecks(results: ReadonlyArray<ReadinessCheckResult>): string {
  return results
    .map((result) =>
      [
        `${result.status === "fail" ? "FAIL" : result.status}  ${result.label}: ${result.detail}`,
        ...(result.fix === undefined ? [] : [`      fix: ${result.fix}`]),
      ].join("\n"),
    )
    .join("\n");
}
