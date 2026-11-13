// @effect-diagnostics nodeBuiltinImport:off - a plain Node CI script; no Effect runtime to provide.
// @effect-diagnostics globalConsole:off globalDate:off - it reports, and times steps, to the CI step's log on stdout.
// T3o: the board CI stage's steps for this fork (T3O-88). t3o.json runs one part per step:
//
//   node scripts/t3o-ci.ts <install|changed|board|packages|web|full> [--full]
//
// The base is the card's own (branch.<b>.t3-merge-base, written when its worktree was made),
// else t3o. A branch that merges a large upstream range runs the full tier; --full or
// T3O_CI_FULL=1 forces it. Never run this in an agent turn: the CI stage runs it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readWorkspace } from "../.github/scripts/ci-changes.cjs";

export const ROOT = NodePath.resolve(import.meta.dirname, "..");
const PARTS = ["install", "changed", "board", "packages", "web", "full"] as const;
type Part = (typeof PARTS)[number];
const UPSTREAM_MERGE_THRESHOLD = 50;
// Fork-owned server-project tests the beside-file tests miss (board MCP contract, handlers).
const SERVER_FORK_DIRS = ["src/mcp/toolkits/board", "src/t3o"];
const ALWAYS_PACKAGES = ["packages/contracts", "packages/client-runtime", "packages/shared"];

export interface Failure {
  readonly title: string;
  readonly detail?: string;
  readonly file?: string;
  readonly machine?: boolean;
}

/** Drops the `@pnpm/exe` entries pnpm adds to the lockfile on every install here. */
export function stripPnpmExe(text: string): string {
  const lines = text.split("\n");
  const out: Array<string> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = /^(\s*)'@pnpm\/exe(?:@[^']*)?':\s*$/.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const indent = match[1]!.length;
    while (index + 1 < lines.length) {
      const next = lines[index + 1]!;
      if (next.trim() === "" || next.search(/\S/) <= indent) break;
      index++;
    }
    // A top-level package or snapshot entry carries one blank separator line.
    if (indent === 2 && lines[index + 1]?.trim() === "") index++;
  }
  return out.join("\n");
}

export const isPnpmExeOnlyChange = (committed: string, working: string) =>
  committed !== working && stripPnpmExe(committed) === stripPnpmExe(working);

const LOCKFILE_ERROR =
  /ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_UNUSED_PATCH|ERR_PNPM_LOCKFILE|ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_PEER_DEP|ERR_PNPM_WORKSPACE_PKG_NOT_FOUND/;
const MACHINE_INSTALL_ERROR =
  /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ERR_PNPM_FETCH_|ERR_PNPM_META_FETCH|ENOSPC|no space left on device|ERR_PNPM_ABORTED/i;

/** Machine problems hold the card for a human; code problems go to the fix agent. */
export function classifyInstallFailure(input: {
  readonly output: string;
  readonly manifestsChanged: boolean;
}): { readonly machine: boolean; readonly reason: string } {
  const lockfile = LOCKFILE_ERROR.exec(input.output);
  if (lockfile) return { machine: false, reason: `${lockfile[0]}: fix the lockfile or manifests` };
  if (input.manifestsChanged) {
    return { machine: false, reason: "install failed on a branch that changes dependencies" };
  }
  const machine = MACHINE_INSTALL_ERROR.exec(input.output);
  if (machine) return { machine: true, reason: `install failed: ${machine[0]}` };
  return { machine: false, reason: "pnpm install failed" };
}

/** Fewest commits ahead wins; ties keep the earlier candidate. */
export function pickClosest<C extends { readonly ahead: number }>(
  candidates: ReadonlyArray<C>,
): C | undefined {
  let best: C | undefined;
  for (const candidate of candidates) if (!best || candidate.ahead < best.ahead) best = candidate;
  return best;
}

const TEST_FILE = String.raw`[\w./@+-]+\.(?:browser\.)?test\.[cm]?[jt]sx?`;
/** Repo paths of the test files vitest's FAIL lines name; a project label is mapped to its package. */
export function failedTestFiles(
  output: string,
  packageDirs: () => ReadonlyArray<string> = () => readWorkspace().map((pkg) => pkg.dir),
  exists: (path: string) => boolean = (path) => NodeFS.existsSync(NodePath.join(ROOT, path)),
): Array<{ readonly name: string; readonly file?: string }> {
  const found = new Map<string, { readonly name: string; readonly file?: string }>();
  const pattern = new RegExp(String.raw`^\s*FAIL\s+(?:\|([^|]+)\|\s+)?(${TEST_FILE})`, "gm");
  for (const [, label, path] of output.matchAll(pattern)) {
    const key = `${label ?? ""}|${path}`;
    if (found.has(key)) continue;
    if (!label) {
      found.set(key, { name: path!, file: path! });
      continue;
    }
    const owners = packageDirs().filter((dir) => exists(`${dir}/${path}`));
    found.set(
      key,
      owners.length === 1
        ? { name: `${owners[0]}/${path}`, file: `${owners[0]}/${path}` }
        : { name: `|${label}| ${path}` },
    );
  }
  return [...found.values()];
}

const STEP_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^format/, "fmt"],
  [/^lint/, "lint"],
  [/^knip/, "knip"],
  [/^typecheck/, "typecheck"],
  [/^graphql/, "graphql"],
  [/^unused patches/, "install"],
  [/^(test|node --test|react compiler)/, "test"],
];
export const stepKind = (name: string) =>
  STEP_KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? "check";

/** The failed steps in check:changed's closing summary. */
export function checkChangedFailures(output: string): Array<Failure> {
  const summary = output.slice(output.lastIndexOf("check:changed summary"));
  const failures: Array<Failure> = [];
  for (const match of summary.matchAll(/^\s+(FAIL|TIMEOUT)\s+(.+?)\s{2,}\S+\s*$/gm)) {
    const [, outcome, name] = match;
    const kind = stepKind(name!);
    const detail = outcome === "TIMEOUT" ? "timed out" : undefined;
    if (kind === "test") {
      const files = failedTestFiles(output);
      if (files.length > 0) {
        for (const { name, file } of files) {
          failures.push({ title: `[test] ${name}`, ...(file ? { file } : {}) });
        }
        continue;
      }
    }
    failures.push({ title: `[${kind}] ${name}`, ...(detail ? { detail } : {}) });
  }
  return failures;
}

export interface SuiteFailure {
  readonly file: string;
  readonly test: string;
  readonly error: string;
}

interface VitestJson {
  readonly numPassedTests?: number;
  readonly numFailedTests?: number;
  readonly testResults?: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly message?: string;
    readonly assertionResults?: ReadonlyArray<{
      readonly fullName: string;
      readonly status: string;
      readonly failureMessages?: ReadonlyArray<string>;
    }>;
  }>;
}

const firstLine = (text: string | undefined) =>
  (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";

/** Failed tests from vitest's JSON reporter, files relative to the repo root. */
export function parseVitestJson(
  json: VitestJson,
  root = ROOT,
): { passed: number; failed: number; failures: Array<SuiteFailure> } {
  const failures: Array<SuiteFailure> = [];
  for (const file of json.testResults ?? []) {
    const relative = NodePath.relative(root, file.name);
    const failedTests = (file.assertionResults ?? []).filter((test) => test.status === "failed");
    for (const test of failedTests) {
      failures.push({
        file: relative,
        test: test.fullName,
        error: firstLine(test.failureMessages?.[0]),
      });
    }
    // A file that failed to load has no failed assertions, only a message.
    if (file.status === "failed" && failedTests.length === 0) {
      failures.push({ file: relative, test: "(file)", error: firstLine(file.message) });
    }
  }
  return { passed: json.numPassedTests ?? 0, failed: json.numFailedTests ?? 0, failures };
}

const INFRA_OUTPUT =
  /Executable doesn't exist|npx playwright install|playwright install|ENOSPC|no space left on device/i;

const OUTPUT_CAP = 4 * 1024 * 1024;

export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly shell?: boolean } = {},
): Promise<{ code: number; output: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: process.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const tee = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
      stream.write(chunk);
      output += chunk.toString();
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP);
    };
    child.stdout.on("data", tee(process.stdout));
    child.stderr.on("data", tee(process.stderr));
    child.on("error", (error) => resolve({ code: 127, output, spawnError: error.message }));
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), output }));
  });
}

function git(
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly timeout?: number } = {},
): { ok: boolean; out: string } {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    ...(options.timeout ? { timeout: options.timeout } : {}),
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

export interface SuiteResult {
  readonly name: string;
  readonly dir: string;
  readonly status: "pass" | "fail" | "infra";
  readonly durationMs: number;
  readonly passed: number;
  readonly failed: number;
  readonly failures: ReadonlyArray<SuiteFailure>;
  readonly infraReason?: string;
}

/** Runs one vitest command (a shell string) with a JSON report beside the default one. */
export async function runSuite(input: {
  readonly name: string;
  readonly dir: string;
  readonly command: string;
}): Promise<SuiteResult> {
  const report = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-suite-")),
    "report.json",
  );
  const started = Date.now();
  progress(`${input.name}: ${input.command}`);
  const result = await run(
    `${input.command} --reporter=default --reporter=json --outputFile.json=${JSON.stringify(report)}`,
    [],
    { cwd: NodePath.join(ROOT, input.dir), shell: true },
  );
  const durationMs = Date.now() - started;
  let parsed: ReturnType<typeof parseVitestJson> | undefined;
  try {
    parsed = parseVitestJson(JSON.parse(NodeFS.readFileSync(report, "utf8")) as VitestJson);
  } catch {
    parsed = undefined;
  } finally {
    NodeFS.rmSync(NodePath.dirname(report), { recursive: true, force: true });
  }
  const infra = INFRA_OUTPUT.exec(result.output)?.[0];
  const ok = result.code === 0;
  // A non-zero exit with no failed test (an unhandled error, a crashed worker) still names a failure.
  const failures =
    parsed && parsed.failures.length > 0
      ? parsed.failures
      : ok
        ? []
        : [
            {
              file: input.dir,
              test: "(suite)",
              error: `exited ${result.code}: ${firstLine(result.output.slice(-2000))}`,
            },
          ];
  return {
    name: input.name,
    dir: input.dir,
    status: ok ? "pass" : infra && (parsed?.failed ?? 0) === 0 ? "infra" : "fail",
    durationMs,
    passed: parsed?.passed ?? 0,
    failed: parsed?.failed ?? (ok ? 0 : 1),
    failures: ok ? [] : failures,
    ...(!ok && infra ? { infraReason: infra } : {}),
  };
}

function progress(message: string) {
  console.log(`::t3o-progress::${JSON.stringify({ message })}`);
}

// The board drops a result failure over these lengths (BoardCiFailureDetail), so clamp rather than lose it.
const clamp = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
export const clampFailure = (failure: Failure): Failure => ({
  ...failure,
  title: clamp(failure.title, 500),
  ...(failure.detail !== undefined ? { detail: clamp(failure.detail, 4_000) } : {}),
  ...(failure.file !== undefined ? { file: clamp(failure.file, 500) } : {}),
});

function writeResult(summary: string, failures: ReadonlyArray<Failure>) {
  const path = process.env.T3O_CI_RESULT;
  if (!path) return;
  NodeFS.writeFileSync(
    path,
    JSON.stringify(
      { summary: clamp(summary, 1_000), failures: failures.map(clampFailure) },
      null,
      2,
    ),
  );
}

function fail(step: string, summary: string, failures: ReadonlyArray<Failure>, machine = false) {
  console.log(
    `::t3o-failure::${JSON.stringify({ step, reason: failures[0]?.title ?? summary, machine })}`,
  );
  writeResult(summary, failures);
  process.exitCode = 1;
}

export const suiteFailures = (suites: ReadonlyArray<SuiteResult>): Array<Failure> =>
  suites.flatMap((suite): Array<Failure> =>
    suite.status === "infra"
      ? [{ title: `[infra] ${suite.name}`, detail: suite.infraReason ?? "", machine: true }]
      : suite.failures.map((failure) => ({
          title: `[test] ${failure.file} > ${failure.test}`,
          detail: failure.error,
          file: failure.file,
        })),
  );

/** Only a failure list that is non-empty and wholly the machine's holds the card for a human. */
export const isMachineFailure = (failures: ReadonlyArray<Failure>) =>
  failures.length > 0 && failures.every((failure) => failure.machine === true);

export interface Base {
  readonly ref: string;
  readonly mergeBase: string;
  readonly ahead: number;
  readonly source: string;
}

const revExists = (cwd: string, rev: string) =>
  git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd }).ok;
const isAncestor = (cwd: string, ancestor: string, of: string) =>
  git(["merge-base", "--is-ancestor", ancestor, of], { cwd }).ok;

/** The card's base (branch.<b>.t3-merge-base), else t3o: the closer of the local and origin copy. */
export function resolveBase(
  cwd = ROOT,
  options: { readonly fetch?: boolean } = {},
): Base | undefined {
  const branch = git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd }).out;
  const configured = branch
    ? git(["config", "--get", `branch.${branch}.t3-merge-base`], { cwd }).out
    : "";
  const attempt = (name: string, source: string) => {
    // Best effort: a fresh remote ref keeps a card that merged its base in from over-checking.
    if (options.fetch !== false) {
      git(["fetch", "--quiet", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`], {
        cwd,
        timeout: 60_000,
      });
    }
    const candidates = [name, `origin/${name}`].flatMap((ref) => {
      if (!revExists(cwd, ref)) return [];
      const mergeBase = git(["merge-base", "HEAD", ref], { cwd });
      if (!mergeBase.ok) return [];
      const ahead = Number(git(["rev-list", "--count", `${mergeBase.out}..HEAD`], { cwd }).out);
      return [{ ref, mergeBase: mergeBase.out, ahead, source }];
    });
    return pickClosest(candidates);
  };
  return (
    (configured && configured !== "t3o" ? attempt(configured, "card base") : undefined) ??
    attempt("t3o", configured === "t3o" ? "card base" : "default t3o")
  );
}

export interface Tier {
  readonly full: boolean;
  readonly reason: string;
}

/** Full when forced, or when the branch merges a large range its base lacks (an upstream sync). */
export function detectTier(
  base: Pick<Base, "ref">,
  cwd = ROOT,
  forced: { readonly argv: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv } = {
    argv: process.argv,
    env: process.env,
  },
): Tier {
  if (forced.argv.includes("--full")) return { full: true, reason: "--full" };
  if (forced.env.T3O_CI_FULL === "1") return { full: true, reason: "T3O_CI_FULL=1" };
  const merges = git(["rev-list", "--merges", `${base.ref}..HEAD`], { cwd }).out;
  for (const merge of merges.split("\n").filter(Boolean)) {
    const second = `${merge}^2`;
    if (!revExists(cwd, second) || isAncestor(cwd, second, base.ref)) continue;
    const count = Number(git(["rev-list", "--count", `^${base.ref}`, second], { cwd }).out);
    if (count > UPSTREAM_MERGE_THRESHOLD) {
      return {
        full: true,
        reason: `merge ${merge.slice(0, 10)} brings in ${count} commits not on ${base.ref}`,
      };
    }
  }
  const upstream = ["upstream/main", "main", "origin/main"].find((ref) => revExists(cwd, ref));
  if (upstream) {
    const mergeBase = git(["merge-base", "HEAD", upstream], { cwd });
    if (mergeBase.ok && !isAncestor(cwd, mergeBase.out, base.ref)) {
      return { full: true, reason: `HEAD carries ${upstream} commits ${base.ref} lacks` };
    }
  }
  return { full: false, reason: "not an upstream sync" };
}

const tierLabel = (tier: Tier) => (tier.full ? "tier: full" : "tier: B");

function changedFiles(base: Base): Array<string> {
  return git(["diff", "--name-only", base.mergeBase, "HEAD"]).out.split("\n").filter(Boolean);
}

export function prepareEnvironment() {
  // Steps inherit the live server's environment, which points at its real home.
  for (const name of Object.keys(process.env)) {
    if (
      name.startsWith("T3CODE_") ||
      name === "T3_BOOT_SERVICE_UNIT" ||
      name === "T3_SERVICE_LAUNCHER_CONTEXT"
    ) {
      delete process.env[name];
    }
  }
  process.env.PATH = `${NodePath.join(ROOT, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`;
  process.env.CI = "1";
}

function depsInstalled(part: Part): boolean {
  if (NodeFS.existsSync(NodePath.join(ROOT, "node_modules/.bin/vp"))) return true;
  fail(part, "dependencies are not installed", [
    {
      title: `[${part}] dependencies are not installed`,
      detail: "node_modules/.bin/vp is missing; see the install step's failure.",
    },
  ]);
  return false;
}

function restorePnpmExeLines(): boolean {
  const lockfile = NodePath.join(ROOT, "pnpm-lock.yaml");
  const committed = NodeChildProcess.spawnSync("git", ["show", "HEAD:pnpm-lock.yaml"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (committed.status !== 0 || !NodeFS.existsSync(lockfile)) return false;
  if (!isPnpmExeOnlyChange(committed.stdout, NodeFS.readFileSync(lockfile, "utf8"))) return false;
  return git(["checkout", "--", "pnpm-lock.yaml"]).ok;
}

async function install(base: Base | undefined, tier: Tier | undefined) {
  const manifestsChanged = base
    ? changedFiles(base).some(
        (file) =>
          NodePath.basename(file) === "package.json" ||
          file === "pnpm-lock.yaml" ||
          file === "pnpm-workspace.yaml",
      )
    : false;
  const result = await run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--yes"]);
  if (restorePnpmExeLines()) progress("restored pnpm-lock.yaml (only @pnpm/exe lines changed)");
  if (result.spawnError) {
    return fail(
      "install",
      "pnpm is not installed",
      [{ title: "[install] pnpm is not installed", detail: result.spawnError, machine: true }],
      true,
    );
  }
  if (result.code !== 0) {
    const { machine, reason } = classifyInstallFailure({ output: result.output, manifestsChanged });
    return fail("install", reason, [{ title: `[install] ${reason}`, machine }], machine);
  }
  writeResult(`install ok (${tier ? tierLabel(tier) : "tier unknown"})`, []);
}

async function changed(base: Base, tier: Tier) {
  const args = ["scripts/check-changed.ts", base.ref, ...(tier.full ? ["--no-tests"] : [])];
  progress(
    `check:changed against ${base.ref}${tier.full ? " (no tests: the full step runs them)" : ""}`,
  );
  const result = await run("node", args);
  if (result.code === 0)
    return writeResult(`check:changed passed against ${base.ref} (${tierLabel(tier)})`, []);
  const failures = checkChangedFailures(result.output);
  fail(
    "changed",
    `check:changed failed against ${base.ref} (${tierLabel(tier)})`,
    failures.length > 0 ? failures : [{ title: "[check] check:changed failed" }],
  );
}

async function suites(part: Part, tier: Tier, list: ReadonlyArray<Parameters<typeof runSuite>[0]>) {
  const results: Array<SuiteResult> = [];
  for (const suite of list) results.push(await runSuite(suite));
  const timing = results
    .map((result) => `${result.name} ${result.status} ${Math.round(result.durationMs / 1000)}s`)
    .join(", ");
  const summary = `${part}: ${timing} (${tierLabel(tier)})`;
  console.log(summary);
  if (results.every((result) => result.status === "pass")) return writeResult(summary, []);
  const failures = suiteFailures(results);
  fail(part, summary, failures, isMachineFailure(failures));
}

function packageSuites(base: Base) {
  const files = changedFiles(base);
  const touched = readWorkspace()
    .filter((pkg) => pkg.hasTest && !pkg.dir.startsWith("apps/"))
    .filter((pkg) => files.some((file) => file.startsWith(`${pkg.dir}/`)))
    .map((pkg) => pkg.dir);
  return [...new Set([...ALWAYS_PACKAGES, ...touched])].map((dir) => ({
    name: dir,
    dir,
    command: packageTestCommand(dir),
  }));
}

export function packageTestCommand(dir: string): string {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(ROOT, dir, "package.json"), "utf8"),
  ) as {
    readonly scripts?: Record<string, string>;
  };
  const script = manifest.scripts?.test;
  if (!script) throw new Error(`${dir} has no test script`);
  return script;
}

async function main() {
  const part = process.argv[2] as Part | undefined;
  if (!part || !PARTS.includes(part)) {
    console.error(`usage: node scripts/t3o-ci.ts <${PARTS.join("|")}> [--full]`);
    process.exitCode = 2;
    return;
  }
  prepareEnvironment();
  const base = resolveBase();
  const tier = base ? detectTier(base) : undefined;
  if (base && tier) {
    progress(
      `base ${base.ref} (${base.source}, ${base.ahead} commits ahead); ${tierLabel(tier)}: ${tier.reason}`,
    );
  }
  if (part === "install") return install(base, tier);
  if (!base || !tier) {
    return fail(part, "no base", [
      { title: `[${part}] no merge base with t3o or the card's base; fetch origin and retry` },
    ]);
  }
  if (!depsInstalled(part)) return;
  switch (part) {
    case "changed":
      return changed(base, tier);
    case "board":
      return suites(part, tier, [
        {
          name: "server board project",
          dir: "apps/server",
          command: "vp test run --project board",
        },
        {
          name: "server fork tests",
          dir: "apps/server",
          command: `vp test run --project server ${SERVER_FORK_DIRS.join(" ")}`,
        },
      ]);
    case "packages":
      return suites(part, tier, packageSuites(base));
    case "web":
      return suites(part, tier, [
        { name: "web unit", dir: "apps/web", command: "vp test run --project unit --maxWorkers 4" },
      ]);
    case "full":
      if (!tier.full) {
        const summary = `skipped: ${tier.reason} (${tierLabel(tier)})`;
        progress(summary);
        return writeResult(summary, []);
      }
      return suites(part, tier, [
        { name: "server project", dir: "apps/server", command: "vp test run --project server" },
        { name: "web browser", dir: "apps/web", command: "vp test run --project browser" },
      ]);
  }
}

if (import.meta.main) await main();
