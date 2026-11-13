// @effect-diagnostics nodeBuiltinImport:off - a plain Node runner; no Effect runtime to provide.
// @effect-diagnostics globalConsole:off globalDate:off - it times suites and reports on stdout.
// T3o: every workspace test suite but mobile, desktop and marketing, one after another (T3O-88).
//
//   vp run t3o:test-full
//
// Suites run serially: concurrent vitest runs race on node_modules/.vitest-cache. Each runs even
// after an earlier one failed. Writes .t3/test-full/summary.json. The upstream-sync CI pass and the
// nightly task run this; agents never run it in a turn.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { readWorkspace } from "../.github/scripts/ci-changes.cjs";
import {
  packageTestCommand,
  prepareEnvironment,
  ROOT,
  runSuite,
  type SuiteResult,
} from "./t3o-ci.ts";

const EXCLUDED = new Set(["@t3tools/mobile", "@t3tools/desktop", "@t3tools/marketing"]);
// Split so each project reports on its own.
const SPLIT: Record<string, ReadonlyArray<{ readonly name: string; readonly command: string }>> = {
  "apps/server": [
    { name: "server board project", command: "vp test run --project board" },
    { name: "server project", command: "vp test run --project server" },
  ],
  "apps/web": [
    { name: "web unit", command: "vp test run --passWithNoTests --project unit" },
    { name: "web browser", command: "vp test run --passWithNoTests --project browser" },
  ],
};

function fullSuites() {
  return readWorkspace()
    .filter((pkg) => pkg.hasTest && !EXCLUDED.has(pkg.name))
    .flatMap((pkg) =>
      (SPLIT[pkg.dir] ?? [{ name: pkg.dir, command: packageTestCommand(pkg.dir) }]).map(
        (suite) => ({ ...suite, dir: pkg.dir }),
      ),
    );
}

async function main() {
  const started = Date.now();
  const commit = NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const out = NodePath.join(ROOT, ".t3/test-full/summary.json");
  NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });

  const results: Array<SuiteResult> = [];
  let infra: string | null = null;
  if (!NodeFS.existsSync(NodePath.join(ROOT, "node_modules/.bin/vp"))) {
    infra =
      "dependencies are not installed: run pnpm install --frozen-lockfile --prefer-offline --yes";
  } else {
    prepareEnvironment();
    for (const suite of fullSuites()) results.push(await runSuite(suite));
    const infraSuite = results.find((result) => result.status === "infra");
    if (infraSuite) {
      infra = `${infraSuite.name}: ${infraSuite.infraReason ?? "infrastructure failure"}${
        /playwright/i.test(infraSuite.infraReason ?? "")
          ? " (install it with: pnpm exec playwright install chromium)"
          : ""
      }`;
    }
  }

  const ok = infra === null && results.every((result) => result.status === "pass");
  const summary = {
    commit,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    ok,
    infra,
    passed: results.reduce((sum, result) => sum + result.passed, 0),
    failed: results.reduce((sum, result) => sum + result.failed, 0),
    suites: results.map(({ name, dir, status, durationMs, passed, failed, failures }) => ({
      name,
      dir,
      status,
      durationMs,
      passed,
      failed,
      failures,
    })),
  };
  NodeFS.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);

  console.log("\nt3o:test-full summary");
  for (const result of results) {
    const seconds = Math.round(result.durationMs / 1000);
    console.log(
      `  ${result.status.padEnd(5)} ${result.name}  ${seconds}s  (${result.passed} passed, ${result.failed} failed)`,
    );
    for (const failure of result.failures)
      console.log(`        ${failure.file} > ${failure.test}: ${failure.error}`);
  }
  if (infra) console.log(`  INFRA ${infra}`);
  console.log(
    `  ${ok ? "PASS" : "FAIL"} in ${Math.round(summary.durationMs / 1000)}s; ${NodePath.relative(ROOT, out)}`,
  );
  if (!ok) process.exitCode = 1;
}

if (import.meta.main) await main();
