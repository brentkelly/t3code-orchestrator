// @effect-diagnostics nodeBuiltinImport:off - the checks look at real files and executables.
/**
 * Declarative readiness checks (T3O-124): what each kind resolves and runs, and what it refuses.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { BoardReadinessCheck } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  gitProbeArgs,
  requiredMajor,
  runReadinessChecks,
  rustChannel,
  type ReadinessCheckHost,
  type ReadinessRun,
} from "./readinessChecks.ts";

const withFixture = <A, E>(
  body: (fixture: {
    readonly root: string;
    readonly bin: (dir: string, name: string) => string;
    readonly calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
    readonly host: (
      overrides?: Partial<ReadinessCheckHost> & {
        readonly answer?: (command: string, args: ReadonlyArray<string>) => ReadinessRun;
      },
    ) => ReadinessCheckHost;
  }) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ready-checks-test-"))),
    (root) => {
      const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
      return body({
        root,
        calls,
        bin: (dir, name) => {
          const folder = NodePath.join(root, dir);
          NodeFS.mkdirSync(folder, { recursive: true });
          const path = NodePath.join(folder, name);
          NodeFS.writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
          return path;
        },
        host: (overrides = {}) => ({
          run: (call) =>
            Effect.sync(() => {
              calls.push({ command: call.command, args: call.args });
              return (
                overrides.answer?.(call.command, call.args) ?? {
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                  timedOut: false,
                }
              );
            }),
          env: overrides.env ?? {
            PATH: "",
            HOME: NodePath.join(root, "home"),
            TMPDIR: NodePath.join(root, "tmp"),
          },
          forbiddenRoots: overrides.forbiddenRoots ?? Effect.succeed([]),
        }),
      });
    },
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

const repoOf = (files: Record<string, string> = {}) => ({
  checkout: "/checkout",
  file: (path: string) => Effect.succeed(files[path] ?? null),
  has: (path: string) => Effect.succeed(path in files),
});

const run = (
  host: ReadinessCheckHost,
  checks: ReadonlyArray<BoardReadinessCheck>,
  files?: Record<string, string>,
) => runReadinessChecks({ checks, host, repo: repoOf(files), cwd: "/empty" });

const version = (stdout: string): ReadinessRun => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

it.effect("a command is found in its paths, and an existence-only check runs nothing", () =>
  withFixture(({ root, bin, calls, host }) =>
    Effect.gen(function* () {
      const tool = bin("mise/installs/node/22.1.0/bin", "node");
      const [found] = yield* run(host(), [
        { command: "node", paths: [`${root}/mise/installs/node/*/bin`] },
      ]);
      assert.deepInclude(found, { status: "pass", detail: tool });
      const [missing] = yield* run(host(), [{ command: "node", fix: "install node" }]);
      assert.deepInclude(missing, { status: "fail", fix: "install node" });
      assert.lengthOf(calls, 0);
    }),
  ),
);

it.effect("a binary inside a checkout or $TMPDIR is refused before it runs", () =>
  withFixture(({ root, bin, calls, host }) =>
    Effect.gen(function* () {
      bin("checkout/node_modules/.bin", "pnpm");
      const [refused] = yield* run(
        host({ forbiddenRoots: Effect.succeed([NodePath.join(root, "checkout")]) }),
        [
          {
            command: "pnpm",
            paths: [`${root}/checkout/node_modules/.bin`],
            version: { atLeast: "10" },
          },
        ],
      );
      assert.strictEqual(refused!.status, "fail");
      assert.include(refused!.detail, "refused");
      assert.lengthOf(calls, 0);
    }),
  ),
);

it.effect("a version below atLeast, or below the from file's lowest major, fails", () =>
  withFixture(({ root, bin, calls, host }) =>
    Effect.gen(function* () {
      bin("bin", "node");
      bin("bin", "pnpm");
      const answers = host({
        env: { PATH: `${root}/bin`, HOME: root, TMPDIR: `${root}/tmp` },
        answer: (command) => version(command.endsWith("pnpm") ? "9.15.0\n" : "v18.20.1\n"),
      });
      const results = yield* run(
        answers,
        [
          { command: "pnpm", version: { atLeast: "10" } },
          { command: "node", version: { from: "package.json" } },
          { command: "node", version: { from: ".node-version" } },
        ],
        { "package.json": '{"engines":{"node":">=20 <23"}}', ".node-version": "v16.4.0\n" },
      );
      assert.deepStrictEqual(
        results.map((result) => result.status),
        ["fail", "fail", "pass"],
      );
      assert.include(results[1]!.detail, "needs 20");
      // Each version probe is `<resolved> --version`, no shell.
      assert.deepStrictEqual(
        calls.map((call) => [NodePath.basename(call.command), ...call.args]),
        [
          ["pnpm", "--version"],
          ["node", "--version"],
          ["node", "--version"],
        ],
      );
    }),
  ),
);

it.effect("file, exists and writable read the machine; repo paths read the default branch", () =>
  withFixture(({ root, host }) =>
    Effect.gen(function* () {
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(NodePath.join(home, ".cargo"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(home, ".cargo/config.toml"),
        "rustc-wrapper = 'rustc-slot'",
      );
      NodeFS.mkdirSync(NodePath.join(home, ".cache/ms-playwright/chromium-1200"), {
        recursive: true,
      });
      NodeFS.mkdirSync(NodePath.join(root, "tmp"));
      const results = yield* run(
        host(),
        [
          { file: "~/.cargo/config.toml", contains: "rustc-slot" },
          { file: "~/.cargo/config.toml", contains: "sccache" },
          { exists: "~/.cache/ms-playwright/chromium-*" },
          { exists: "$HOME/.cache/ms-playwright/firefox-*", warn: true },
          { exists: "scripts/ci.ts" },
          { writable: "$TMPDIR" },
          { writable: "~/missing" },
        ],
        { "scripts/ci.ts": "" },
      );
      assert.deepStrictEqual(
        results.map((result) => result.status),
        ["pass", "fail", "pass", "warn", "pass", "pass", "fail"],
      );
      // The writable probe leaves nothing behind.
      assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(root, "tmp")), []);
    }),
  ),
);

it.effect("git probes never run a hook or prompt, and docker checks each plugin", () =>
  withFixture(({ root, bin, calls, host }) =>
    Effect.gen(function* () {
      bin("bin", "git");
      bin("bin", "docker");
      const results = yield* run(
        host({
          env: { PATH: `${root}/bin`, HOME: root, TMPDIR: `${root}/tmp` },
          answer: (_command, args) =>
            args[0] === "buildx" ? { ...version(""), exitCode: 1 } : version("x\n"),
        }),
        [{ git: "push" }, { docker: { plugins: ["compose", "buildx"] } }],
      );
      const push = calls[0]!.args;
      assert.isBelow(push.indexOf("core.hooksPath=/dev/null"), push.indexOf("push"));
      assert.strictEqual(push[push.indexOf("core.hooksPath=/dev/null") - 1], "-c");
      assert.include(push, "--no-verify");
      assert.include(push, "--dry-run");
      assert.deepStrictEqual(push, [...gitProbeArgs("push", "/checkout")]);
      assert.strictEqual(results[0]!.status, "pass");
      assert.deepInclude(results[1], { status: "fail", detail: "missing docker buildx" });
    }),
  ),
);

it.effect("a rust toolchain is read from the repo file and looked up in rustup's list", () =>
  withFixture(({ root, bin, host }) =>
    Effect.gen(function* () {
      bin("bin", "rustup");
      const answers = host({
        env: { PATH: `${root}/bin`, HOME: root, TMPDIR: `${root}/tmp` },
        answer: () =>
          version("stable-x86_64-unknown-linux-gnu (default)\n1.82.0-x86_64-unknown-linux-gnu\n"),
      });
      const [have] = yield* run(answers, [{ rustToolchain: "rust-toolchain.toml" }], {
        "rust-toolchain.toml": '[toolchain]\nchannel = "1.82.0"\n',
      });
      const [missing] = yield* run(answers, [{ rustToolchain: "rust-toolchain.toml" }], {
        "rust-toolchain.toml": '[toolchain]\nchannel = "nightly-2025-01-01"\n',
      });
      assert.strictEqual(have!.status, "pass");
      assert.strictEqual(missing!.status, "fail");
    }),
  ),
);

it("reads the lowest major of a range, and a toolchain channel", () => {
  assert.strictEqual(requiredMajor("package.json", '{"engines":{"node":"26.12.1"}}', "node"), 26);
  assert.strictEqual(
    requiredMajor("package.json", '{"engines":{"node":"^22.1 || ^24"}}', "node"),
    22,
  );
  assert.isNull(requiredMajor("package.json", '{"engines":{}}', "node"));
  assert.strictEqual(requiredMajor(".nvmrc", "v20.11.0\n", "node"), 20);
  assert.strictEqual(rustChannel("stable\n"), "stable");
  assert.isNull(rustChannel("[toolchain]\ncomponents = []\n"));
});
