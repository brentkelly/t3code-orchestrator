// @effect-diagnostics nodeBuiltinImport:off - plain-Node install script helper.
// @effect-diagnostics globalDate:off - prunes against the plain-Node clock.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const WEB_ASSETS = "client/assets";
const STALE_WEB_ASSET_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Mirror a built `dist/` into the service's app directory. Tabs open across an update still
 * lazy-load the previous build's hashed chunks (a card, a sub-board), so those are kept until
 * they are two weeks old; rsync -a carries each file's build time as its mtime.
 */
export function publishDist(sourceDir: string, targetDir: string, nowMs = Date.now()): void {
  const result = NodeChildProcess.spawnSync(
    "rsync",
    ["-a", "--delete", `--filter=P /${WEB_ASSETS}/**`, `${sourceDir}/`, `${targetDir}/`],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`rsync exited with ${result.status ?? result.signal}`);

  const shipped = new Set(listFiles(NodePath.join(sourceDir, WEB_ASSETS)));
  const assetsDir = NodePath.join(targetDir, WEB_ASSETS);
  const cutoff = nowMs - STALE_WEB_ASSET_MS;
  for (const relative of listFiles(assetsDir)) {
    if (shipped.has(relative)) continue;
    const path = NodePath.join(assetsDir, relative);
    if (NodeFS.statSync(path).mtimeMs < cutoff) NodeFS.rmSync(path, { force: true });
  }
}

function listFiles(dir: string): string[] {
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.relative(dir, NodePath.join(entry.parentPath, entry.name)));
}
