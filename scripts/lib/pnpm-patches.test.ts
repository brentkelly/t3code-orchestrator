// @effect-diagnostics nodeBuiltinImport:off - drives real `git apply` against fixture packages on disk.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { applyPnpmPatches, readPatchedDependencies } from "./pnpm-patches.ts";

const PRISTINE = "line one\nline two\nline three\n";
const OLD_PATCHED = "line one\nline two (old patch)\nline three\n";
const NEW_PATCHED = "line one\nline two (new patch)\nline three\n";
const UNPATCHABLE = "something\nelse\nentirely\n";

const patchFor = (to: string) => {
  const removed = PRISTINE.split("\n")[1];
  const added = to.split("\n")[1];
  return [
    "diff --git a/lib/index.js b/lib/index.js",
    "--- a/lib/index.js",
    "+++ b/lib/index.js",
    "@@ -1,3 +1,3 @@",
    " line one",
    `-${removed}`,
    `+${added}`,
    " line three",
    "",
  ].join("\n");
};

function setup(installed: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-pnpm-patches-"));
  const repoRoot = NodePath.join(root, "repo");
  const modulesDir = NodePath.join(root, "app", "node_modules");
  const packageDir = NodePath.join(modulesDir, "@scope", "fixture");
  const writePackage = (contents: string) => {
    NodeFS.mkdirSync(NodePath.join(packageDir, "lib"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(packageDir, "package.json"),
      JSON.stringify({ name: "@scope/fixture", version: "1.0.0" }),
    );
    NodeFS.writeFileSync(NodePath.join(packageDir, "lib", "index.js"), contents);
  };
  writePackage(installed);
  NodeFS.writeFileSync(NodePath.join(modulesDir, ".package-lock.json"), "{}");
  NodeFS.mkdirSync(NodePath.join(repoRoot, "patches"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repoRoot, "patches", "fixture.patch"), patchFor(NEW_PATCHED));
  const log: Array<string> = [];
  return {
    repoRoot,
    modulesDir,
    packageDir,
    writePackage,
    log,
    read: () => NodeFS.readFileSync(NodePath.join(packageDir, "lib", "index.js"), "utf8"),
    patches: new Map([["@scope/fixture@1.0.0", "patches/fixture.patch"]]),
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

describe("applyPnpmPatches", () => {
  it.each([
    { state: "already patched", installed: NEW_PATCHED },
    { state: "unpatched", installed: PRISTINE },
  ])("leaves an $state package patched without reinstalling", ({ installed }) => {
    using fixture = setup(installed);
    let reinstalls = 0;
    applyPnpmPatches({
      ...fixture,
      reinstall: () => reinstalls++,
      log: (line) => fixture.log.push(line),
    });
    expect(fixture.read()).toBe(NEW_PATCHED);
    expect(reinstalls).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(fixture.modulesDir, ".package-lock.json"))).toBe(true);
  });

  it("reinstalls a package carrying an older patch, once, then applies the current one", () => {
    using fixture = setup(OLD_PATCHED);
    let reinstalls = 0;
    applyPnpmPatches({
      ...fixture,
      reinstall: () => {
        reinstalls++;
        expect(NodeFS.existsSync(fixture.packageDir)).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(fixture.modulesDir, ".package-lock.json"))).toBe(
          false,
        );
        fixture.writePackage(PRISTINE);
      },
      log: (line) => fixture.log.push(line),
    });
    expect(reinstalls).toBe(1);
    expect(fixture.read()).toBe(NEW_PATCHED);
    expect(fixture.log[0]).toContain("@scope/fixture@1.0.0: patches/fixture.patch changed");
  });

  it("reinstalls several stale packages with a single reinstall", () => {
    using fixture = setup(OLD_PATCHED);
    const secondDir = NodePath.join(fixture.modulesDir, "second");
    const writeSecond = (contents: string) => {
      NodeFS.mkdirSync(NodePath.join(secondDir, "lib"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(secondDir, "package.json"),
        JSON.stringify({ name: "second", version: "2.0.0" }),
      );
      NodeFS.writeFileSync(NodePath.join(secondDir, "lib", "index.js"), contents);
    };
    writeSecond(OLD_PATCHED);
    let reinstalls = 0;
    applyPnpmPatches({
      ...fixture,
      patches: new Map([...fixture.patches, ["second@2.0.0", "patches/fixture.patch"]]),
      reinstall: () => {
        reinstalls++;
        fixture.writePackage(PRISTINE);
        writeSecond(PRISTINE);
      },
      log: (line) => fixture.log.push(line),
    });
    expect(reinstalls).toBe(1);
    expect(fixture.read()).toBe(NEW_PATCHED);
    expect(NodeFS.readFileSync(NodePath.join(secondDir, "lib", "index.js"), "utf8")).toBe(
      NEW_PATCHED,
    );
  });

  it("names the package when reinstalling does not restore it", () => {
    using fixture = setup(OLD_PATCHED);
    expect(() => applyPnpmPatches({ ...fixture, reinstall: () => {}, log: () => {} })).toThrow(
      "reinstalling did not restore @scope/fixture",
    );
  });

  it("stops when the patch still will not apply after reinstalling", () => {
    using fixture = setup(OLD_PATCHED);
    expect(() =>
      applyPnpmPatches({
        ...fixture,
        reinstall: () => fixture.writePackage(UNPATCHABLE),
        log: () => {},
      }),
    ).toThrow(`rm -rf ${fixture.modulesDir}`);
  });
});

describe("readPatchedDependencies", () => {
  it("reads plain and quoted keys", () => {
    const patches = readPatchedDependencies(
      [
        "packages:",
        "  - apps/*",
        "patchedDependencies:",
        "  node-pty@1.2.0: patches/node-pty.patch",
        '  "@scope/pkg@1.0.0": patches/@scope__pkg.patch',
        "other: true",
        "",
      ].join("\n"),
    );
    expect([...patches]).toEqual([
      ["node-pty@1.2.0", "patches/node-pty.patch"],
      ["@scope/pkg@1.0.0", "patches/@scope__pkg.patch"],
    ]);
  });

  it("throws when the block is missing", () => {
    expect(() => readPatchedDependencies("packages:\n  - apps/*\n")).toThrow(
      "no patchedDependencies",
    );
  });
});
