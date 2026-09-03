#!/usr/bin/env node
/**
 * Install the built t3o server as a systemd service.
 *
 *   pnpm run install-t3o-service              # build, sync, write the unit
 *   pnpm run install-t3o-service -- --takeover # ...and switch off t3code.service
 *   pnpm run uninstall-t3o-service            # ...and hand the port back
 *
 * `--takeover` records the unit it displaced, and uninstall re-enables it, so
 * the switch is reversible rather than a one-way door.
 *
 * Upstream's `t3 service install` is not usable here: it runs
 * `npm install t3@<version>` from the public registry (see
 * apps/server/src/cloud/pinnedRuntime.ts) and would install upstream's server
 * against this fork's data. This writes a unit pointing at our own build.
 *
 * The service never runs out of the worktree. `vp pack` cleans apps/server/dist
 * on every build, which would pull the tree out from under a live process, so
 * the build is rsynced to <home>/app and the unit executes from there. Rebuild,
 * re-run this, and only the changed chunks move.
 *
 * `dist` alone is not runnable: the bundle deliberately leaves the native
 * packages external, and outside the worktree there is no node_modules for Node
 * to resolve them from. So the app dir also gets a small manifest of exactly
 * those roots -- the same list the bundler is configured from -- and an npm
 * install that only re-runs when a version moves.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const user = NodeOS.userInfo().username;

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string", default: NodePath.join(NodeOS.homedir(), ".t3") },
    "app-dir": { type: "string" },
    port: { type: "string", default: "3773" },
    host: { type: "string", default: "127.0.0.1" },
    unit: { type: "string", default: "t3o" },
    "no-build": { type: "boolean", default: false },
    takeover: { type: "boolean", default: false },
    "no-restore": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const command = positionals[0] ?? "install";
const t3Home = NodePath.resolve(values.home);
const appDir = NodePath.resolve(values["app-dir"] ?? NodePath.join(t3Home, "app"));
const unitName = `${values.unit}.service`;
const unitPath = `/etc/systemd/system/${unitName}`;

if (values.help || !["install", "sync", "uninstall", "status", "unit"].includes(command)) {
  console.log(
    [
      "Usage: node scripts/t3o-service.mjs [install|sync|uninstall|status|unit] [flags]",
      "",
      `  --home <dir>       T3 Code data directory (default ${NodePath.join(NodeOS.homedir(), ".t3")})`,
      "  --app-dir <dir>    Where the build is synced (default <home>/app)",
      "  --port <n>         Listen port (default 3773)",
      "  --host <addr>      Listen address (default 127.0.0.1)",
      "  --unit <name>      systemd unit name without .service (default t3o)",
      "  --no-build         Sync the existing apps/server/dist instead of rebuilding",
      "  --takeover         Stop and disable whatever else holds the port, then start",
      "  --no-restore       (uninstall) leave the unit --takeover displaced switched off",
    ].join("\n"),
  );
  process.exit(values.help ? 0 : 1);
}

const run = (bin, args, options = {}) => {
  const result = NodeChildProcess.spawnSync(bin, args, { stdio: "inherit", ...options });
  if (result.error) fail(`${bin} failed to start: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    fail(`${bin} ${args.join(" ")} exited ${result.status}`);
  }
  return result.status ?? 1;
};

/** stdout of `bin`, trimmed. Exit status is ignored: `systemctl is-enabled`
 * exits non-zero for a disabled unit while still printing the answer. */
const capture = (bin, args) => {
  const result = NodeChildProcess.spawnSync(bin, args, { encoding: "utf8" });
  return (result.stdout ?? "").trim();
};

function fail(message) {
  console.error(`\nt3o-service: ${message}`);
  process.exit(1);
}

/**
 * The pid listening on `port`, and the systemd unit that owns it.
 *
 * The unit comes from the process cgroup rather than from systemctl, because
 * the holder may be a hand-written unit, a stray `npx t3`, or a dev server —
 * and each of those needs a different message.
 */
function portHolder(port) {
  const line = capture("ss", ["-H", "-ltnp"])
    .split("\n")
    .find((entry) => new RegExp(`:${port}\\s`).test(entry));
  if (!line) return undefined;
  const pid = line.match(/pid=(\d+)/)?.[1];
  if (!pid) return { pid: undefined, unit: undefined, cmd: undefined };
  const cgroup = NodeFS.existsSync(`/proc/${pid}/cgroup`)
    ? NodeFS.readFileSync(`/proc/${pid}/cgroup`, "utf8")
    : "";
  return {
    pid,
    unit: cgroup.match(/\/([\w.@-]+\.service)/)?.[1],
    cmd: capture("ps", ["-o", "cmd=", "-p", pid]),
  };
}

/**
 * PATH for the unit. systemd hands a service a bare PATH, so every provider CLI
 * the board spawns has to be named here or agent turns fail at spawn with
 * ENOENT. Resolved now rather than hardcoded, so installing a new provider and
 * re-running this picks it up.
 */
function servicePath() {
  const providerDirs = ["claude", "codex", "cursor-agent", "grok", "opencode", "git", "rg"]
    .map((cli) => capture("sh", ["-c", `command -v ${cli}`]))
    .filter(Boolean)
    .map((binary) => NodePath.dirname(binary));
  return [
    ...new Set([
      NodePath.join(NodeOS.homedir(), ".local/bin"),
      ...providerDirs,
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ]
    .filter((entry) => !entry.includes("node_modules/.bin"))
    .join(":");
}

/**
 * What `--takeover` displaced, so `uninstall` can put it back automatically.
 *
 * Only the name and the enablement state are recorded, because takeover
 * destroys nothing: it runs `systemctl disable --now`, which leaves the unit
 * file on disk and removes only the wants/ symlink. Backing up the unit file
 * would copy something that never went away, while the enablement bit -- the
 * one thing actually lost -- is not recoverable from the filesystem.
 *
 * It lives in the data directory rather than the app directory so that
 * `rm -rf <appDir>`, which uninstall itself suggests, cannot orphan the claim.
 */
const statePath = NodePath.join(t3Home, ".t3o-service-takeover.json");

function readState() {
  if (!NodeFS.existsSync(statePath)) return undefined;
  try {
    return JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
  } catch {
    return undefined;
  }
}

function buildUnit() {
  const secretsFile = NodePath.join(NodeOS.homedir(), ".secrets");
  return `${[
    "[Unit]",
    "Description=T3o server (t3code fork)",
    "After=network-online.target caddy.service",
    "Wants=network-online.target caddy.service",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    `WorkingDirectory=${NodeOS.homedir()}`,
    `Environment="PATH=${servicePath()}"`,
    `Environment="T3CODE_HOME=${t3Home}"`,
    // The bundle ships sourcemaps; without this every stack trace points into
    // bin.mjs and tells you nothing about which source line threw.
    'Environment="NODE_OPTIONS=--enable-source-maps"',
    `EnvironmentFile=-${secretsFile}`,
    `ExecStart=${process.execPath} ${NodePath.join(appDir, "dist/bin.mjs")} serve --host ${values.host} --port ${values.port}`,
    "Restart=on-failure",
    "RestartSec=5",
    // Matches the t3code.service drop-in: keep the kernel from picking the
    // server as its OOM victim when a test run exhausts memory.
    "OOMScoreAdjust=-500",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n")}\n`;
}

/**
 * Install the packages the bundle expects to load from disk beside it.
 *
 * The roots come from the same list that configures the bundler's `neverBundle`
 * (scripts/lib/cli-external-packages.ts), so this cannot drift from what was
 * actually left external. Versions are pinned to what the worktree resolved, so
 * the service runs the code the bundle was built against rather than whatever a
 * range happens to pick up later. npm is skipped entirely when nothing moved.
 */
function syncRuntimeDependencies() {
  const declared = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/server/package.json"), "utf8"),
  ).dependencies;
  const dependencies = Object.fromEntries(
    Object.keys(selectCliRuntimeExternalDependencies(declared))
      .sort()
      .map((name) => {
        const installed = NodePath.join(repoRoot, "apps/server/node_modules", name, "package.json");
        return [
          name,
          NodeFS.existsSync(installed)
            ? JSON.parse(NodeFS.readFileSync(installed, "utf8")).version
            : declared[name],
        ];
      }),
  );

  const manifestPath = NodePath.join(appDir, "package.json");
  const manifest = `${JSON.stringify(
    { name: "t3o-service-runtime", private: true, version: "0.0.0", dependencies },
    null,
    2,
  )}\n`;
  const unchanged =
    NodeFS.existsSync(manifestPath) &&
    NodeFS.readFileSync(manifestPath, "utf8") === manifest &&
    NodeFS.existsSync(NodePath.join(appDir, "node_modules"));
  if (unchanged) {
    console.log("[t3o-service] Native dependencies unchanged.");
    return;
  }

  NodeFS.writeFileSync(manifestPath, manifest);
  console.log(
    `[t3o-service] Installing native dependencies (${Object.keys(dependencies).join(", ")})...`,
  );
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir });
}

const sudoWrite = (path, contents) => {
  const result = NodeChildProcess.spawnSync("sudo", ["tee", path], {
    input: contents,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (result.status !== 0) fail(`could not write ${path} (sudo tee exited ${result.status})`);
};

if (command === "unit") {
  process.stdout.write(buildUnit());
  process.exit(0);
}

if (command === "status") {
  run("systemctl", ["status", unitName, "--no-pager"], { allowFailure: true });
  const displaced = readState()?.displaced;
  if (displaced) {
    console.log(`\n${unitName} took over from ${displaced.unit}, which uninstall will restore.`);
  }
  process.exit(0);
}

if (command === "uninstall") {
  const displaced = readState()?.displaced;

  run("sudo", ["systemctl", "disable", "--now", unitName], { allowFailure: true });
  run("sudo", ["rm", "-f", unitPath]);
  run("sudo", ["systemctl", "daemon-reload"]);

  const restored = [];
  if (displaced && !values["no-restore"]) {
    // Put the port back where --takeover found it. Without this, uninstalling
    // leaves nothing serving and the previous unit still disabled at boot.
    console.log(`[t3o-service] Restoring ${displaced.unit}...`);
    const failed = run(
      "sudo",
      displaced.enabled
        ? ["systemctl", "enable", "--now", displaced.unit]
        : ["systemctl", "start", displaced.unit],
      { allowFailure: true },
    );
    restored.push(
      failed
        ? `Could not restore ${displaced.unit} — start it yourself, it may no longer exist.`
        : `Restored ${displaced.unit} (${displaced.enabled ? "enabled and started" : "started"}).`,
    );
    if (!failed) NodeFS.rmSync(statePath, { force: true });
  } else if (displaced) {
    restored.push(`Left ${displaced.unit} disabled (--no-restore). Nothing is serving ${t3Home}.`);
  }

  console.log(
    [
      `\nRemoved ${unitName}.`,
      ...restored,
      `The synced build is still at ${appDir} — delete it with: rm -rf ${appDir}`,
      `Your data at ${t3Home} was not touched.`,
    ].join("\n"),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// install / sync
// ---------------------------------------------------------------------------

/** Build (unless --no-build) and publish the result into the app directory. */
function deployBuild() {
  if (!values["no-build"]) {
    console.log("[t3o-service] Building (vp run --filter t3 build)...");
    run(NodePath.join(repoRoot, "node_modules/.bin/vp"), ["run", "--filter", "t3", "build"], {
      cwd: repoRoot,
    });
  }

  const distDir = NodePath.join(repoRoot, "apps/server/dist");
  for (const asset of ["bin.mjs", "service-launcher.mjs", "client/index.html"]) {
    if (!NodeFS.existsSync(NodePath.join(distDir, asset))) {
      fail(`missing build asset apps/server/dist/${asset}. Drop --no-build and try again.`);
    }
  }

  console.log(`[t3o-service] Syncing build to ${appDir}...`);
  NodeFS.mkdirSync(appDir, { recursive: true });
  run("rsync", ["-a", "--delete", `${distDir}/`, `${NodePath.join(appDir, "dist")}/`]);
  syncRuntimeDependencies();
}

if (command === "sync") {
  if (capture("systemctl", ["is-active", unitName]) === "active") {
    fail(
      `${unitName} is running and would be reading these files. Use \`pnpm run install-t3o-service\`, which stops it first.`,
    );
  }
  deployBuild();
  console.log(`\nSynced to ${NodePath.join(appDir, "dist")}. Nothing was installed or started.`);
  process.exit(0);
}

// A running service must not be reading the tree while --delete walks it.
const wasActive = capture("systemctl", ["is-active", unitName]) === "active";
if (wasActive) {
  console.log(`[t3o-service] Stopping ${unitName} for the sync...`);
  run("sudo", ["systemctl", "stop", unitName]);
}

deployBuild();

console.log(`[t3o-service] Writing ${unitPath}...`);
sudoWrite(unitPath, buildUnit());
run("sudo", ["systemctl", "daemon-reload"]);

const holder = portHolder(values.port);
const foreignHolder = holder && holder.unit !== unitName ? holder : undefined;

if (foreignHolder && !values.takeover) {
  console.log(
    [
      "",
      `Installed ${unitName}, but did NOT start it: port ${values.port} is already held by`,
      `  ${foreignHolder.unit ?? "an unmanaged process"} (pid ${foreignHolder.pid ?? "?"})`,
      `  ${foreignHolder.cmd ?? ""}`.trimEnd(),
      "",
      `Only one server can own ${t3Home}, so that one has to go first. Note it is`,
      "probably the instance you are reading this through — the switch will drop your session.",
      "",
      "To switch over:",
      ...(foreignHolder.unit
        ? [`  sudo systemctl disable --now ${foreignHolder.unit}`]
        : [`  kill ${foreignHolder.pid ?? "<pid>"}`]),
      `  sudo systemctl enable --now ${unitName}`,
      "",
      "Or re-run with --takeover to do both.",
    ].join("\n"),
  );
  process.exit(0);
}

if (foreignHolder?.unit) {
  console.log(`[t3o-service] Taking over from ${foreignHolder.unit}...`);
  const displaced = {
    unit: foreignHolder.unit,
    enabled: capture("systemctl", ["is-enabled", foreignHolder.unit]) === "enabled",
  };
  run("sudo", ["systemctl", "disable", "--now", foreignHolder.unit]);
  NodeFS.mkdirSync(t3Home, { recursive: true });
  NodeFS.writeFileSync(
    statePath,
    `${JSON.stringify({ displaced, takenOverAt: new Date().toISOString() }, null, 2)}\n`,
  );
} else if (foreignHolder?.pid) {
  fail(
    `port ${values.port} is held by pid ${foreignHolder.pid}, which is not a systemd unit. Stop it yourself, then re-run.`,
  );
}

run("sudo", ["systemctl", "enable", unitName]);
run("sudo", ["systemctl", wasActive || values.takeover ? "restart" : "start", unitName]);

console.log(
  [
    "",
    `${unitName} is running from ${NodePath.join(appDir, "dist")}`,
    `  data:    ${t3Home}`,
    `  listen:  http://${values.host}:${values.port}`,
    "",
    "Pairing URL (printed once at startup):",
    `  journalctl -u ${unitName} -n 200 --no-pager | grep -i 'Pairing URL'`,
    "",
    "After the next code change: pnpm run install-t3o-service",
  ].join("\n"),
);
