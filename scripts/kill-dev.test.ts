import { assert, describe, it } from "@effect/vitest";

import {
  ownAncestry,
  parsePids,
  parseProcessTable,
  parseWindowsListenerPids,
  resolveKillPorts,
  selectKillTargets,
} from "./kill-dev.ts";

// The real shape of `npm run dev`: one process group (7100) holding the whole
// stack, hanging off an interactive shell that must survive the kill.
const DEV_RUN_TABLE = parseProcessTable(
  [
    "  7000    1  7000 bash --rcfile /dev/fd/63",
    "  7100 7000  7100 npm run dev",
    "  7101 7100  7100 sh -c node scripts/dev-runner.ts dev",
    "  7102 7101  7100 node scripts/dev-runner.ts dev",
    "  7103 7102  7100 node /repo/node_modules/vite-plus/bin/vp run --filter=t3 dev",
    "  7104 7103  7100 node --watch src/bin.ts",
    "  7105 7104  7100 node src/bin.ts",
    "  9000 7000  9000 node scripts/kill-dev.ts",
  ].join("\n"),
);

describe("parseProcessTable", () => {
  it("keeps the command line intact, spaces and all", () => {
    assert.deepStrictEqual(DEV_RUN_TABLE[1], {
      pid: 7100,
      ppid: 7000,
      pgid: 7100,
      command: "npm run dev",
    });
    assert.equal(DEV_RUN_TABLE.length, 8);
  });

  it("ignores header or garbage lines", () => {
    assert.deepStrictEqual(parseProcessTable("PID PPID PGID COMMAND\n\n  not a row\n"), []);
  });
});

describe("parsePids", () => {
  it("reads one pid per line and drops init and blanks", () => {
    assert.deepStrictEqual(parsePids("4242\n\n 88 \n1\nnope\n"), [4242, 88]);
  });

  it("de-duplicates pids listening on several addresses", () => {
    assert.deepStrictEqual(parsePids("4242\n4242\n"), [4242]);
  });
});

describe("parseWindowsListenerPids", () => {
  const netstat = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:13773          0.0.0.0:0              LISTENING       4242",
    "  TCP    127.0.0.1:5733         0.0.0.0:0              LISTENING       4243",
    "  TCP    127.0.0.1:13773        127.0.0.1:51000        ESTABLISHED     4300",
  ].join("\r\n");

  it("takes only the listener on the requested port", () => {
    assert.deepStrictEqual(parseWindowsListenerPids(netstat, 13_773), [4242]);
  });

  it("does not match a port that is only a suffix of another", () => {
    assert.deepStrictEqual(parseWindowsListenerPids(netstat, 773), []);
  });
});

describe("resolveKillPorts", () => {
  it("defaults to this checkout's server and web ports", () => {
    assert.deepStrictEqual(
      resolveKillPorts({ explicitPorts: [], serverPortOverride: undefined, offset: 0 }),
      [5733, 13_773],
    );
  });

  it("shifts both ports by the worktree offset", () => {
    assert.deepStrictEqual(
      resolveKillPorts({ explicitPorts: [], serverPortOverride: undefined, offset: 7 }),
      [5740, 13_780],
    );
  });

  it("honours a T3CODE_PORT override for the server port only", () => {
    assert.deepStrictEqual(
      resolveKillPorts({ explicitPorts: [], serverPortOverride: 4222, offset: 0 }),
      [4222, 5733],
    );
  });

  it("uses explicit ports verbatim, de-duplicated", () => {
    assert.deepStrictEqual(
      resolveKillPorts({ explicitPorts: [3773, 3773, 5733], serverPortOverride: 4222, offset: 9 }),
      [3773, 5733],
    );
  });
});

describe("ownAncestry", () => {
  it("walks up to, but not past, init", () => {
    assert.deepStrictEqual([...ownAncestry(DEV_RUN_TABLE, 9000)], [9000, 7000]);
  });
});

describe("selectKillTargets", () => {
  it("kills the whole dev process group, not just the listener", () => {
    assert.deepStrictEqual(
      selectKillTargets({ table: DEV_RUN_TABLE, listenerPids: [7105], selfPid: 9000 }),
      [7100, 7101, 7102, 7103, 7104, 7105],
    );
  });

  it("never kills the shell that owns this script", () => {
    const targets = selectKillTargets({
      table: DEV_RUN_TABLE,
      listenerPids: [7105],
      selfPid: 9000,
    });
    assert.isFalse(targets.includes(7000));
    assert.isFalse(targets.includes(9000));
  });

  it("falls back to the listener subtree when the group is led by a shell", () => {
    // No job control: everything shares the shell's process group, so killing
    // the group would kill the shell.
    const sharedGroup = parseProcessTable(
      [
        "  7000    1  7000 bash",
        "  7100 7000  7000 npm run dev",
        "  7105 7100  7000 node src/bin.ts",
        "  7106 7105  7000 node worker.ts",
        "  9000 7000  7000 node scripts/kill-dev.ts",
      ].join("\n"),
    );

    assert.deepStrictEqual(
      selectKillTargets({ table: sharedGroup, listenerPids: [7105], selfPid: 9000 }),
      [7105, 7106],
    );
  });

  it("still kills an `sh -c` wrapper group, which is npm's, not a session", () => {
    const wrapperGroup = parseProcessTable(
      [
        "  7000    1  7000 bash",
        "  7101 7000  7101 sh -c node scripts/dev-runner.ts dev",
        "  7105 7101  7101 node src/bin.ts",
        "  9000 7000  9000 node scripts/kill-dev.ts",
      ].join("\n"),
    );

    assert.deepStrictEqual(
      selectKillTargets({ table: wrapperGroup, listenerPids: [7105], selfPid: 9000 }),
      [7101, 7105],
    );
  });

  it("kills the listener even when the process table could not be read", () => {
    assert.deepStrictEqual(
      selectKillTargets({ table: [], listenerPids: [4242], selfPid: 9000 }),
      [4242],
    );
  });

  it("leaves a listener that shares this script's own process group alone", () => {
    const selfGroup = parseProcessTable(
      ["  9000    1  9000 node scripts/kill-dev.ts", "  9001 9000  9000 node src/bin.ts"].join(
        "\n",
      ),
    );

    assert.deepStrictEqual(
      selectKillTargets({ table: selfGroup, listenerPids: [9001], selfPid: 9000 }),
      [9001],
    );
  });
});
