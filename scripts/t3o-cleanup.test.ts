// @effect-diagnostics nodeBuiltinImport:off - Drives the real cron cleanup script against scratch temp folders.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.resolve(import.meta.dirname, "../.t3/cleanup.sh");
const LONG_AGO = new Date("2020-01-01T00:00:00Z");

function makeEntry(root: string, name: string, age: "old" | "new") {
  const path = NodePath.join(root, name);
  NodeFS.mkdirSync(NodePath.join(path, "nested"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(path, "nested", "data"), "x".repeat(4096));
  if (age === "old") NodeFS.utimesSync(path, LONG_AGO, LONG_AGO);
  return path;
}

function exitedPid() {
  const child = NodeChildProcess.spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(child.stdout.trim());
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(".t3/cleanup.sh", () => {
  it("removes old t3o leftovers and dead runs' folders, and keeps everything else", () => {
    const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cleanup-sh-"));
    try {
      const tmpA = NodePath.join(base, "a");
      const tmpB = NodePath.join(base, "b");
      NodeFS.mkdirSync(tmpA);
      NodeFS.mkdirSync(tmpB);
      const removed = [
        makeEntry(tmpA, "t3o-retire-test-abc123", "old"),
        makeEntry(tmpA, "t3o-ci-log-abc123", "old"),
        makeEntry(tmpA, "gitenv-abc123", "old"),
        makeEntry(tmpA, "1700000000-t3code-git-manager-abc", "old"),
        makeEntry(tmpB, "later-feature-abc123", "old"),
        makeEntry(tmpB, `t3o-tr-${exitedPid()}-abc123`, "old"),
      ];
      const kept = [
        makeEntry(tmpA, "t3o-sweep-recent", "new"),
        makeEntry(tmpA, `t3o-tr-${process.pid}-abc123`, "old"),
        makeEntry(tmpA, "t3o-tr-notapid", "old"),
        makeEntry(tmpA, "playwright_chromiumdev_profile-abc123", "old"),
        makeEntry(tmpB, ".org.chromium.Chromium.abc123", "old"),
        makeEntry(tmpB, "someone-elses-folder", "old"),
      ];

      // A ps that fails (missing, or BusyBox without -p) must not make a live run look dead.
      const fakeBin = NodePath.join(base, "bin");
      NodeFS.mkdirSync(fakeBin);
      NodeFS.writeFileSync(NodePath.join(fakeBin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const { status, stdout, stderr } = NodeChildProcess.spawnSync("sh", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          // The same folder listed twice is cleaned once.
          T3O_CLEANUP_DIRS: `${tmpA} ${tmpB} ${tmpA}/../a`,
        },
        encoding: "utf8",
      });

      expect(status, stdout + stderr).toBe(0);
      for (const path of removed) expect(NodeFS.existsSync(path), path).toBe(false);
      for (const path of kept) expect(NodeFS.existsSync(path), path).toBe(true);
      expect(stdout).toContain("t3o cleanup: removed 6 entries");
      expect(stdout.match(/^removed /gm)).toHaveLength(6);
    } finally {
      NodeFS.rmSync(base, { recursive: true, force: true });
    }
  });
});
