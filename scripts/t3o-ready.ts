// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node; runs before `pnpm install`.
/* oxlint-disable t3code/no-global-process-runtime -- standalone Node before install; no Effect runtime. */
// T3o: can this machine take this project's board jobs? Run through scripts/t3o-ready.sh, which
// t3o.json registers as resources.readiness. The worker runs quick mode; `--full` also installs,
// loads native modules and launches the test browser, for a human to run by hand.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  checkPinnedVersion,
  chromiumInstallDirs,
  formatResult,
  redactCredentials,
  verdict,
  type CheckResult,
} from "./lib/t3o-ready.ts";
import { selectUpstreamBase } from "./lib/t3o-release.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const TRUNK = "t3o";
const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";
const NETWORK_TIMEOUT_MS = 20_000;

const full = process.argv.includes("--full");
const colour = process.stdout.isTTY === true && !process.env.NO_COLOR;

// Nothing may prompt: the worker has no terminal, and a prompt would hang until the timeout.
const quietEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  // A pnpm that differs from packageManager would otherwise download the pinned one.
  npm_config_manage_package_manager_versions: "false",
};

interface Ran {
  readonly ok: boolean;
  readonly missing: boolean;
  readonly out: string;
  readonly err: string;
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly timeout?: number;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Ran {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? quietEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? NETWORK_TIMEOUT_MS,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    ok: result.status === 0,
    missing: code === "ENOENT",
    out: (result.stdout ?? "").trim(),
    err: code === "ETIMEDOUT" ? "timed out" : (result.stderr ?? "").trim(),
  };
}

/** The last meaningful stderr line, without credentials. */
const reason = (ran: Ran) =>
  redactCredentials(
    ran.err
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^Node\.js v\d/.test(line))
      .at(-1) ?? "exited non-zero",
  );

const onPath = (name: string) =>
  (process.env.PATH ?? "").split(NodePath.delimiter).some((dir) => {
    try {
      NodeFS.accessSync(NodePath.join(dir, name), NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

/** Whether `path`, or the nearest ancestor that exists, is writable: pnpm creates the rest. */
function writable(path: string): boolean {
  let dir = NodePath.resolve(path);
  while (!NodeFS.existsSync(dir) && NodePath.dirname(dir) !== dir) dir = NodePath.dirname(dir);
  try {
    NodeFS.accessSync(dir, NodeFS.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, "package.json"), "utf8")) as {
  readonly engines?: { readonly node?: string };
  readonly packageManager?: string;
};

function checkNode(): CheckResult {
  const pin = manifest.engines?.node;
  return checkPinnedVersion({
    name: "node",
    actual: process.version,
    pin,
    pinSource: "engines.node",
    fix: `install Node ${pin} (CI's pin) and put it first on the worker's PATH`,
  });
}

function checkPnpm(): CheckResult {
  const pin = manifest.packageManager?.replace(/^pnpm@/, "");
  const ran = run("pnpm", ["--version"], { timeout: 10_000 });
  return checkPinnedVersion({
    name: "pnpm",
    actual: ran.ok ? ran.out : null,
    pin,
    pinSource: "packageManager",
    fix: `corepack enable pnpm, or npm install -g pnpm@${pin}`,
  });
}

function checkGitIdentity(): CheckResult {
  const name = run("git", ["config", "--get", "user.name"], { timeout: 5_000 });
  if (name.missing) {
    return { name: "git identity", status: "fail", detail: "git not found", fix: "install git" };
  }
  const email = run("git", ["config", "--get", "user.email"], { timeout: 5_000 });
  const unset = [
    name.ok && name.out ? null : "user.name",
    email.ok && email.out ? null : "user.email",
  ]
    .filter(Boolean)
    .join(" and ");
  if (unset) {
    return {
      name: "git identity",
      status: "fail",
      detail: `${unset} not set; card commits would fail`,
      fix: 'git config --global user.name "<name>" && git config --global user.email "<email>"',
    };
  }
  return { name: "git identity", status: "pass", detail: "user.name and user.email set" };
}

function gitNetworkEnv(): NodeJS.ProcessEnv {
  const configured = run("git", ["config", "--get", "core.sshCommand"], { timeout: 5_000 });
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || configured.out) return quietEnv;
  return { ...quietEnv, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
}

function checkOrigin(): ReadonlyArray<CheckResult> {
  const url = run("git", ["remote", "get-url", "origin"], { timeout: 5_000 });
  if (!url.ok) {
    const fix = "git remote add origin <url>";
    return [{ name: "origin fetch", status: "fail", detail: "the checkout has no origin", fix }];
  }
  const where = redactCredentials(url.out);
  const env = gitNetworkEnv();
  const fetch = run("git", ["ls-remote", "--exit-code", "--heads", "origin", TRUNK], { env });
  const fetchResult: CheckResult = fetch.ok
    ? { name: "origin fetch", status: "pass", detail: `${where} answers without a prompt` }
    : {
        name: "origin fetch",
        status: "fail",
        detail: `${where}: ${reason(fetch)}`,
        fix: "give git a non-interactive credential for origin (gh auth setup-git, an SSH key, or docs/t3o/gitenv.md)",
      };
  if (!fetch.ok) return [fetchResult];
  // A dry run authenticates for push and sends nothing; --no-verify keeps the pre-push hook out of it.
  const push = run(
    "git",
    [
      "push",
      "--dry-run",
      "--no-verify",
      "--porcelain",
      "origin",
      "HEAD:refs/heads/t3o-ready-probe",
    ],
    { env },
  );
  return [
    fetchResult,
    push.ok
      ? { name: "origin push", status: "pass", detail: "push access confirmed (dry run)" }
      : {
          name: "origin push",
          status: "fail",
          detail: `card branches cannot be pushed: ${reason(push)}`,
          fix: "use a credential with write access to origin",
        },
  ];
}

function checkUpstreamTags(): CheckResult {
  const tags = run("git", ["tag", "--merged", "HEAD", "--list", "v*"], { timeout: 10_000 });
  const base = tags.ok ? selectUpstreamBase(tags.out.split("\n")) : null;
  if (base)
    return { name: "upstream tags", status: "pass", detail: `v${base.join(".")} reachable` };
  const hasUpstream = run("git", ["remote", "get-url", "upstream"], { timeout: 5_000 }).ok;
  return {
    name: "upstream tags",
    status: "fail",
    detail: "no stable upstream vX.Y.Z tag in HEAD; CI's [release] check fails without one",
    fix: `${hasUpstream ? "" : `git remote add upstream ${UPSTREAM_URL} && `}git fetch upstream --tags`,
  };
}

function checkGh(): CheckResult {
  // Run in the checkout so the T3o gh shim can pick this repo's token (docs/t3o/gitenv.md).
  const ran = run("gh", ["auth", "status", "--hostname", "github.com"]);
  if (ran.missing) {
    return {
      name: "gh",
      status: "fail",
      detail: "GitHub CLI not found; the board opens and merges pull requests with it",
      fix: "install gh (https://cli.github.com), then gh auth login",
    };
  }
  if (!ran.ok) {
    return {
      name: "gh",
      status: "fail",
      detail: "not signed in to github.com",
      fix: "gh auth login, or a github.com/<owner> token in gitenv (docs/t3o/gitenv.md)",
    };
  }
  return { name: "gh", status: "pass", detail: "signed in to github.com" };
}

function checkBuildTools(): CheckResult {
  if (process.platform !== "linux") {
    return { name: "build tools", status: "skip", detail: "only checked on Linux" };
  }
  const missing = [
    onPath("make") ? null : "make",
    onPath("c++") || onPath("g++") ? null : "a C++ compiler",
    onPath("python3") ? null : "python3",
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      name: "build tools",
      status: "fail",
      detail: `missing ${missing.join(", ")}; node-pty has no Linux prebuild and compiles on install`,
      fix: "sudo apt install build-essential python3 (or your distro's equivalent)",
    };
  }
  return { name: "build tools", status: "pass", detail: "make, C++ compiler and python3 on PATH" };
}

function checkDirectories(): CheckResult {
  const store = run("pnpm", ["store", "path"], { timeout: 10_000 });
  const dirs = [
    { label: "temp dir", path: NodeOS.tmpdir() },
    ...(store.ok && store.out ? [{ label: "pnpm store", path: store.out }] : []),
  ];
  const blocked = dirs.filter((dir) => !writable(dir.path));
  if (blocked.length > 0) {
    return {
      name: "writable dirs",
      status: "fail",
      detail: blocked.map((dir) => `${dir.label} ${dir.path} is not writable`).join("; "),
      fix: "fix the ownership or permissions of those directories for this user",
    };
  }
  return { name: "writable dirs", status: "pass", detail: dirs.map((dir) => dir.label).join(", ") };
}

function depsInstalled(): boolean {
  return NodeFS.existsSync(NodePath.join(ROOT, "node_modules/.bin/vp"));
}

function checkDependencies(): CheckResult {
  return depsInstalled()
    ? { name: "dependencies", status: "pass", detail: "installed in the checkout" }
    : {
        name: "dependencies",
        status: "warn",
        detail: "not installed in the checkout; the browser check is skipped",
        fix: "pnpm install --frozen-lockfile",
      };
}

function playwrightCore(): string | null {
  try {
    const web = NodeModule.createRequire(NodePath.join(ROOT, "apps/web/package.json"));
    const playwright = web.resolve("playwright/package.json");
    return NodePath.dirname(
      NodeModule.createRequire(playwright).resolve("playwright-core/package.json"),
    );
  } catch {
    return null;
  }
}

function browsersRoot(): string {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured && configured !== "0") return configured;
  if (process.platform === "darwin")
    return NodePath.join(NodeOS.homedir(), "Library/Caches/ms-playwright");
  if (process.platform === "win32") {
    return NodePath.join(process.env.LOCALAPPDATA ?? NodeOS.homedir(), "ms-playwright");
  }
  return NodePath.join(
    process.env.XDG_CACHE_HOME ?? NodePath.join(NodeOS.homedir(), ".cache"),
    "ms-playwright",
  );
}

const BROWSER_FIX = "apps/web/node_modules/.bin/playwright install --with-deps chromium";

function checkBrowser(): CheckResult {
  const core = depsInstalled() ? playwrightCore() : null;
  if (core === null) {
    return { name: "test browser", status: "skip", detail: "needs dependencies installed" };
  }
  const manifestPath = NodePath.join(core, "browsers.json");
  const dirs = chromiumInstallDirs(JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")));
  const root = browsersRoot();
  const found = dirs.find((dir) => NodeFS.existsSync(NodePath.join(root, dir)));
  if (found) return { name: "test browser", status: "pass", detail: `${found} installed` };
  return {
    name: "test browser",
    status: "warn",
    detail: `${dirs[0] ?? "chromium"} not in ${root}; upstream-sync CI runs the web browser tests`,
    fix: BROWSER_FIX,
  };
}

function fullInstall(): CheckResult {
  console.log(
    "  ....  installing (pnpm install --frozen-lockfile --prefer-offline), output on stderr",
  );
  const lockfile = NodePath.join(ROOT, "pnpm-lock.yaml");
  const before = NodeFS.readFileSync(lockfile, "utf8");
  const result = NodeChildProcess.spawnSync(
    "pnpm",
    ["install", "--frozen-lockfile", "--prefer-offline", "--yes"],
    { cwd: ROOT, env: { ...quietEnv, CI: "1" }, stdio: ["ignore", 2, 2], timeout: 15 * 60_000 },
  );
  // pnpm adds @pnpm/exe entries here on every install; CI puts the committed file back too.
  if (NodeFS.readFileSync(lockfile, "utf8") !== before) NodeFS.writeFileSync(lockfile, before);
  return result.status === 0
    ? { name: "install", status: "pass", detail: "frozen-lockfile install succeeded" }
    : {
        name: "install",
        status: "fail",
        detail: `pnpm install exited ${result.status ?? result.signal}; see the output above`,
        fix: "read pnpm's error: a network, store or native build problem is this machine's",
      };
}

function fullNodePty(): CheckResult {
  const ran = run(process.execPath, ["-e", "require('node-pty')"], {
    cwd: NodePath.join(ROOT, "apps/server"),
    timeout: 15_000,
  });
  return ran.ok
    ? { name: "node-pty", status: "pass", detail: "native module loads" }
    : {
        name: "node-pty",
        status: "fail",
        detail: reason(ran),
        fix: "pnpm rebuild node-pty (after fixing build tools or switching Node)",
      };
}

function fullBrowserLaunch(): CheckResult {
  const core = playwrightCore();
  if (core === null) {
    return {
      name: "browser launch",
      status: "fail",
      detail: "playwright is not installed",
      fix: "pnpm install",
    };
  }
  const script = `require(${JSON.stringify(core)}).chromium.launch({ headless: true })
    .then((browser) => browser.close())
    .catch((error) => { console.error(String(error.message).split("\\n")[0]); process.exit(1); })`;
  const ran = run(process.execPath, ["-e", script], { timeout: 60_000 });
  return ran.ok
    ? { name: "browser launch", status: "pass", detail: "headless chromium starts and closes" }
    : { name: "browser launch", status: "fail", detail: reason(ran), fix: BROWSER_FIX };
}

function main() {
  const head = run("git", ["rev-parse", "--short", "HEAD"], { timeout: 5_000 }).out || "no HEAD";
  console.log(`t3o readiness (${full ? "full" : "quick"}) for ${ROOT} at ${head}`);
  const results: Array<CheckResult> = [];
  const report = (...checks: ReadonlyArray<CheckResult>) => {
    for (const check of checks) {
      results.push(check);
      console.log(formatResult(check, colour));
    }
  };
  report(checkNode(), checkPnpm(), checkGitIdentity());
  report(...checkOrigin());
  report(checkUpstreamTags(), checkGh(), checkBuildTools(), checkDirectories());
  if (full) report(fullInstall());
  report(checkDependencies(), checkBrowser());
  if (full) report(fullNodePty(), fullBrowserLaunch());
  const { ready, line } = verdict(results);
  console.log(line);
  process.exitCode = ready ? 0 : 1;
}

main();
