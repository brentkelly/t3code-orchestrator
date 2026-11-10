// @effect-diagnostics nodeBuiltinImport:off - installs shims into a real temp bin dir.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  SHIM_MARKER,
  gitconfigAdvice,
  installGitShims,
  shimScript,
  uninstallGitShims,
} from "./t3o-git-shims.ts";

function setup() {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-shims-"));
  const binDir = NodePath.join(base, "bin");
  const target = {
    binDir,
    nodePath: "/usr/local/bin/node",
    entryPath: NodePath.join(base, "app's dist", "t3oGitCredential.mjs"),
    gitenvFile: NodePath.join(base, "userdata", "gitenv"),
  };
  return { base, binDir, target };
}

describe("installGitShims", () => {
  it("writes both shims and moves a foreign gh aside, which uninstall restores", () => {
    const { binDir, target } = setup();
    NodeFS.mkdirSync(binDir);
    const handMade = "#!/bin/sh\n# hand-made wrapper\n";
    NodeFS.writeFileSync(NodePath.join(binDir, "gh"), handMade, { mode: 0o755 });

    const notes = installGitShims(target);
    expect(notes.some((note) => note.includes("gh.bak"))).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(binDir, "gh.bak"), "utf8")).toBe(handMade);
    for (const name of ["gh", "t3-git-credential"]) {
      const file = NodePath.join(binDir, name);
      expect(NodeFS.readFileSync(file, "utf8")).toContain(SHIM_MARKER);
      expect(NodeFS.statSync(file).mode & 0o111).not.toBe(0);
    }

    // Re-running over our own shims is a plain rewrite, with the backup untouched.
    installGitShims(target);
    expect(NodeFS.readFileSync(NodePath.join(binDir, "gh.bak"), "utf8")).toBe(handMade);

    uninstallGitShims(binDir);
    expect(NodeFS.readFileSync(NodePath.join(binDir, "gh"), "utf8")).toBe(handMade);
    expect(NodeFS.existsSync(NodePath.join(binDir, "gh.bak"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(binDir, "t3-git-credential"))).toBe(false);
  });

  it("leaves a foreign gh alone when a gh.bak already exists", () => {
    const { binDir, target } = setup();
    NodeFS.mkdirSync(binDir);
    NodeFS.writeFileSync(NodePath.join(binDir, "gh"), "#!/bin/sh\n# mine\n");
    NodeFS.writeFileSync(NodePath.join(binDir, "gh.bak"), "#!/bin/sh\n# older\n");
    const notes = installGitShims(target);
    expect(notes.at(-1)).toContain("Left");
    expect(NodeFS.readFileSync(NodePath.join(binDir, "gh"), "utf8")).toBe("#!/bin/sh\n# mine\n");
    expect(NodeFS.existsSync(NodePath.join(binDir, "t3-git-credential"))).toBe(true);
  });
});

describe("shimScript", () => {
  it("passes its arguments through, quoting paths with spaces and quotes", () => {
    const { base, target } = setup();
    const echo = NodePath.join(base, "echo-node");
    // Stand in for node: print the argv the shim hands it.
    NodeFS.writeFileSync(echo, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const shim = NodePath.join(base, "gh-shim");
    NodeFS.writeFileSync(shim, shimScript({ ...target, nodePath: echo }, "gh"), { mode: 0o755 });
    const output = NodeChildProcess.execFileSync(shim, ["pr", "list", "-R", "a b"], {
      encoding: "utf8",
    });
    expect(output.split("\n").slice(0, -1)).toEqual([
      target.entryPath,
      "--file",
      target.gitenvFile,
      "gh",
      "pr",
      "list",
      "-R",
      "a b",
    ]);
  });
});

describe("gitconfigAdvice", () => {
  it("prints the lines only when the T3o helper is not configured", () => {
    expect(gitconfigAdvice([""])).toContain("helper = !t3-git-credential");
    expect(gitconfigAdvice(["", "!t3-git-credential", "!gh auth git-credential"])).toBeNull();
  });
});
