// @effect-diagnostics nodeBuiltinImport:off - checks the folder the exit trap writes into.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { vi } from "vitest";

import { BoardCgroupReader } from "./cgroupReader.ts";

it("a scope's exit trap writes into a private folder no other user can name or enter", () => {
  const script = BoardCgroupReader.defaultValue().finalSnapshot.script("1");
  const dir = script?.match(/d="([^"]+)"/)?.[1];
  assert.isString(dir);
  const base = NodePath.dirname(dir!);
  assert.notStrictEqual(NodePath.basename(base), `t3o-actuals-${process.pid}`);
  assert.strictEqual(NodeFS.statSync(base).mode & 0o777, 0o700);
});

it("the first scope sweeps folders a dead server left, and keeps a live one's", async () => {
  const stale = NodePath.join(NodeOS.tmpdir(), "t3o-actuals-999999999-crashed");
  const live = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3o-actuals-${process.pid}-`));
  NodeFS.mkdirSync(NodePath.join(stale, "run"), { recursive: true });
  vi.resetModules();
  const fresh = await import("./cgroupReader.ts");
  assert.isString(fresh.BoardCgroupReader.defaultValue().finalSnapshot.script("1"));
  assert.isFalse(NodeFS.existsSync(stale));
  assert.isTrue(NodeFS.existsSync(live));
  NodeFS.rmSync(live, { recursive: true, force: true });
});
