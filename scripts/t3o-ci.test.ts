// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  EMPTY_BOARD_STATE,
  ProjectId,
  parseT3oProjectFile,
  resolveT3oProjectFile,
} from "@t3tools/contracts";

import {
  checkChangedFailures,
  clampFailure,
  classifyInstallFailure,
  detectTier,
  failedTestFiles,
  isMachineFailure,
  isPnpmExeOnlyChange,
  parseVitestJson,
  resolveBase,
  ROOT,
  runSuite,
  stripPnpmExe,
  suiteFailures,
} from "./t3o-ci.ts";

it("imports the committed t3o.json without warnings", () => {
  const parsed = parseT3oProjectFile(NodeFS.readFileSync(NodePath.join(ROOT, "t3o.json"), "utf8"));
  assert.isNull(parsed.warning);
  const { delta } = resolveT3oProjectFile({
    raw: parsed.raw,
    board: EMPTY_BOARD_STATE,
    projectId: ProjectId.make("project-t3o"),
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepStrictEqual(delta.warnings, []);
  assert.deepStrictEqual(
    delta.ci.steps.map((step) => step.id),
    ["install", "changed", "board", "packages", "web", "full"],
  );
  assert.strictEqual(delta.ci.stopOnFailure, false);
});

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.14.0
        version: 12.14.0

packages:

  '@pnpm/exe.win32-x64@12.14.0':
    os: [win32]

  pnpm@12.14.0:
    hasBin: true

snapshots:

  '@pnpm/exe.win32-x64@12.14.0':
    optional: true

  pnpm@12.14.0:
    optionalDependencies:
      '@pnpm/exe.linux-x64': 12.14.0
`;

// What every `pnpm install` on this machine adds.
const WITH_PNPM_EXE = LOCKFILE.replace(
  "    packageManagerDependencies:\n",
  "    packageManagerDependencies:\n      '@pnpm/exe':\n        specifier: 12.14.0\n        version: 12.14.0\n",
)
  .replace(
    "  pnpm@12.14.0:\n    hasBin: true\n",
    "  '@pnpm/exe@12.14.0':\n    resolution: {integrity: sha512-x}\n    hasBin: true\n\n  pnpm@12.14.0:\n    hasBin: true\n",
  )
  .replace(
    "  pnpm@12.14.0:\n    optionalDependencies:\n",
    "  '@pnpm/exe@12.14.0':\n    optionalDependencies:\n      '@pnpm/exe.linux-x64': 12.14.0\n\n  pnpm@12.14.0:\n    optionalDependencies:\n",
  );

describe("lockfile restore", () => {
  it("treats the @pnpm/exe entries alone as a restorable change", () => {
    assert.notStrictEqual(WITH_PNPM_EXE, LOCKFILE);
    assert.strictEqual(stripPnpmExe(WITH_PNPM_EXE), LOCKFILE);
    assert.isTrue(isPnpmExeOnlyChange(LOCKFILE, WITH_PNPM_EXE));
  });

  it("keeps any other lockfile change", () => {
    const edited = WITH_PNPM_EXE.replace("hasBin: true\n\nsnapshots", "hasBin: false\n\nsnapshots");
    assert.isFalse(isPnpmExeOnlyChange(LOCKFILE, edited));
    assert.isFalse(isPnpmExeOnlyChange(LOCKFILE, LOCKFILE));
  });
});

describe("install failures", () => {
  it.each([
    ["ERR_PNPM_FETCH_404 GET https://registry", false, true],
    ["getaddrinfo ENOTFOUND registry.npmjs.org", false, true],
    ["ENOSPC: no space left on device", false, true],
    ["ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY", false, true],
    // A dead network or full disk is the machine's even when the card changes dependencies.
    ["getaddrinfo ENOTFOUND registry.npmjs.org", true, true],
    ["ENOSPC: no space left on device", true, true],
    // Otherwise the card's own dependency change is the fix agent's to repair.
    ["something else", true, false],
    ["ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile", false, false],
    ["ERR_PNPM_UNUSED_PATCH", false, false],
    ["something else", false, false],
  ])("%s (manifests changed: %s) is a machine problem: %s", (output, manifestsChanged, machine) => {
    assert.strictEqual(classifyInstallFailure({ output, manifestsChanged }).machine, machine);
  });
});

describe("failure parsing", () => {
  it("names the failed test files from vitest's output as repo paths", () => {
    const output = [
      " FAIL  |server| src/project/ProjectService.test.ts > ProjectService > retries",
      " FAIL  scripts/check-changed.test.ts > compares",
      " FAIL  |root| scripts/t3o-ci.test.ts > parses",
      " FAIL  |server| src/project/ProjectService.test.ts > ProjectService > other",
      " FAIL  |unit| src/ambiguous.test.ts > a",
      " ✓ src/ok.test.ts",
    ].join("\n");
    const onDisk = new Set([
      "apps/server/src/project/ProjectService.test.ts",
      "apps/web/src/ambiguous.test.ts",
      "packages/shared/src/ambiguous.test.ts",
      "scripts/t3o-ci.test.ts",
    ]);
    const files = failedTestFiles(
      output,
      () => ["apps/server", "apps/web", "packages/shared"],
      (path) => onDisk.has(path),
    );
    assert.deepStrictEqual(files, [
      {
        name: "apps/server/src/project/ProjectService.test.ts",
        file: "apps/server/src/project/ProjectService.test.ts",
      },
      { name: "scripts/check-changed.test.ts", file: "scripts/check-changed.test.ts" },
      { name: "scripts/t3o-ci.test.ts", file: "scripts/t3o-ci.test.ts" },
      { name: "|unit| src/ambiguous.test.ts" },
    ]);
  });

  it("tags check:changed's failed steps by kind", () => {
    const output = [
      " FAIL  |server| src/a.test.ts > a",
      "",
      "check:changed summary",
      "  pass  format  2.1s",
      "  FAIL  lint  4.0s",
      "  TIMEOUT  typecheck (3 packages)  killed after 900s",
      "  FAIL  test (4 files)  30.2s",
      "  FAIL  node --test (1 files)  1.2s",
      "  FAIL  react compiler (2 files)  3.0s",
      "  TIMEOUT: ran past 900s and was killed; this is not a check failure.",
    ].join("\n");
    assert.deepStrictEqual(checkChangedFailures(output), [
      { title: "[lint] lint" },
      { title: "[typecheck] typecheck (3 packages)", detail: "timed out" },
      { title: "[test] |server| src/a.test.ts" },
      { title: "[test] node --test (1 files)" },
    ]);
  });

  it("reads failed tests and unloadable files from the JSON reporter", () => {
    const parsed = parseVitestJson(
      {
        numPassedTests: 3,
        numFailedTests: 1,
        testResults: [
          {
            name: "/repo/apps/server/src/a.test.ts",
            status: "failed",
            assertionResults: [
              { fullName: "a works", status: "passed" },
              {
                fullName: "a fails",
                status: "failed",
                failureMessages: ["\nAssertionError: expected 1 to be 2\n    at x"],
              },
            ],
          },
          {
            name: "/repo/apps/server/src/b.test.ts",
            status: "failed",
            message: "Cannot find module './gone.ts'",
            assertionResults: [],
          },
        ],
      },
      "/repo",
    );
    assert.deepStrictEqual(parsed, {
      passed: 3,
      failed: 1,
      failures: [
        {
          file: "apps/server/src/a.test.ts",
          test: "a fails",
          error: "AssertionError: expected 1 to be 2",
        },
        {
          file: "apps/server/src/b.test.ts",
          test: "(file)",
          error: "Cannot find module './gone.ts'",
        },
      ],
    });
  });
});

describe("suite failures", () => {
  it("names a failure when the suite exits non-zero with every test passing", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-fake-vitest-"));
    try {
      const script = NodePath.join(dir, "vitest.mjs");
      NodeFS.writeFileSync(
        script,
        [
          'import * as fs from "node:fs";',
          'const out = process.argv.find((arg) => arg.startsWith("--outputFile.json="));',
          'fs.writeFileSync(out.slice("--outputFile.json=".length), JSON.stringify({ numPassedTests: 2, numFailedTests: 0, testResults: [] }));',
          'console.error("Unhandled Rejection: boom");',
          "process.exit(1);",
        ].join("\n"),
      );
      const result = await runSuite({ name: "fake", dir: "scripts", command: `node ${script}` });
      assert.strictEqual(result.status, "fail");
      const failures = suiteFailures([result]);
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0]!.title, "[test] scripts > (suite)");
      assert.match(failures[0]!.detail ?? "", /^exited 1: /);
      assert.isFalse(isMachineFailure(failures));
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds for a human only when every failure, and at least one, is the machine's", () => {
    assert.isFalse(isMachineFailure([]));
    assert.isTrue(isMachineFailure([{ title: "[infra] web", machine: true }]));
    assert.isFalse(
      isMachineFailure([{ title: "[infra] web", machine: true }, { title: "[test] a" }]),
    );
  });

  it("clamps a failure to the lengths the board keeps", () => {
    const clamped = clampFailure({ title: "t".repeat(600), detail: "d".repeat(5_000), file: "f" });
    assert.strictEqual(clamped.title.length, 500);
    assert.strictEqual(clamped.detail!.length, 4_000);
    assert.strictEqual(clamped.file, "f");
  });
});

// main: M0, then 60 upstream commits U1..U60. t3o: M0 -> T1. HEAD: a card branch off t3o.
function repo() {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ci-")));
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=T", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const commit = (message: string) => git("commit", "--allow-empty", "-q", "-m", message);
  git("init", "-q", "-b", "main");
  commit("M0");
  git("branch", "t3o");
  for (let index = 1; index <= 60; index++) commit(`U${index}`);
  git("switch", "-q", "t3o");
  commit("T1");
  git("switch", "-q", "-c", "board/card");
  commit("C1");
  return {
    root,
    git,
    commit,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const unforced: { argv: Array<string>; env: NodeJS.ProcessEnv } = { argv: [], env: {} };
const tierOf = (root: string, forced = unforced) => {
  const base = resolveBase(root, { fetch: false });
  assert.isDefined(base);
  return { base: base!, tier: detectTier(base!, root, forced) };
};

describe("base and tier", () => {
  it("runs tier B on an ordinary card branch against t3o", () => {
    using project = repo();
    const { base, tier } = tierOf(project.root);
    assert.strictEqual(base.ref, "t3o");
    assert.strictEqual(base.ahead, 1);
    assert.isFalse(tier.full);
  });

  it("runs the full tier when the branch merges upstream, even with upstream refs gone", () => {
    using project = repo();
    project.git("merge", "-q", "--no-edit", "main");
    assert.isTrue(tierOf(project.root).tier.full);
    project.git("branch", "-q", "-D", "main");
    const { tier } = tierOf(project.root);
    assert.isTrue(tier.full);
    assert.match(tier.reason, /brings in 60 commits/);
  });

  it("stays on tier B after merging t3o into the card", () => {
    using project = repo();
    project.git("switch", "-q", "t3o");
    for (let index = 0; index < 3; index++) project.commit(`T${index + 2}`);
    project.git("switch", "-q", "board/card");
    project.git("merge", "-q", "--no-edit", "t3o");
    const { base, tier } = tierOf(project.root);
    assert.strictEqual(base.ref, "t3o");
    assert.isFalse(tier.full);
  });

  it("forces the full tier with --full or T3O_CI_FULL=1", () => {
    using project = repo();
    assert.isTrue(tierOf(project.root, { argv: ["--full"], env: {} }).tier.full);
    assert.isTrue(tierOf(project.root, { argv: [], env: { T3O_CI_FULL: "1" } }).tier.full);
  });

  it("compares a grouped card against its group branch from the worktree's base config", () => {
    using project = repo();
    project.git("switch", "-q", "-c", "board/group", "t3o");
    project.commit("G1");
    project.git("switch", "-q", "-c", "board/child");
    project.commit("K1");
    project.git("config", "branch.board/child.t3-merge-base", "board/group");
    const { base } = tierOf(project.root);
    assert.strictEqual(base.ref, "board/group");
    assert.strictEqual(base.ahead, 1);
  });
});
