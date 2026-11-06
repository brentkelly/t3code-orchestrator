// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3O-49: `t3o.json` is read from the project's default branch, whatever the
 * checkout has open, and an export never overwrites uncommitted edits.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { ThreadGateway, type ThreadGatewayShape } from "../ThreadGateway.ts";
import { BoardProjectFile, BoardProjectFileLive } from "./BoardProjectFile.ts";

const projectId = ProjectId.make("project-1");

const repoOnFeatureBranch = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-project-file-"));
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", [...args], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(root, "t3o.json"), '{"version":2}\n');
  git("add", "t3o.json");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "main");
  git("checkout", "-qb", "feature");
  NodeFS.writeFileSync(NodePath.join(root, "t3o.json"), '{"version":2,"ci":{"steps":[]}}\n');
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "feature");
  return root;
};

const layerFor = (root: string) =>
  BoardProjectFileLive.pipe(
    Layer.provideMerge(
      Layer.succeed(ThreadGateway, {
        project: () => Effect.succeed({ workspaceRoot: root }),
      } as unknown as ThreadGatewayShape),
    ),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3o-project-file-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.live("reads the default branch's file, not the checkout's feature branch", () => {
  const root = repoOnFeatureBranch();
  return Effect.gen(function* () {
    const read = yield* (yield* BoardProjectFile).readCommitted(projectId);
    assert.strictEqual(read.kind, "found");
    assert.deepStrictEqual(read.kind === "found" ? read.raw : null, { version: 2 });
  }).pipe(Effect.provide(layerFor(root)));
});

it.live("without a remote HEAD, asks the remote for its default branch before main", () => {
  const upstream = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-project-file-up-"));
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-project-file-"));
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", [...args], { cwd, stdio: "ignore" });
  const commit = (cwd: string, message: string) =>
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
  git(upstream, "init", "-q", "-b", "trunk");
  NodeFS.writeFileSync(NodePath.join(upstream, "t3o.json"), '{"version":2}\n');
  git(upstream, "add", "t3o.json");
  commit(upstream, "trunk");
  git(upstream, "checkout", "-qb", "main");
  NodeFS.writeFileSync(NodePath.join(upstream, "t3o.json"), '{"version":2,"ci":{"steps":[]}}\n');
  git(upstream, "add", "t3o.json");
  commit(upstream, "stale main");
  git(upstream, "checkout", "-q", "trunk");
  // `init` + `remote add` leaves no origin/HEAD; git before 2.48 never creates one on fetch.
  git(root, "init", "-q", "-b", "work");
  git(root, "remote", "add", "origin", upstream);
  git(root, "config", "remote.origin.followRemoteHEAD", "never");
  return Effect.gen(function* () {
    const read = yield* (yield* BoardProjectFile).readCommitted(projectId);
    assert.strictEqual(read.kind, "found");
    assert.deepStrictEqual(read.kind === "found" ? read.raw : null, { version: 2 });
  }).pipe(Effect.provide(layerFor(root)));
});

it.live("refuses to overwrite a t3o.json with uncommitted edits", () => {
  const root = repoOnFeatureBranch();
  NodeFS.writeFileSync(NodePath.join(root, "t3o.json"), "{}\n");
  return Effect.gen(function* () {
    const written = yield* (yield* BoardProjectFile).write(projectId, '{"version":2}\n');
    assert.strictEqual(written.kind, "unavailable");
    assert.strictEqual(NodeFS.readFileSync(NodePath.join(root, "t3o.json"), "utf8"), "{}\n");
  }).pipe(Effect.provide(layerFor(root)));
});
