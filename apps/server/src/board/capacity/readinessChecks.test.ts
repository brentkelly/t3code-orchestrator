// @effect-diagnostics nodeBuiltinImport:off - the checks look at real files and executables.
/**
 * Declarative readiness checks (T3O-124): what each kind resolves and runs, and what it refuses.
 * One row per rule of the brief's threat model.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { BoardReadinessCheck } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  READINESS_GIT_GUARD,
  confineMachinePath,
  expandReadinessGlob,
  githubRepository,
  readMachineFile,
  readinessEnv,
  requiredMajor,
  runReadinessChecks,
  rustChannel,
  type ReadinessCheckHost,
  type ReadinessRun,
} from "./readinessChecks.ts";
import { spawnReadinessProbe, type ReadinessSpawnInput } from "./readinessSpawn.ts";

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const uid = NodeOS.userInfo().uid;

const ok = (stdout: string): ReadinessRun => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

const withFixture = <A, E>(
  body: (fixture: {
    readonly root: string;
    readonly home: string;
    /** An executable: native (ELF magic) unless `script`, mode 755 unless given. */
    readonly bin: (
      dir: string,
      name: string,
      options?: { readonly script?: boolean; readonly mode?: number },
    ) => string;
    readonly calls: Array<ReadinessSpawnInput>;
    readonly host: (
      overrides?: Partial<ReadinessCheckHost> & {
        readonly answer?: (call: ReadinessSpawnInput) => ReadinessRun;
      },
    ) => ReadinessCheckHost;
  }) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ready-checks-test-"))),
    (root) => {
      const calls: Array<ReadinessSpawnInput> = [];
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(home);
      NodeFS.mkdirSync(NodePath.join(root, "tmp"));
      return body({
        root,
        home,
        calls,
        bin: (dir, name, options = {}) => {
          const folder = NodePath.join(root, dir);
          NodeFS.mkdirSync(folder, { recursive: true });
          const path = NodePath.join(folder, name);
          NodeFS.writeFileSync(path, options.script === true ? "#!/bin/sh\necho 99\n" : ELF);
          NodeFS.chmodSync(path, options.mode ?? 0o755);
          return path;
        },
        host: (overrides = {}) => ({
          run: (call) =>
            Effect.sync(() => {
              calls.push(call);
              return overrides.answer?.(call) ?? ok("");
            }),
          env: overrides.env ?? { PATH: `${root}/bin` },
          home: overrides.home ?? home,
          tmpdir: overrides.tmpdir ?? NodePath.join(root, "tmp"),
          platform: overrides.platform ?? "linux",
          arch: overrides.arch ?? "x64",
          uid: overrides.uid === undefined ? uid : overrides.uid,
          homebrewPrefixes: overrides.homebrewPrefixes ?? [],
          forbiddenRoots: overrides.forbiddenRoots ?? Effect.succeed([]),
        }),
      });
    },
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

const run = (
  host: ReadinessCheckHost,
  checks: ReadonlyArray<BoardReadinessCheck>,
  options: {
    readonly files?: Record<string, string>;
    readonly remote?: string | null;
    readonly budgetMs?: number;
  } = {},
) =>
  runReadinessChecks({
    checks,
    host,
    budgetMs: options.budgetMs ?? 600_000,
    repo: {
      checkout: "/checkout",
      remote: Effect.succeed(options.remote === undefined ? "upstream" : options.remote),
      file: (path) => Effect.succeed(options.files?.[path] ?? null),
    },
  });

const statuses = (results: ReadonlyArray<{ readonly status: string }>) =>
  results.map((result) => result.status);

it.effect("an existence-only command runs nothing; vetting refuses untrusted binaries", () =>
  withFixture(({ root, home, bin, calls, host }) =>
    Effect.gen(function* () {
      const found = bin("bin", "cmake");
      bin("bin", "groupw", { mode: 0o775 });
      bin("checkout/node_modules/.bin", "tsc");
      bin("home/.npm/_npx/x/bin", "cowsay");
      bin("tmp/bin", "fromtmp");
      bin("vendor/node_modules/.bin", "inmodules");
      const results = yield* run(
        host({
          env: {
            PATH: [
              `${root}/bin`,
              `${root}/checkout/node_modules/.bin`,
              `${home}/.npm/_npx/x/bin`,
              `${root}/tmp/bin`,
              `${root}/vendor/node_modules/.bin`,
              "relative/bin",
            ].join(":"),
          },
          forbiddenRoots: Effect.succeed([NodePath.join(root, "checkout")]),
        }),
        [
          { command: "cmake", fix: "sudo apt install cmake" },
          { command: "nothere", fix: "install it" },
          { command: "groupw" },
          { command: "tsc" },
          { command: "cowsay" },
          { command: "fromtmp" },
          { command: "inmodules" },
        ],
      );
      assert.deepStrictEqual(statuses(results), [
        "pass",
        "fail",
        "fail",
        "fail",
        "fail",
        "fail",
        "fail",
      ]);
      assert.strictEqual(results[0]!.detail, found);
      assert.isUndefined(results[0]!.fix);
      assert.strictEqual(results[1]!.fix, "install it");
      assert.include(results[2]!.detail, "writable by others");
      for (const refused of results.slice(3)) assert.include(refused.detail, "refused");
      // A binary owned by someone else is refused too.
      const [wrongOwner] = yield* run(host({ uid: uid + 1 }), [{ command: "cmake" }]);
      assert.include(wrongOwner!.detail, "owned by another user");
      assert.lengthOf(calls, 0);
    }),
  ),
);

it.effect(
  "a version runs the vetted native binary with fixed argv and argv0; any candidate matches",
  () =>
    withFixture(({ root, bin, calls, host }) =>
      Effect.gen(function* () {
        const old = bin("old", "node");
        const current = bin("bin", "node");
        const results = yield* run(
          host({
            env: { PATH: `${root}/old:${root}/bin`, NODE_OPTIONS: "--require /evil.js" },
            answer: (call) => ok(call.path === old ? "v18.20.1\n" : "v24.3.0\n"),
          }),
          [
            { command: "node", version: { atLeast: "22" } },
            { command: "node", version: { from: "package.json" } },
            { command: "node", version: { from: ".nvmrc" } },
          ],
          { files: { "package.json": '{"engines":{"node":">=26"}}', ".nvmrc": "lts/*\n" } },
        );
        assert.deepStrictEqual(statuses(results), ["pass", "fail", "warn"]);
        assert.include(results[0]!.detail, current);
        assert.include(results[1]!.detail, "needs 26");
        assert.include(results[2]!.detail, "alias");
        const first = calls[0]!;
        assert.deepStrictEqual(
          [first.path, first.argv0, ...first.args],
          [old, "node", "--version"],
        );
        assert.notProperty(first.env, "NODE_OPTIONS");
        assert.deepStrictEqual(
          calls.slice(0, 2).map((call) => call.path),
          [old, current],
        );
      }),
    ),
);

it.effect(
  "a script tool's version is a warning, and a non-table command's version runs nothing",
  () =>
    withFixture(({ bin, calls, host }) =>
      Effect.gen(function* () {
        bin("bin", "pnpm", { script: true });
        bin("bin", "mytool");
        const results = yield* run(host(), [
          { command: "pnpm", version: { atLeast: "10" } },
          { command: "mytool", version: { atLeast: "1" } },
        ]);
        assert.deepStrictEqual(statuses(results), ["warn", "warn"]);
        assert.include(results[0]!.detail, "version not checked for script tools");
        assert.include(results[1]!.detail, "doesn't know how to ask mytool");
        assert.lengthOf(calls, 0);
      }),
    ),
);

it.effect("machine reads refuse devices, FIFOs, oversized files and never-roots", () =>
  withFixture(({ root, home, host }) =>
    Effect.gen(function* () {
      const h = host();
      const read = (path: string) => Effect.promise(() => readMachineFile(path, h));
      assert.include(yield* read("/dev/zero"), { error: "/dev/zero is not a regular file" });
      const fifo = NodePath.join(home, "fifo");
      NodeChildProcess.execFileSync("mkfifo", [fifo]);
      assert.include(yield* read(fifo), { error: `${fifo} is not a regular file` });
      const big = NodePath.join(home, "big.toml");
      NodeFS.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 0x61));
      assert.include((yield* read(big)) as { error: string }, {
        error: `${big} is larger than 1048576 bytes`,
      });
      assert.include(yield* read("/proc/self/environ"), { error: "/proc is never read" });
      assert.include(yield* Effect.promise(() => confineMachinePath("/net/x/y", h)), {
        error: "/net is never read",
      });
      // A link out of home into a never-root is refused by its realpath.
      NodeFS.symlinkSync("/proc/self", NodePath.join(home, "self"));
      assert.include(
        ((yield* read(NodePath.join(home, "self/environ"))) as { error: string }).error,
        "/proc",
      );
      // Outside every allowed root.
      assert.include(((yield* read(`${root}/elsewhere`)) as { error: string }).error, "outside");
    }),
  ),
);

it.effect("globs: at most two wildcard folders, none directly under home", () =>
  withFixture(({ home, host }) =>
    Effect.gen(function* () {
      const h = host();
      NodeFS.mkdirSync(NodePath.join(home, ".cache/ms-playwright/chromium-1200"), {
        recursive: true,
      });
      const glob = (pattern: string) => Effect.promise(() => expandReadinessGlob(pattern, h));
      assert.deepStrictEqual(yield* glob(`${home}/.cache/ms-playwright/chromium-*`), {
        matches: [NodePath.join(home, ".cache/ms-playwright/chromium-1200")],
      });
      assert.property(yield* glob(`${home}/*/x`), "error");
      assert.property(yield* glob(`${home}/a/*/*/*`), "error");
      assert.property(yield* glob("/*/bin"), "error");
    }),
  ),
);

it.effect("exists, writable, env and cargoConfig", () =>
  withFixture(({ home, host }) =>
    Effect.gen(function* () {
      NodeFS.mkdirSync(NodePath.join(home, ".cargo"));
      NodeFS.writeFileSync(
        NodePath.join(home, ".cargo/config.toml"),
        "[build]\nrustc-wrapper = 'rustc-slot'\n[registry]\ntoken = 'rustc-slot-secret'\n",
      );
      NodeFS.mkdirSync(NodePath.join(home, ".cache/ms-playwright/chromium-1200"), {
        recursive: true,
      });
      const stale = NodePath.join(home, "refresh.log");
      NodeFS.writeFileSync(stale, "");
      NodeFS.utimesSync(stale, 0, 0);
      // Ten hours after the epoch, where the log's mtime sits.
      yield* TestClock.setTime(10 * 3_600_000);
      const before = NodeFS.readdirSync(NodePath.join(home, ".."), { recursive: true }).length;
      const results = yield* run(host({ env: { PATH: "", ANDROID_HOME: "/opt/android" } }), [
        { cargoConfig: { contains: "rustc-slot" } },
        { cargoConfig: { contains: "secret" } },
        { exists: "$PLAYWRIGHT_BROWSERS_PATH/chromium-*" },
        { exists: "$HOME/.cache/ms-playwright/firefox-*", warn: true },
        { exists: "~/refresh.log", maxAgeHours: 3 },
        { exists: "$JAVA_HOME/bin" },
        { writable: "$TMPDIR" },
        { writable: "~/missing" },
        { writable: "/dev/null" },
        { env: "ANDROID_HOME" },
        { env: "ANDROID_SDK_ROOT" },
      ]);
      assert.deepStrictEqual(statuses(results), [
        "pass",
        "fail",
        "pass",
        "warn",
        "fail",
        "fail",
        "pass",
        "fail",
        "pass",
        "pass",
        "fail",
      ]);
      // A key naming a token is never matched, and an env value is never shown.
      assert.include(results[4]!.detail, "hours old");
      assert.include(results[5]!.detail, "$JAVA_HOME is not set");
      assert.notInclude(results[9]!.detail, "/opt/android");
      // writable creates nothing.
      assert.strictEqual(
        NodeFS.readdirSync(NodePath.join(home, ".."), { recursive: true }).length,
        before,
      );
    }),
  ),
);

it.effect(
  "docker: one `docker info`, daemon and plugins from its JSON, logins from config keys",
  () =>
    withFixture(({ home, bin, calls, host }) =>
      Effect.gen(function* () {
        bin("bin", "docker");
        const up = JSON.stringify({
          ServerVersion: "27.1.0",
          ClientInfo: { Plugins: [{ Name: "compose" }, { Name: "buildx" }] },
        });
        const down = JSON.stringify({ ServerErrors: ["Cannot connect to the Docker daemon"] });
        let answer = up;
        const h = host({ answer: () => ok(answer) });
        NodeFS.mkdirSync(NodePath.join(home, ".docker"));
        NodeFS.writeFileSync(
          NodePath.join(home, ".docker/config.json"),
          JSON.stringify({ auths: { "ghcr.io": { auth: "c2VjcmV0" } } }),
        );
        const passed = yield* run(h, [
          { docker: { plugins: ["compose", "buildx"], loggedIn: ["ghcr.io"] } },
          { docker: { plugins: ["scan"] } },
          { docker: { plugins: [], loggedIn: ["registry.example.com"] } },
        ]);
        assert.deepStrictEqual(statuses(passed), ["pass", "fail", "fail"]);
        assert.notInclude(passed[0]!.detail, "c2VjcmV0");
        assert.deepStrictEqual(calls[0]!.args, ["info", "--format", "{{json .}}"]);
        assert.lengthOf(calls, 3);
        // A credential store with no per-host entry can't be read: a warning.
        NodeFS.writeFileSync(
          NodePath.join(home, ".docker/config.json"),
          JSON.stringify({ credsStore: "desktop" }),
        );
        const [store] = yield* run(h, [{ docker: { plugins: [], loggedIn: ["ghcr.io"] } }]);
        assert.strictEqual(store!.status, "warn");
        // `docker info` exits 0 with the daemon down; its JSON says so.
        answer = down;
        const [daemon] = yield* run(h, [{ docker: { plugins: [] } }]);
        assert.deepInclude(daemon, { status: "fail" });
        assert.include(daemon!.detail, "isn't answering");
      }),
    ),
);

it.effect("git probes carry the hook and protocol guards and use the primary remote", () =>
  withFixture(({ root, bin, calls, host }) =>
    Effect.gen(function* () {
      bin("bin", "git");
      bin("bin", "gh");
      let url = "git@github.com:acme/app.git\n";
      const h = host({
        env: { PATH: `${root}/bin`, GH_TOKEN: "t" },
        answer: (call) =>
          call.args.includes("get-url")
            ? ok(url)
            : call.argv0 === "gh"
              ? ok("true\n")
              : ok("someone\n"),
      });
      const results = yield* run(h, [{ git: "identity" }, { git: "fetch" }, { git: "push" }]);
      assert.deepStrictEqual(statuses(results), ["pass", "pass", "pass"]);
      const gitCalls = calls.filter((call) => call.argv0 === "git");
      for (const call of gitCalls) {
        assert.deepStrictEqual(call.args.slice(0, 2), ["-C", "/checkout"]);
        assert.deepStrictEqual(call.args.slice(2, 2 + READINESS_GIT_GUARD.length), [
          ...READINESS_GIT_GUARD,
        ]);
        assert.notProperty(call.env, "GH_TOKEN");
        assert.strictEqual(call.env.GIT_CONFIG_NOSYSTEM, "1");
      }
      assert.includeMembers(
        [...gitCalls[0]!.args],
        ["config", "--global", "--includes", "user.name"],
      );
      assert.deepStrictEqual(gitCalls[2]!.args.slice(-4), [
        "ls-remote",
        "--exit-code",
        "upstream",
        "HEAD",
      ]);
      assert.notInclude(
        gitCalls.flatMap((call) => call.args),
        "push",
      );
      const gh = calls.find((call) => call.argv0 === "gh")!;
      assert.deepStrictEqual(gh.args, ["api", "repos/acme/app", "--jq", ".permissions.push"]);
      assert.strictEqual(gh.env.GH_TOKEN, "t");
      // Another host can't be checked: a warning, and gh isn't asked.
      url = "https://gitlab.com/acme/app.git\n";
      const [other] = yield* run(h, [{ git: "push" }]);
      assert.strictEqual(other!.status, "warn");
    }),
  ),
);

it.effect("limits: 50 checks run, a spent budget runs nothing, os and Windows skip", () =>
  withFixture(({ bin, calls, host }) =>
    Effect.gen(function* () {
      bin("bin", "gh");
      const sixty = Array.from({ length: 60 }, () => ({ env: "HOME" }) as const);
      const results = yield* run(host({ env: { PATH: "", HOME: "/h" } }), sixty);
      assert.strictEqual(results.filter((result) => result.status === "pass").length, 50);
      assert.strictEqual(results.filter((result) => result.status === "skipped").length, 10);
      const [spent] = yield* run(host(), [{ gh: "github.com" }], { budgetMs: 0 });
      assert.include(spent!.detail, "timeout ran out");
      const skipped = yield* run(host({ platform: "win32" }), [
        { gh: "github.com" },
        { command: "gh", os: ["darwin"] },
        { env: "PATH", arch: ["arm64"] },
      ]);
      assert.deepStrictEqual(statuses(skipped), ["skipped", "skipped", "skipped"]);
      assert.include(skipped[0]!.detail, "unsupported on Windows");
      assert.lengthOf(calls, 0);
    }),
  ),
);

it.effect("project text loses control and ANSI characters", () =>
  withFixture(({ host }) =>
    Effect.gen(function* () {
      const [result] = yield* run(host(), [
        { env: "NOPE", name: "x\u001b[31mred", fix: "run \u001b]8;;http://e\u0007this\u0007" },
      ]);
      assert.strictEqual(result!.label, "xred");
      assert.notMatch(result!.fix!, /[\u0000-\u001f]/);
    }),
  ),
);

it("the environment passes only allowlisted names", () => {
  const env = readinessEnv(
    {
      PATH: "/usr/bin::relative:/bin",
      HOME: "/h",
      LC_ALL: "C",
      NODE_OPTIONS: "--require x",
      LD_PRELOAD: "x",
      BASH_ENV: "x",
      RUSTUP_TOOLCHAIN: "x",
      COREPACK_HOME: "x",
      GH_TOKEN: "t",
    },
    { gh: false },
  );
  assert.deepStrictEqual(env, {
    HOME: "/h",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    COREPACK_ENABLE_NETWORK: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  assert.strictEqual(readinessEnv({ GH_TOKEN: "t" }, { gh: true }).GH_TOKEN, "t");
});

it("parses version files with caps, own keys and no guesses", () => {
  assert.deepStrictEqual(
    requiredMajor("package.json", '{"engines":{"node":"^22.1 || ^24"}}', "node"),
    {
      major: 22,
    },
  );
  assert.property(requiredMajor("package.json", '{"engines":{}}', "constructor"), "warning");
  assert.property(requiredMajor("package.json", "{not json", "node"), "warning");
  assert.property(requiredMajor("package.json", "[".repeat(100_000), "node"), "warning");
  assert.deepStrictEqual(requiredMajor("sub/.nvmrc", "v20.11.0\n", "node"), { major: 20 });
  assert.deepStrictEqual(
    requiredMajor("pyproject.toml", 'requires-python = ">=3.11"\n', "python3"),
    {
      major: 3,
    },
  );
  assert.deepStrictEqual(requiredMajor("go.mod", "module x\n\ngo 1.22.1\n", "go"), { major: 1 });
  assert.deepStrictEqual(requiredMajor("global.json", '{"sdk":{"version":"8.0.100"}}', "dotnet"), {
    major: 8,
  });
  assert.deepStrictEqual(requiredMajor("composer.json", '{"require":{"php":"^8.2"}}', "php"), {
    major: 8,
  });
  // Past the 256-character field cap, a number is not found.
  assert.property(requiredMajor(".node-version", `${"v".repeat(300)}20`, "node"), "warning");
  assert.strictEqual(rustChannel('[toolchain]\nchannel = "1.82.0"\n'), "1.82.0");
  assert.strictEqual(rustChannel("stable\n"), "stable");
  assert.isNull(rustChannel('[toolchain]\nchannel = "--help"\n'));
  assert.strictEqual(githubRepository("https://x:tok@github.com/acme/app.git"), "acme/app");
  assert.isNull(githubRepository("https://github.com/-acme/app"));
  assert.isNull(githubRepository("https://gitlab.com/acme/app"));
});

it.live("a probe runs from /, with only the given environment, stdin ignored and argv0 set", () =>
  Effect.gen(function* () {
    const result = yield* spawnReadinessProbe(
      {
        path: process.execPath,
        argv0: "probe-name",
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({cwd:process.cwd(),argv0:process.argv0,opts:process.env.NODE_OPTIONS??null,stdin:require('fs').readFileSync(0,'utf8')}))",
        ],
        env: readinessEnv({ PATH: "/usr/bin:/bin", NODE_OPTIONS: "--max-old-space-size=64" }),
        timeoutMs: 30_000,
      },
      "linux",
    );
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      cwd: "/",
      argv0: "probe-name",
      opts: null,
      stdin: "",
    });
  }),
);
