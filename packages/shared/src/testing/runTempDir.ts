// @effect-diagnostics nodeBuiltinImport:off - vitest globalSetup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { TestProject } from "vite-plus/test/node";

declare module "vite-plus/test" {
  interface ProvidedContext {
    t3oRunTempDir: string;
  }
}

/**
 * One temp folder per test run, deleted when the runner process exits, so leaked
 * temp files and browser profiles can't pile up in $TMPDIR. A repo-root run calls
 * the setup once per project in one process; they share the folder. The name stays
 * short: unix socket paths are capped at 104-108 bytes.
 */
interface RunTempDir {
  readonly dir: string;
}

const STATE_KEY = Symbol.for("t3o.runTempDir");
const state = globalThis as { [STATE_KEY]?: RunTempDir };

// Not in global teardown: Vitest runs that before it stops the workers and the
// browser, which still write here, and a concurrent write makes rmSync throw.
function removeRunTempDir(run: RunTempDir) {
  try {
    NodeFS.rmSync(run.dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Leftovers go to .t3/cleanup.sh; a cleanup failure must not fail a green run.
  }
}

/**
 * Creates the run folder and points this process's TMPDIR/TMP/TEMP at it, so
 * browsers and subprocesses launched from here land in it. Idempotent. A config
 * calls it directly when something it starts (Vitest's warm Playwright launch)
 * runs before globalSetup.
 */
export function ensureRunTempDir(): RunTempDir {
  const existing = state[STATE_KEY];
  if (existing) return existing;
  const dir = NodePath.join(NodeOS.tmpdir(), `t3o-tr-${process.pid}`);
  NodeFS.mkdirSync(dir, { recursive: true });
  const run: RunTempDir = { dir };
  state[STATE_KEY] = run;
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
  process.once("exit", () => removeRunTempDir(run));
  return run;
}

export default function setup(project: TestProject) {
  project.provide("t3oRunTempDir", ensureRunTempDir().dir);
}
