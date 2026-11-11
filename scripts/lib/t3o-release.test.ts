// @effect-diagnostics globalDate:off - fixed timestamps for the plain-Node stamp.
import { describe, expect, it } from "vite-plus/test";

import {
  buildStamp,
  changedPaths,
  checkExitCode,
  childPath,
  compareT3oTags,
  decideUpdate,
  displayVersion,
  insideUnit,
  latestT3oTag,
  nextT3oTag,
  parseStatPpid,
  parseT3oTag,
  parseUnitFile,
  porcelainIsDirty,
  probeHost,
  relationOf,
  selectUpstreamBase,
  type Relation,
} from "./t3o-release.ts";

describe("T3o tags", () => {
  it("parses only the four-part t3o scheme", () => {
    expect(parseT3oTag("t3o0.1.8.2")).toEqual({ base: [0, 1, 8], n: 2 });
    for (const tag of ["t3o0.1.8", "v0.1.8", "t3o-0.1.8.1", "t3o0.1.8.1-rc", "T3O0.1.8.1"]) {
      expect(parseT3oTag(tag)).toBeNull();
    }
  });

  it("compares numerically, not as strings", () => {
    const sorted = ["t3o0.1.10.1", "t3o0.1.9.10", "t3o0.1.9.2", "t3o0.2.0.1"]
      .map((tag) => parseT3oTag(tag)!)
      .sort(compareT3oTags);
    expect(sorted.map((tag) => `${tag.base.join(".")}.${tag.n}`)).toEqual([
      "0.1.9.2",
      "0.1.9.10",
      "0.1.10.1",
      "0.2.0.1",
    ]);
    expect(latestT3oTag(["v9.9.9", "t3o0.1.9.10", "t3o0.1.9.2", "junk"])).toBe("t3o0.1.9.10");
    expect(latestT3oTag(["v0.1.8"])).toBeNull();
  });

  it("takes the newest stable upstream tag as the base, skipping nightlies and previews", () => {
    expect(
      selectUpstreamBase([
        "v0.1.6",
        "v0.1.8",
        "v0.1.10",
        "v0.1.11-nightly.20261110.4452",
        "v0.2.0-preview.1",
        "t3o0.3.0.1",
      ]),
    ).toEqual([0, 1, 10]);
    expect(selectUpstreamBase(["v0.1.9-nightly.1"])).toBeNull();
  });

  it("bumps the counter on the same base and resets on a new one", () => {
    const tags = ["t3o0.1.8.1", "t3o0.1.8.3", "t3o0.1.7.9", "v0.1.8"];
    expect(nextT3oTag([0, 1, 8], tags)).toBe("t3o0.1.8.4");
    expect(nextT3oTag([0, 1, 9], tags)).toBe("t3o0.1.9.1");
    expect(nextT3oTag([0, 1, 8], [])).toBe("t3o0.1.8.1");
  });
});

describe("build stamp", () => {
  const commit = "abc1234def5678900000000000000000000000ff";

  it.each([
    ["t3o0.1.8.1-0-gabc1234", "0.1.8.1"],
    ["t3o0.1.8.1-3-gabc1234", "0.1.8.1+3.gabc1234"],
    [null, "dev (abc1234)"],
    ["v0.1.8-2-gabc1234", "dev (abc1234)"],
  ])("shows %s as %s", (describe, expected) => {
    expect(displayVersion(describe, commit)).toBe(expected);
  });

  it("ignores pnpm-lock.yaml churn when judging the tree dirty", () => {
    expect(porcelainIsDirty("")).toBe(false);
    expect(porcelainIsDirty(" M pnpm-lock.yaml\n")).toBe(false);
    expect(porcelainIsDirty(" M pnpm-lock.yaml\n M apps/web/src/main.tsx\n")).toBe(true);
    expect(porcelainIsDirty("R  old.ts -> new.ts\n")).toBe(true);
    // Callers trim git's stdout, which eats the first line's leading status column.
    expect(porcelainIsDirty("M pnpm-lock.yaml\n M package.json")).toBe(true);
    expect(porcelainIsDirty("M pnpm-lock.yaml")).toBe(false);
    expect(changedPaths("M pnpm-lock.yaml\n M package.json\nR  a.ts -> b.ts")).toEqual([
      "pnpm-lock.yaml",
      "package.json",
      "b.ts",
    ]);
  });

  it("records the tag and base from describe", () => {
    const now = new Date("2026-11-11T00:00:00.000Z");
    expect(buildStamp({ describe: "t3o0.1.8.2-1-gabc1234", commit, porcelain: "", now })).toEqual({
      tag: "t3o0.1.8.2",
      version: "0.1.8.2+1.gabc1234",
      base: "0.1.8",
      commit,
      describe: "t3o0.1.8.2-1-gabc1234",
      dirty: false,
      builtAt: "2026-11-11T00:00:00.000Z",
    });
    expect(buildStamp({ describe: null, commit, porcelain: " M a.ts", now })).toMatchObject({
      tag: null,
      base: null,
      dirty: true,
    });
  });
});

describe("update decision", () => {
  // R and L stand for the running and release commits; the graph is R → L, plus an unrelated X.
  const edges = new Set(["R>L"]);
  const isAncestor = (ancestor: string, descendant: string) =>
    edges.has(`${ancestor}>${descendant}`);

  it.each<[string, string, boolean, Relation]>([
    ["L", "L", false, "equal"],
    ["R", "L", false, "behind"],
    ["L", "R", false, "ahead"],
    ["X", "L", false, "diverged"],
    ["R", "L", true, "diverged"],
    ["L", "L", true, "diverged"],
  ])("running %s against %s (dirty %s) is %s", (running, target, runningDirty, expected) => {
    expect(relationOf({ running, target, runningDirty, isAncestor })).toBe(expected);
  });

  it.each([
    ["behind", false, false, { kind: "update", downgrade: false }],
    ["behind", true, false, { kind: "update", downgrade: false }],
    ["equal", false, false, { kind: "none", reason: "up-to-date" }],
    ["equal", true, false, { kind: "none", reason: "up-to-date" }],
    ["equal", false, true, { kind: "update", downgrade: false }],
    ["ahead", false, false, { kind: "none", reason: "ahead" }],
    ["diverged", false, false, { kind: "none", reason: "diverged" }],
    ["ahead", true, false, { kind: "needs-force", relation: "ahead" }],
    ["diverged", true, false, { kind: "needs-force", relation: "diverged" }],
    ["ahead", true, true, { kind: "update", downgrade: true }],
    ["diverged", false, true, { kind: "update", downgrade: true }],
  ] as const)("%s with --to=%s --force=%s", (relation, explicitTarget, force, expected) => {
    expect(decideUpdate({ relation, explicitTarget, force })).toEqual(expected);
  });

  it("exits 10 from --check only when behind", () => {
    expect(
      (["equal", "behind", "ahead", "diverged"] as const).map((relation) =>
        checkExitCode(relation),
      ),
    ).toEqual([0, 10, 0, 0]);
  });
});

describe("unit file", () => {
  const unit = [
    "[Service]",
    "Type=simple",
    'Environment="PATH=/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin"',
    'Environment="T3CODE_HOME=/home/me/.t3"',
    'Environment="NODE_OPTIONS=--enable-source-maps"',
    "ExecStart=/home/me/.nvm/versions/node/v24.1.0/bin/node /home/me/.t3/app/dist/bin.mjs serve --host 0.0.0.0 --port 3780",
    "Restart=on-failure",
  ].join("\n");

  it("reads back what install-t3o-service writes", () => {
    expect(parseUnitFile(unit)).toEqual({
      home: "/home/me/.t3",
      path: "/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin",
      node: "/home/me/.nvm/versions/node/v24.1.0/bin/node",
      appDir: "/home/me/.t3/app",
      host: "0.0.0.0",
      port: "3780",
    });
  });

  it("refuses a unit it did not write", () => {
    expect(() => parseUnitFile(unit.replace("serve --host", "start --host"))).toThrow(/ExecStart/);
    expect(() => parseUnitFile(unit.replace(/^Environment="T3CODE_HOME.*$/m, ""))).toThrow(
      /T3CODE_HOME/,
    );
  });

  it("puts the unit's Node first on the child PATH even when the unit PATH lacks it", () => {
    const settings = parseUnitFile(unit);
    expect(childPath(settings.node, settings.path, "/usr/bin:/snap/bin")).toBe(
      "/home/me/.nvm/versions/node/v24.1.0/bin:/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/bin:/snap/bin",
    );
    expect(childPath("/opt/node/bin/node", "/usr/bin", undefined)).toBe("/opt/node/bin:/usr/bin");
  });
});

describe("service probes", () => {
  it.each([
    ["0.0.0.0", "127.0.0.1"],
    ["::", "[::1]"],
    ["127.0.0.1", "127.0.0.1"],
    ["fd7a::1", "[fd7a::1]"],
    ["[fd7a::1]", "[fd7a::1]"],
    ["box.tailnet.ts.net", "box.tailnet.ts.net"],
  ])("probes %s at %s", (host, expected) => {
    expect(probeHost(host)).toBe(expected);
  });

  it("reads the ppid even when the command name holds spaces and parens", () => {
    expect(parseStatPpid("4242 (node) S 4100 4242 4100 0 -1")).toBe(4100);
    expect(parseStatPpid("4242 (my (odd) proc) S 77 4242")).toBe(77);
    expect(parseStatPpid("")).toBeNull();
  });

  it("knows when it runs inside the unit it would stop", () => {
    const base = { unit: "t3o", mainPid: 900, ancestors: [800, 1] };
    expect(insideUnit({ ...base, cgroup: "0::/system.slice/t3o.service\n" })).toBe(true);
    expect(insideUnit({ ...base, cgroup: "0::/system.slice/t3o-scratch.service\n" })).toBe(false);
    expect(
      insideUnit({
        ...base,
        cgroup: "0::/user.slice/app-t3code-agents-1.scope\n",
        ancestors: [850, 900, 1],
      }),
    ).toBe(true);
    expect(insideUnit({ ...base, cgroup: "0::/user.slice/session-3.scope\n" })).toBe(false);
    expect(insideUnit({ ...base, mainPid: 0, cgroup: "", ancestors: [0] })).toBe(false);
  });
});
