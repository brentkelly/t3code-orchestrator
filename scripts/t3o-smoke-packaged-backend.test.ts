import * as NodeEvents from "node:events";

import { describe, expect, it } from "vite-plus/test";

import { cleanupPackagedBackendSmoke, removeSmokeHome } from "./t3o-smoke-packaged-backend.ts";

class FakeChild extends NodeEvents.EventEmitter {
  killed = false;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null = null;

  constructor(alreadyExited = false) {
    super();
    this.exitCode = alreadyExited ? 0 : null;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("cleanupPackagedBackendSmoke", () => {
  it("waits for the child to exit before deleting the home", async () => {
    const child = new FakeChild();
    const removed: string[] = [];
    const done = cleanupPackagedBackendSmoke(child, false, "/tmp/t3o-smoke-x", {
      remove: (path) => {
        removed.push(String(path));
      },
    });
    expect(child.killed).toBe(true);
    expect(removed).toEqual([]);
    child.emit("exit");
    await done;
    expect(removed).toEqual(["/tmp/t3o-smoke-x"]);
  });

  it("skips kill when the child has already exited", async () => {
    const child = new FakeChild(true);
    const removed: string[] = [];
    await cleanupPackagedBackendSmoke(child, true, "/tmp/t3o-smoke-x", {
      remove: (path) => {
        removed.push(String(path));
      },
    });
    expect(child.killed).toBe(false);
    expect(removed).toEqual(["/tmp/t3o-smoke-x"]);
  });

  it("deletes the home after the stop timeout", async () => {
    const child = new FakeChild();
    const removed: string[] = [];
    await cleanupPackagedBackendSmoke(child, false, "/tmp/t3o-smoke-x", {
      timeoutMs: 20,
      remove: (path) => {
        removed.push(String(path));
      },
    });
    expect(child.killed).toBe(true);
    expect(removed).toEqual(["/tmp/t3o-smoke-x"]);
  });
});

describe("removeSmokeHome", () => {
  it("does not throw when deleting the home fails", () => {
    expect(() =>
      removeSmokeHome("/tmp/t3o-smoke-busy", () => {
        throw new Error("EBUSY: resource busy or locked");
      }),
    ).not.toThrow();
  });
});
