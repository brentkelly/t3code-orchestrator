// @effect-diagnostics nodeBuiltinImport:off - Drives the globalSetup in a child process, as a Vitest runner would.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SETUP_URL = NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "runTempDir.ts")).href;

// Vitest runs global teardown before it closes the workers and the browser, so the
// folder must outlive teardown and go only when the runner process exits.
const RUNNER = `
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const stale = NodePath.join(process.env.TMPDIR, \`t3o-tr-\${process.pid}\`);
NodeFS.mkdirSync(stale);
NodeFS.writeFileSync(NodePath.join(stale, "stale"), "x");
const { default: setup } = await import(${JSON.stringify(SETUP_URL)});
let dir;
const teardown = setup({ provide: (_key, value) => { dir = value; } });
if (typeof teardown === "function") teardown();
const alive = NodeFS.existsSync(dir);
if (alive) NodeFS.writeFileSync(NodePath.join(dir, "late-write"), "x");
console.log(JSON.stringify({ dir, stale, aliveAfterTeardown: alive }));
`;

describe("runTempDir globalSetup", () => {
  it("makes a fresh run folder, keeps it through teardown and removes it when the runner exits", () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "run-temp-dir-"));
    try {
      const { status, stdout, stderr } = NodeChildProcess.spawnSync(
        process.execPath,
        ["--input-type=module", "-e", RUNNER],
        { env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent }, encoding: "utf8" },
      );
      expect(status, stderr).toBe(0);
      const { dir, stale, aliveAfterTeardown } = JSON.parse(stdout);
      expect(NodePath.dirname(dir)).toBe(parent);
      // A leftover folder under the pid's name is neither adopted nor deleted.
      expect(dir).not.toBe(stale);
      expect(NodeFS.existsSync(NodePath.join(stale, "stale"))).toBe(true);
      expect(aliveAfterTeardown).toBe(true);
      expect(NodeFS.existsSync(dir)).toBe(false);
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  });
});
