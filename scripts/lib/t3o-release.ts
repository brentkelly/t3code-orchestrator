// @effect-diagnostics nodeBuiltinImport:off - run by the plain-Node release and update scripts.
/**
 * T3o: release tags, the build stamp, and the update decision, shared by
 * `scripts/t3o-service.mjs`, `scripts/t3o-update.mjs` and `scripts/t3o-release.mjs`.
 * Node built-ins and erasable TypeScript only: `t3o-update` runs this before `pnpm install`.
 * See docs/t3o/releasing.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const T3O_REPO = "brentkelly/t3code-orchestrator";
export const T3O_REPO_URL = `https://github.com/${T3O_REPO}.git`;
export const T3O_LATEST_RELEASE_API = `https://api.github.com/repos/${T3O_REPO}/releases/latest`;
export const STAMP_FILE = "t3o-release.json";

type Triple = readonly [number, number, number];

export interface T3oTag {
  readonly base: Triple;
  readonly n: number;
}

const T3O_TAG = /^t3o(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const UPSTREAM_STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseT3oTag(tag: string): T3oTag | null {
  const match = T3O_TAG.exec(tag.trim());
  if (!match) return null;
  return { base: [Number(match[1]), Number(match[2]), Number(match[3])], n: Number(match[4]) };
}

export const formatBase = (base: Triple) => base.join(".");

export const formatT3oTag = (tag: T3oTag) => `t3o${formatBase(tag.base)}.${tag.n}`;

/** Negative when `a` is older than `b`. */
export function compareT3oTags(a: T3oTag, b: T3oTag): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = a.base[index]! - b.base[index]!;
    if (delta !== 0) return delta;
  }
  return a.n - b.n;
}

/** The newest stable upstream `vX.Y.Z` among `tags`; nightlies and previews never qualify. */
export function selectUpstreamBase(tags: readonly string[]): Triple | null {
  let best: Triple | null = null;
  for (const tag of tags) {
    const match = UPSTREAM_STABLE_TAG.exec(tag.trim());
    if (!match) continue;
    const candidate: Triple = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (best === null || compareT3oTags({ base: candidate, n: 0 }, { base: best, n: 0 }) > 0) {
      best = candidate;
    }
  }
  return best;
}

/** One past the highest existing `t3o<base>.N`, or `.1` on a new base. */
export function nextT3oTag(base: Triple, existingTags: readonly string[]): string {
  let highest = 0;
  for (const tag of existingTags) {
    const parsed = parseT3oTag(tag);
    if (parsed && formatBase(parsed.base) === formatBase(base)) {
      highest = Math.max(highest, parsed.n);
    }
  }
  return formatT3oTag({ base, n: highest + 1 });
}

/** The newest T3o tag in `tags`, or null. */
export function latestT3oTag(tags: readonly string[]): string | null {
  let best: { tag: string; parsed: T3oTag } | null = null;
  for (const tag of tags) {
    const parsed = parseT3oTag(tag);
    if (parsed && (best === null || compareT3oTags(parsed, best.parsed) > 0)) {
      best = { tag: tag.trim(), parsed };
    }
  }
  return best?.tag ?? null;
}

export interface ReleaseStamp {
  readonly tag: string | null;
  readonly version: string;
  readonly base: string | null;
  readonly commit: string;
  readonly describe: string | null;
  readonly dirty: boolean;
  readonly builtAt: string;
}

/** `git describe --long` output, e.g. `t3o0.1.8.1-3-gabc1234`. */
export function parseDescribe(
  describe: string | null,
): { tag: string; ahead: number; abbrev: string } | null {
  const match = /^(t3o\d+\.\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)$/.exec(describe?.trim() ?? "");
  if (!match) return null;
  return { tag: match[1]!, ahead: Number(match[2]), abbrev: match[3]! };
}

/** `0.1.8.1`, `0.1.8.1+3.gabc1234` after the tag, or `dev (abc1234)` with no T3o tag. */
export function displayVersion(describe: string | null, commit: string): string {
  const parsed = parseDescribe(describe);
  if (!parsed) return `dev (${commit.slice(0, 7)})`;
  const version = parsed.tag.slice("t3o".length);
  return parsed.ahead === 0 ? version : `${version}+${parsed.ahead}.g${parsed.abbrev}`;
}

/** `git status --porcelain` output names a change other than `pnpm-lock.yaml`, which installs churn. */
export function porcelainIsDirty(porcelain: string): boolean {
  return changedPaths(porcelain).some((path) => path !== "pnpm-lock.yaml");
}

export function changedPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).split(" -> ").at(-1)!.trim());
}

export function buildStamp(input: {
  readonly describe: string | null;
  readonly commit: string;
  readonly porcelain: string;
  readonly now: Date;
}): ReleaseStamp {
  const parsed = parseDescribe(input.describe);
  const tag = parsed?.tag ?? null;
  const parsedTag = tag ? parseT3oTag(tag) : null;
  return {
    tag,
    version: displayVersion(input.describe, input.commit),
    base: parsedTag ? formatBase(parsedTag.base) : null,
    commit: input.commit,
    describe: input.describe,
    dirty: porcelainIsDirty(input.porcelain),
    builtAt: input.now.toISOString(),
  };
}

function git(repoRoot: string, args: readonly string[]): string | null {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function computeStamp(repoRoot: string, now = new Date()): ReleaseStamp {
  const commit = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!commit) throw new Error(`could not read HEAD in ${repoRoot}`);
  return buildStamp({
    describe: git(repoRoot, ["describe", "--tags", "--long", "--match", "t3o[0-9]*"]),
    commit,
    porcelain: git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]) ?? "",
    now,
  });
}

export function writeStamp(file: string, stamp: ReleaseStamp): void {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`);
}

export function readStamp(file: string): ReleaseStamp | null {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    return typeof parsed?.commit === "string" ? (parsed as ReleaseStamp) : null;
  } catch {
    return null;
  }
}

export type Relation = "equal" | "behind" | "ahead" | "diverged";

/**
 * Where the running commit stands against the release. A commit this clone lacks, or a
 * build from a dirty tree, is `diverged`: nothing proves the release contains it.
 */
export function relationOf(input: {
  readonly running: string;
  readonly target: string;
  readonly runningDirty: boolean;
  readonly isAncestor: (ancestor: string, descendant: string) => boolean;
}): Relation {
  if (input.runningDirty) return "diverged";
  if (input.running === input.target) return "equal";
  if (input.isAncestor(input.running, input.target)) return "behind";
  if (input.isAncestor(input.target, input.running)) return "ahead";
  return "diverged";
}

export type UpdateDecision =
  | { readonly kind: "update"; readonly downgrade: boolean }
  | { readonly kind: "none"; readonly reason: "up-to-date" | "ahead" | "diverged" }
  | { readonly kind: "needs-force"; readonly relation: "ahead" | "diverged" };

/** `--force` applies the target whatever the relation; `--to` alone only moves forward. */
export function decideUpdate(input: {
  readonly relation: Relation;
  readonly explicitTarget: boolean;
  readonly force: boolean;
}): UpdateDecision {
  const { relation } = input;
  if (relation === "behind") return { kind: "update", downgrade: false };
  if (input.force) return { kind: "update", downgrade: relation !== "equal" };
  if (relation === "equal") return { kind: "none", reason: "up-to-date" };
  return input.explicitTarget
    ? { kind: "needs-force", relation }
    : { kind: "none", reason: relation };
}

/** `--check` exit code: 10 means an update is available. */
export const checkExitCode = (relation: Relation) => (relation === "behind" ? 10 : 0);

export interface UnitSettings {
  readonly home: string;
  readonly path: string;
  readonly node: string;
  readonly appDir: string;
  readonly host: string;
  readonly port: string;
}

/** Reads back the unit `t3o-service.mjs buildUnit()` writes. Throws with the reason on any mismatch. */
export function parseUnitFile(text: string): UnitSettings {
  const env = (name: string) => new RegExp(`^Environment="${name}=([^"]*)"$`, "m").exec(text)?.[1];
  const exec = /^ExecStart=(\S+) (\S+)\/dist\/bin\.mjs serve --host (\S+) --port (\d+)$/m.exec(
    text,
  );
  const home = env("T3CODE_HOME");
  const path = env("PATH");
  if (!exec) throw new Error("its ExecStart is not the one install-t3o-service writes");
  if (home === undefined) throw new Error("it sets no T3CODE_HOME");
  if (path === undefined) throw new Error("it sets no PATH");
  return { home, path, node: exec[1]!, appDir: exec[2]!, host: exec[3]!, port: exec[4]! };
}

/** The Node directory first so `vp` and `npm` resolve, then the unit's PATH for provider CLIs. */
export function childPath(node: string, unitPath: string, shellPath: string | undefined): string {
  return [NodePath.dirname(node), unitPath, shellPath]
    .filter((entry): entry is string => Boolean(entry))
    .join(":");
}

/** Host to probe for a listen address: wildcards become loopback, IPv6 gets brackets. */
export function probeHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

/** The parent pid from `/proc/<pid>/stat`. The comm field may itself hold spaces or parens. */
export function parseStatPpid(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

export function cgroupInUnit(cgroup: string, unit: string): boolean {
  const suffix = `/${unit}.service`;
  return cgroup.split("\n").some((line) => line.trim().endsWith(suffix));
}

/**
 * Running inside the unit we are about to stop would kill this script with the service down.
 * Agents sit in the unit's cgroup or, moved to a user scope, under its main process.
 */
export function insideUnit(input: {
  readonly unit: string;
  readonly cgroup: string;
  readonly mainPid: number;
  readonly ancestors: readonly number[];
}): boolean {
  if (cgroupInUnit(input.cgroup, input.unit)) return true;
  return input.mainPid > 0 && input.ancestors.includes(input.mainPid);
}

function readText(file: string): string {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function ancestorPids(pid: number): number[] {
  const ancestors: number[] = [];
  let current: number | null = pid;
  while (current !== null && current > 1 && ancestors.length < 256) {
    current = parseStatPpid(readText(`/proc/${current}/stat`));
    if (current !== null && current > 0) ancestors.push(current);
  }
  return ancestors;
}

export function runningInsideUnit(unit: string): boolean {
  const mainPid = Number(
    NodeChildProcess.spawnSync(
      "systemctl",
      ["show", "-p", "MainPID", "--value", `${unit}.service`],
      {
        encoding: "utf8",
      },
    ).stdout?.trim() ?? "0",
  );
  return insideUnit({
    unit,
    cgroup: readText("/proc/self/cgroup"),
    mainPid: Number.isInteger(mainPid) ? mainPid : 0,
    ancestors: ancestorPids(process.pid),
  });
}

export const INSIDE_UNIT_MESSAGE =
  "Run this from a shell on the server, not from inside T3o (e.g. over SSH): stopping the service would kill this command and leave it down.";
