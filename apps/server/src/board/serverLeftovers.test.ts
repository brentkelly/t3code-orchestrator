// @effect-diagnostics nodeBuiltinImport:off - a real home and temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { sweepServerLeftovers } from "./serverLeftovers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

const aged = (path: string, ageMs: number) => {
  const at = (NOW - ageMs) / 1000;
  NodeFS.utimesSync(path, at, at);
};

describe("sweepServerLeftovers (T3O-123)", () => {
  it("removes stale status temp files and dead browser profiles, nothing else", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-leftovers-"));
    roots.push(root);
    const home = NodePath.join(root, "home");
    const temp = NodePath.join(root, "tmp");
    NodeFS.mkdirSync(home);
    NodeFS.mkdirSync(temp);
    const file = (dir: string, name: string, ageMs: number) => {
      const path = NodePath.join(dir, name);
      NodeFS.writeFileSync(path, "{}");
      aged(path, ageMs);
      return path;
    };
    const profile = (name: string, ageMs: number, lock: string | null) => {
      const path = NodePath.join(temp, `playwright_chromiumdev_profile-${name}`);
      NodeFS.mkdirSync(path);
      if (lock !== null) NodeFS.symlinkSync(lock, NodePath.join(path, "SingletonLock"));
      aged(path, ageMs);
      return path;
    };
    const staleTemp = file(home, "worker-status.json.123.456.tmp", 2 * HOUR);
    file(home, "worker-status.json.123.789.tmp", HOUR / 2);
    file(home, "worker-status.json", 5 * HOUR);
    file(home, "other.json.1.2.tmp", 5 * HOUR);
    const deadProfile = profile("dead", 25 * HOUR, "host-a-4242");
    const unlocked = profile("unlocked", 25 * HOUR, null);
    profile("live", 25 * HOUR, "host-a-7");
    profile("young", HOUR, null);
    const otherHost = profile("other-host", 25 * HOUR, "host-b-7");

    const removed = await sweepServerLeftovers({
      home,
      tempDir: temp,
      nowMs: NOW,
      uid: NodeFS.statSync(root).uid,
      hostname: "host-a",
      isAlive: (pid) => pid === 7,
    });

    expect([...removed].sort()).toEqual([deadProfile, otherHost, staleTemp, unlocked].sort());
    expect(NodeFS.readdirSync(home).sort()).toEqual([
      "other.json.1.2.tmp",
      "worker-status.json",
      "worker-status.json.123.789.tmp",
    ]);
    expect(NodeFS.readdirSync(temp).sort()).toEqual([
      "playwright_chromiumdev_profile-live",
      "playwright_chromiumdev_profile-young",
    ]);
  });

  it("leaves another user's leftovers alone", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-leftovers-"));
    roots.push(root);
    const path = NodePath.join(root, "worker-status.json.1.2.tmp");
    NodeFS.writeFileSync(path, "{}");
    aged(path, 5 * HOUR);
    const removed = await sweepServerLeftovers({
      home: root,
      tempDir: root,
      nowMs: NOW,
      uid: NodeFS.statSync(root).uid + 1,
      hostname: "host-a",
      isAlive: () => false,
    });
    expect(removed).toEqual([]);
  });
});
