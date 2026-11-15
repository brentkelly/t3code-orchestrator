#!/usr/bin/env node
/**
 * T3o: `pnpm t3o-worker auto-update [--check | --install | --uninstall]`. Runs `t3o-update` when a
 * board this worker serves says it is too old, read from the server's `worker-status.json`.
 * `--install` adds a systemd timer that checks every two minutes. See docs/user/board-workers.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { AUTO_UPDATE_STATE_FILE, decideAutoUpdate } from "./lib/t3o-auto-update.ts";
import { parseUnitFile } from "./lib/t3o-release.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const { values } = NodeUtil.parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== "--"),
  options: {
    check: { type: "boolean", default: false },
    install: { type: "boolean", default: false },
    uninstall: { type: "boolean", default: false },
    unit: { type: "string", default: "t3o" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    [
      "Usage: pnpm t3o-worker auto-update [flags]",
      "",
      "  (no flag)       Update now if a board says this worker needs it",
      "  --check         Report only. Exits 10 when an update is needed",
      "  --install       Add a systemd timer that runs this every two minutes",
      "  --uninstall     Remove that timer",
      "  --unit <name>   The T3o service, without .service (default t3o)",
    ].join("\n"),
  );
  process.exit(0);
}

function fail(message) {
  console.error(`t3o-auto-update: ${message}`);
  process.exit(1);
}

const log = (message) => console.log(`[t3o-auto-update] ${message}`);
// `-k` ignores sudo's credential cache, so a password typed moments ago doesn't pass the probe.
const sudoWorks = () => NodeChildProcess.spawnSync("sudo", ["-k", "-n", "true"]).status === 0;
if (!/^[A-Za-z0-9@._-]+$/.test(values.unit)) {
  fail(`--unit must be a systemd unit name without .service, got ${JSON.stringify(values.unit)}`);
}
const timerName = `${values.unit}-auto-update`;
const timerDir = "/etc/systemd/system";

function run(bin, args, { allowFailure = false } = {}) {
  const result = NodeChildProcess.spawnSync(bin, args, { stdio: "inherit" });
  if (result.status !== 0 && !allowFailure)
    fail(`${bin} ${args.join(" ")} exited ${result.status}`);
}

function sudoWrite(path, contents) {
  const result = NodeChildProcess.spawnSync("sudo", ["tee", path], {
    input: contents,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (result.status !== 0) fail(`could not write ${path} (sudo tee exited ${result.status})`);
}

if (values.uninstall) {
  run("sudo", ["systemctl", "disable", "--now", `${timerName}.timer`], { allowFailure: true });
  run("sudo", [
    "rm",
    "-f",
    NodePath.join(timerDir, `${timerName}.timer`),
    NodePath.join(timerDir, `${timerName}.service`),
  ]);
  run("sudo", ["systemctl", "daemon-reload"]);
  log(`Removed ${timerName}.timer.`);
  process.exit(0);
}

const unitPath = NodePath.join(timerDir, `${values.unit}.service`);
let settings;
try {
  settings = parseUnitFile(NodeFS.readFileSync(unitPath, "utf8"));
} catch (error) {
  fail(
    `cannot read ${unitPath}: ${error instanceof Error ? error.message : String(error)}. Auto-update needs the systemd install (\`pnpm run install-t3o-service\`).`,
  );
}

/** One ExecStart word, quoted for systemd: `%` starts a specifier there. */
const unitWord = (word) =>
  `"${word.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

if (values.install) {
  // Probe before the sudo calls below refresh the credential cache.
  const passwordlessSudo = sudoWorks();
  const service = [
    "[Unit]",
    `Description=T3o worker auto-update (${values.unit}.service)`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `User=${NodeOS.userInfo().username}`,
    `WorkingDirectory=${repoRoot.replaceAll("%", "%%")}`,
    `Environment="PATH=${NodePath.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin"`,
    `ExecStart=${[process.execPath, NodePath.join(repoRoot, "scripts/t3o-auto-update.mjs"), "--unit", values.unit].map(unitWord).join(" ")}`,
  ];
  const timer = [
    "[Unit]",
    `Description=Check every two minutes whether ${values.unit}.service needs a T3o update`,
    "",
    "[Timer]",
    "OnBootSec=2min",
    "OnUnitInactiveSec=2min",
    "",
    "[Install]",
    "WantedBy=timers.target",
  ];
  sudoWrite(NodePath.join(timerDir, `${timerName}.service`), `${service.join("\n")}\n`);
  sudoWrite(NodePath.join(timerDir, `${timerName}.timer`), `${timer.join("\n")}\n`);
  run("sudo", ["systemctl", "daemon-reload"]);
  run("sudo", ["systemctl", "enable", "--now", `${timerName}.timer`]);
  log(`Installed ${timerName}.timer. Its runs log to \`journalctl -u ${timerName}\`.`);
  if (!passwordlessSudo) {
    log(
      `Warning: ${NodeOS.userInfo().username} can't sudo without a password, and an update reinstalls the service with sudo. Allow it, or the timer's updates will fail.`,
    );
  }
  process.exit(0);
}

function readJson(path) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const status = readJson(NodePath.join(settings.home, "worker-status.json"));
const statePath = NodePath.join(settings.home, AUTO_UPDATE_STATE_FILE);
const state = readJson(statePath);
const decision = decideAutoUpdate({
  status,
  serverAlive: alive(status?.pid),
  lastAttemptAt: typeof state?.lastAttemptAt === "number" ? state.lastAttemptAt : null,
  now: Date.now(),
});

const interactive = values.check || process.stdout.isTTY;
if (decision.kind === "idle") {
  if (decision.forgetAttempt) NodeFS.rmSync(statePath, { force: true });
  // The timer runs this every two minutes: idle and wait ticks write nothing to the journal.
  if (interactive) log(`Up to date: ${decision.reason}`);
  process.exit(0);
}
const reasons = decision.reasons.map((reason) => `  ${reason}`).join("\n");
if (values.check || decision.kind === "wait") {
  if (interactive)
    log(
      decision.kind === "wait"
        ? `An update is needed, but the last attempt didn't clear it; retrying after ${decision.retryAt}:\n${reasons}`
        : `An update is needed:\n${reasons}`,
    );
  process.exit(values.check ? 10 : 0);
}

const record = (outcome) =>
  NodeFS.writeFileSync(statePath, `${JSON.stringify({ lastAttemptAt: Date.now(), outcome })}\n`);

log(`Updating:\n${reasons}`);
if (!process.stdin.isTTY && !sudoWorks()) {
  record("no-sudo");
  fail(
    `the update reinstalls ${values.unit}.service with sudo, and ${NodeOS.userInfo().username} can't sudo without a password here.`,
  );
}
const result = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(repoRoot, "scripts/t3o-update.mjs"), "--yes", "--unit", values.unit],
  { cwd: repoRoot, stdio: "inherit" },
);
record(result.status === 0 ? "ran" : `exited ${result.status}`);
process.exit(result.status ?? 1);
