/** A worktree's owner is read from its `.git` pointer file, not a git subprocess (T3O-108 S10). */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { boardWorktreeOwner, CENTRAL_OWNER_MARKER } from "./LocalBoardWorkspace.ts";

/** A linked worktree: a `.git` file pointing at a private git dir elsewhere. */
const linkedWorktree = (marker: string | null) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-owner-"));
  const gitDir = NodePath.join(root, "repo.git", "worktrees", "card-1");
  const worktree = NodePath.join(root, "card-1");
  NodeFS.mkdirSync(gitDir, { recursive: true });
  NodeFS.mkdirSync(worktree, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  if (marker !== null) NodeFS.writeFileSync(NodePath.join(gitDir, CENTRAL_OWNER_MARKER), marker);
  return { root, worktree, gitDir };
};

const depsWith = (gitCalls: Array<string>, gitDir: string | null) =>
  Effect.gen(function* () {
    return {
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      git: {
        execute: (request: { readonly cwd: string }) =>
          Effect.sync(() => {
            gitCalls.push(request.cwd);
            return { exitCode: 0, stdout: gitDir === null ? "" : `${gitDir}\n`, stderr: "" };
          }),
      } as never,
    };
  });

it.effect("reads a linked worktree's owner without running git", () =>
  Effect.gen(function* () {
    const gitCalls: Array<string> = [];
    const own = linkedWorktree(null);
    const central = linkedWorktree("board:env-central\n");
    const deps = yield* depsWith(gitCalls, null);
    assert.strictEqual(yield* boardWorktreeOwner(deps, own.worktree), "self");
    assert.strictEqual(yield* boardWorktreeOwner(deps, central.worktree), "board:env-central");
    assert.deepStrictEqual(gitCalls, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("asks git only for a checkout with no pointer file", () =>
  Effect.gen(function* () {
    const gitCalls: Array<string> = [];
    const { root, gitDir } = linkedWorktree("board:env-central\n");
    const plain = NodePath.join(root, "plain");
    NodeFS.mkdirSync(plain);
    const deps = yield* depsWith(gitCalls, gitDir);
    assert.strictEqual(yield* boardWorktreeOwner(deps, plain), "board:env-central");
    assert.deepStrictEqual(gitCalls, [plain]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "falls back to git when the pointer names a missing directory, so the owner stays unknown",
  () =>
    Effect.gen(function* () {
      const gitCalls: Array<string> = [];
      const { worktree, gitDir } = linkedWorktree(null);
      NodeFS.rmSync(gitDir, { recursive: true });
      const deps = yield* depsWith(gitCalls, null);
      assert.strictEqual(yield* boardWorktreeOwner(deps, worktree), null);
      assert.deepStrictEqual(gitCalls, [worktree]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
