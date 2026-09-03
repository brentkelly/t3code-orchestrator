#!/usr/bin/env node
/**
 * Pack the built server as an installable npm tarball, without publishing.
 *
 * Upstream only ever ships `t3` through `npm publish` (apps/server/scripts/cli.ts
 * publish). A fork has no registry, so this does the same package.json rewrite
 * -- resolve `catalog:` specs against pnpm-workspace.yaml, drop workspace-only
 * devDependencies -- then runs `npm pack` against a staged copy of the build.
 *
 * Staging matters: the publish path mutates apps/server/package.json in place and
 * restores it afterwards. This never touches the working tree, so an interrupted
 * run cannot leave the repo holding a rewritten manifest.
 *
 * Usage:
 *   vp run --filter t3 build         # build first (web + server bundle)
 *   node scripts/t3o-pack.mjs        # -> dist-npm/t3-0.0.37.tgz
 *   node scripts/t3o-pack.mjs --name t3o --version 0.0.37-t3o.1
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parse as parseYaml } from "yaml";

const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const serverDir = NodePath.join(repoRoot, "apps/server");

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const serverPackageJson = JSON.parse(
  NodeFS.readFileSync(NodePath.join(serverDir, "package.json"), "utf8"),
);
const workspace = parseYaml(
  NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
);
const catalog = workspace.catalog ?? {};

const packageName = flag("name", serverPackageJson.name);
const binName = flag("bin", packageName);
const version = flag("version", serverPackageJson.version);
const outDir = NodePath.resolve(repoRoot, flag("out", "dist-npm"));

// The publish path asserts these three before it will ship anything: the CLI
// entry, the Windows service launcher, and the bundled web client.
const requiredAssets = ["dist/bin.mjs", "dist/service-launcher.mjs", "dist/client/index.html"];
for (const relativePath of requiredAssets) {
  if (!NodeFS.existsSync(NodePath.join(serverDir, relativePath))) {
    console.error(
      `Missing build asset: apps/server/${relativePath}\nRun \`vp run --filter t3 build\` first.`,
    );
    process.exit(1);
  }
}

/** Replace every `catalog:` spec with the concrete version from the workspace catalog. */
const resolveCatalog = (dependencies) =>
  Object.fromEntries(
    Object.entries(dependencies ?? {}).map(([name, spec]) => {
      if (typeof spec !== "string" || !spec.startsWith("catalog:")) return [name, spec];
      const key = spec.slice("catalog:".length).trim() || name;
      const resolved = catalog[key];
      if (!resolved) {
        console.error(
          `Unable to resolve '${spec}' for dependency '${name}' (catalog key '${key}')`,
        );
        process.exit(1);
      }
      return [name, resolved];
    }),
  );

const manifest = {
  name: packageName,
  version,
  license: serverPackageJson.license,
  repository: serverPackageJson.repository,
  bin: { [binName]: "./dist/bin.mjs" },
  type: serverPackageJson.type,
  engines: serverPackageJson.engines,
  files: serverPackageJson.files,
  dependencies: resolveCatalog(serverPackageJson.dependencies),
};

// pnpm's `overrides` are deliberately not carried over. Upstream publishes with
// pnpm, so its manifest can use pnpm-only selectors (`parent>child`) and pnpm's
// `"-"` removal marker; npm rejects both. Their only job is pruning unused
// platform binaries, so dropping them costs install size, not correctness.

const stageDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-pack-"));
try {
  NodeFS.cpSync(NodePath.join(serverDir, "dist"), NodePath.join(stageDir, "dist"), {
    recursive: true,
  });
  NodeFS.writeFileSync(
    NodePath.join(stageDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  NodeFS.mkdirSync(outDir, { recursive: true });
  const packed = NodeChildProcess.spawnSync("npm", ["pack", "--pack-destination", outDir], {
    cwd: stageDir,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (packed.status !== 0) process.exit(packed.status ?? 1);

  const tarball = NodePath.join(outDir, packed.stdout.trim().split("\n").at(-1));
  console.log(
    `\nPacked ${packageName}@${version}\n  ${tarball}\n\nInstall with:\n  npm i -g ${tarball}\n`,
  );
} finally {
  NodeFS.rmSync(stageDir, { recursive: true, force: true });
}
