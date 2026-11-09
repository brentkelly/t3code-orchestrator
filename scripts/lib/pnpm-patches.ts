// @effect-diagnostics nodeBuiltinImport:off - runs from scripts/t3o-service.mjs, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** `name@version` -> patch file (repo-relative), from pnpm-workspace.yaml. */
export function readPatchedDependencies(workspaceYaml: string): Map<string, string> {
  // The block is flat `name@version: patches/<file>` entries, keys sometimes
  // quoted. Reading it beats hardcoding a list that would drift on every sync.
  const block = workspaceYaml.match(/^patchedDependencies:\n((?:[ \t]+\S.*\n)*)/m)?.[1] ?? "";
  const patches = new Map(
    [...block.matchAll(/^\s+"?([^"\s:]+)"?:\s*(\S+)\s*$/gm)].map(
      ([, key, file]) => [key, file] as [string, string],
    ),
  );
  if (patches.size === 0) {
    throw new Error(
      "no patchedDependencies found in pnpm-workspace.yaml — has the format changed?",
    );
  }
  return patches;
}

interface ApplyPnpmPatchesOptions {
  readonly repoRoot: string;
  readonly modulesDir: string;
  readonly patches: ReadonlyMap<string, string>;
  /** Restore missing packages from the existing manifest (a plain `npm install`). */
  readonly reinstall: () => void;
  readonly log?: (line: string) => void;
}

const gitApplies = (packageDir: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync("git", ["apply", ...args], { cwd: packageDir, stdio: "ignore" })
    .status === 0;

const readVersion = (packageDir: string): string | undefined => {
  const packageJson = NodePath.join(packageDir, "package.json");
  if (!NodeFS.existsSync(packageJson)) return undefined;
  return JSON.parse(NodeFS.readFileSync(packageJson, "utf8")).version;
};

const listInstalled = (modulesDir: string) =>
  NodeFS.readdirSync(modulesDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith(".")) return [];
    if (!entry.name.startsWith("@")) return [entry.name];
    return NodeFS.readdirSync(NodePath.join(modulesDir, entry.name)).map(
      (scoped) => `${entry.name}/${scoped}`,
    );
  });

/**
 * A patch matching neither direction changed since it was applied: delete the
 * package, restore it with one `reinstall()`, and patch afresh. Throws if it
 * still will not apply, rather than leave a half-patched package behind.
 */
export function applyPnpmPatches({
  repoRoot,
  modulesDir,
  patches,
  reinstall,
  log = console.log,
}: ApplyPnpmPatchesOptions): void {
  const toPatch: Array<{ name: string; patch: string }> = [];
  const stale: Array<string> = [];

  for (const name of listInstalled(modulesDir)) {
    const packageDir = NodePath.join(modulesDir, name);
    const version = readVersion(packageDir);
    if (version === undefined) continue;
    const patch = patches.get(`${name}@${version}`);
    if (patch === undefined) continue;

    const patchPath = NodePath.join(repoRoot, patch);
    if (gitApplies(packageDir, ["--reverse", "--check", patchPath])) continue;
    toPatch.push({ name, patch });
    if (!gitApplies(packageDir, ["--check", patchPath])) {
      log(`[t3o-service] ${name}@${version}: ${patch} changed since it was applied; reinstalling.`);
      stale.push(name);
    }
  }

  if (stale.length > 0) {
    for (const name of stale) {
      NodeFS.rmSync(NodePath.join(modulesDir, name), { recursive: true, force: true });
    }
    // npm trusts its hidden lockfile over the tree; without it gone, npm
    // would not notice the deleted directories and reinstall nothing.
    NodeFS.rmSync(NodePath.join(modulesDir, ".package-lock.json"), { force: true });
    reinstall();
  }

  for (const { name, patch } of toPatch) {
    const packageDir = NodePath.join(modulesDir, name);
    const patchPath = NodePath.join(repoRoot, patch);
    log(`[t3o-service] Patching ${name}@${readVersion(packageDir)} with ${patch}...`);
    const result = NodeChildProcess.spawnSync("git", ["apply", patchPath], {
      cwd: packageDir,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(
        `could not apply ${patch} to ${packageDir}.\n` +
          `Delete the install and let it rebuild: rm -rf ${modulesDir}`,
      );
    }
  }
}
