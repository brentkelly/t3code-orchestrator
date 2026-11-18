// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { inject } from "vite-plus/test";
import * as HostProcess from "../HostProcess.ts";
import type {} from "./runTempDir.ts";

// The run's own temp folder from runTempDir.ts; absent when a config has no globalSetup.
const runTempDir = inject("t3oRunTempDir");
if (runTempDir) {
  process.env.TMPDIR = runTempDir;
  process.env.TMP = runTempDir;
  process.env.TEMP = runTempDir;
}

// Windows runner temp paths use 8.3 names; canonicalize to long names before equality checks.
if (HostProcess.Platform.defaultValue() === "win32") {
  try {
    const longForm = NodeFS.realpathSync.native(NodeOS.tmpdir());
    process.env.TEMP = longForm;
    process.env.TMP = longForm;
  } catch {}
}
