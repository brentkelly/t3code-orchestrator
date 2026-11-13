// @effect-diagnostics nodeBuiltinImport:off - checks the folder the exit trap writes into.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { BoardCgroupReader } from "./cgroupReader.ts";

it("a scope's exit trap writes into a private folder no other user can name or enter", () => {
  const script = BoardCgroupReader.defaultValue().finalSnapshot.script("1");
  const dir = script?.match(/d="([^"]+)"/)?.[1];
  assert.isString(dir);
  const base = NodePath.dirname(dir!);
  assert.notStrictEqual(NodePath.basename(base), `t3o-actuals-${process.pid}`);
  assert.strictEqual(NodeFS.statSync(base).mode & 0o777, 0o700);
});
