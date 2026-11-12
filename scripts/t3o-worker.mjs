#!/usr/bin/env node
/**
 * T3o: `pnpm t3o-worker <join|leave|boards|status|config> …` (T3O-84). Runs the T3o
 * server's own `worker` CLI against the T3o service's home, so a worker needs nothing
 * but a T3o release checkout: `npx t3` and `t3 up` would install upstream's package.
 *
 * `join` on Linux installs the background service first when there is none
 * (`install-t3o-service`, which binds to 127.0.0.1). Elsewhere a T3o server must
 * already be running with this home. See docs/user/board-workers.md#workers.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const argv = process.argv.slice(2).filter((argument) => argument !== "--");
let home = process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3");
const forwarded = [];
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--home") {
    home = argv[index + 1] ?? home;
    index += 1;
  } else if (argument.startsWith("--home=")) {
    home = argument.slice("--home=".length);
  } else {
    forwarded.push(argument);
  }
}
home = NodePath.resolve(home);
const [command] = forwarded;

/** The installed service's build when there is one, else this checkout's. */
function serverBin() {
  for (const candidate of [
    NodePath.join(home, "app/dist/bin.mjs"),
    NodePath.join(repoRoot, "apps/server/dist/bin.mjs"),
  ]) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

function unitExists() {
  const result = NodeChildProcess.spawnSync("systemctl", ["cat", "t3o.service"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function runningServerRecorded() {
  try {
    const state = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, "userdata/server-runtime.json"), "utf8"),
    );
    if (typeof state.pid !== "number") return false;
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`\nt3o-worker: ${message}`);
  process.exit(1);
}

if (command === undefined || command === "--help" || command === "-h") {
  forwarded.splice(0, forwarded.length, "--help");
}

if (command === "join") {
  if (process.platform === "linux") {
    if (!unitExists()) {
      console.log("[t3o-worker] No T3o service on this machine yet: installing it (127.0.0.1 only)…");
      const install = NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(repoRoot, "scripts/t3o-service.mjs"), "install", "--home", home],
        { stdio: "inherit" },
      );
      if (install.status !== 0) fail("installing the T3o service failed; see above.");
    }
  } else if (process.platform === "win32") {
    fail("Windows workers aren't supported yet.");
  } else if (!runningServerRecorded()) {
    fail(
      `on ${process.platform} the worker service isn't installed for you yet. Start a T3o server with this home first (T3CODE_HOME=${home}), keep it running, then run this again.`,
    );
  }
}

const bin = serverBin();
if (bin === null) {
  fail("no built T3o server here. Run `pnpm install && pnpm run install-t3o-service` first.");
}

const result = NodeChildProcess.spawnSync(
  process.execPath,
  [bin, "worker", ...forwarded, ...(forwarded.includes("--help") ? [] : ["--base-dir", home])],
  { stdio: "inherit", env: { ...process.env, T3CODE_HOME: home } },
);
process.exit(result.status ?? 1);
