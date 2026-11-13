// @effect-diagnostics nodeBuiltinImport:off - builds a folder du can only partly read.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardMachine } from "./machine.ts";

it.live("a worktree with an unreadable subfolder still measures, as du's total", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-du-"));
    const locked = NodePath.join(root, "locked");
    NodeFS.mkdirSync(NodePath.join(locked, "inner"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "file"), "x".repeat(64 * 1024));
    NodeFS.chmodSync(locked, 0o000);
    try {
      const bytes = yield* BoardMachine.defaultValue().diskUsageBytes(root);
      assert.isNotNull(bytes);
      assert.isAtLeast(bytes!, 64 * 1024);
    } finally {
      NodeFS.chmodSync(locked, 0o700);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);
