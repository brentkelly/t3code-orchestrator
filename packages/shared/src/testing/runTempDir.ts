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
 * One temp folder per test run, deleted at teardown, so leaked temp files and
 * browser profiles can't pile up in $TMPDIR. A repo-root run calls the setup once
 * per project in one process; they share the folder and the last teardown removes
 * it. The name stays short: unix socket paths are capped at 104-108 bytes.
 */
interface RunTempDir {
  readonly dir: string;
  readonly previous: Readonly<Record<"TMPDIR" | "TMP" | "TEMP", string | undefined>>;
  refs: number;
}

const STATE_KEY = Symbol.for("t3o.runTempDir");
const state = globalThis as { [STATE_KEY]?: RunTempDir };

function removeRunTempDir(run: RunTempDir) {
  if (state[STATE_KEY] !== run) return;
  delete state[STATE_KEY];
  for (const [key, value] of Object.entries(run.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  NodeFS.rmSync(run.dir, { recursive: true, force: true });
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
  const run: RunTempDir = {
    dir,
    previous: { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP },
    refs: 0,
  };
  state[STATE_KEY] = run;
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
  // A run that never reaches teardown (Ctrl-C, a runner crash) still cleans up.
  process.once("exit", () => removeRunTempDir(run));
  return run;
}

export default function setup(project: TestProject) {
  const run = ensureRunTempDir();
  run.refs += 1;
  project.provide("t3oRunTempDir", run.dir);
  return () => {
    run.refs -= 1;
    if (run.refs === 0) removeRunTempDir(run);
  };
}
