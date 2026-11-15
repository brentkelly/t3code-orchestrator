// @effect-diagnostics nodeBuiltinImport:off - publishes into a real temp app dir with rsync.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { publishDist } from "./t3o-publish-dist.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 10, 15);

function writeFile(root: string, relative: string, ageDays = 0) {
  const path = NodePath.join(root, relative);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, relative);
  const mtime = (NOW_MS - ageDays * DAY_MS) / 1000;
  NodeFS.utimesSync(path, mtime, mtime);
}

const exists = (root: string, relative: string) => NodeFS.existsSync(NodePath.join(root, relative));

describe("publishDist", () => {
  it("keeps the previous build's web chunks so open tabs can still lazy-load them", () => {
    const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-publish-"));
    const build = NodePath.join(base, "build");
    const app = NodePath.join(base, "app");
    writeFile(build, "bin.mjs");
    writeFile(build, "client/index.html");
    writeFile(build, "client/assets/index-NEW.js");
    writeFile(app, "bin.mjs", 1);
    writeFile(app, "server-OLD.mjs", 1);
    writeFile(app, "client/assets/index-OLD.js", 1);
    writeFile(app, "client/assets/BoardCardPlanPane-OLD.js", 1);
    writeFile(app, "client/assets/ancient-OLD.js", 30);

    publishDist(build, app, NOW_MS);

    expect(exists(app, "client/assets/index-NEW.js")).toBe(true);
    expect(exists(app, "client/assets/index-OLD.js")).toBe(true);
    expect(exists(app, "client/assets/BoardCardPlanPane-OLD.js")).toBe(true);
    expect(exists(app, "client/assets/ancient-OLD.js")).toBe(false);
    expect(exists(app, "server-OLD.mjs")).toBe(false);
  });
});
