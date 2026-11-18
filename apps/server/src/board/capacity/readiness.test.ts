// @effect-diagnostics nodeBuiltinImport:off - the fake script writes a real log file.
/**
 * A project's readiness on a worker (T3O-86): the committed script, one run shared by every
 * board, a failed fetch keeping the last result, a new version keeping a ready worker ready
 * until it has run, and two scheduled failures before not-ready. T3O-124: declarative checks
 * run first, and the script only when the board trusts the project.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { BOARD_CAPACITY_LOG_MAX_BYTES, type BoardReadinessCheck } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makeReadiness, READINESS_PASSING_INTERVAL_MS } from "./readiness.ts";

type StepExit = {
  readonly status: "passed" | "failed" | "timed-out";
  readonly exitCode: number | null;
};

const makeHarness = () => {
  const state = {
    checkout: "/repo" as string | null,
    fetchOk: true,
    script: { version: "blob-1", text: "check-docker\n" } as {
      version: string;
      text: string;
    } | null,
    exits: [] as Array<StepExit>,
    runs: [] as Array<string>,
    gate: null as Deferred.Deferred<void> | null,
    /** What the script writes to its log file, beyond the tail. */
    log: null as string | null,
    /** Everything run, in order: check commands as `check <argv>`, the script as `script`. */
    events: [] as Array<string>,
    /** Whether each check's cwd was an empty folder when it ran. */
    checkCwds: [] as Array<{ readonly cwd: string; readonly empty: boolean }>,
    /** Repository files the checks read, by path. */
    files: new Map<string, string>(),
  };
  const readiness = makeReadiness({
    git: {
      checkout: () => Effect.sync(() => state.checkout),
      fetch: () => Effect.sync(() => state.fetchOk),
      committed: (_checkout, path) =>
        Effect.sync(() =>
          path === ".t3/ready.sh" || path.endsWith("ready.sh")
            ? state.script
            : state.files.has(path)
              ? { version: `blob:${path}`, text: state.files.get(path)! }
              : null,
        ),
      has: (_checkout, path) => Effect.sync(() => state.files.has(path)),
    },
    host: {
      run: (call) =>
        Effect.sync(() => {
          state.events.push(`check ${call.args.join(" ")}`);
          state.checkCwds.push({ cwd: call.cwd, empty: NodeFS.readdirSync(call.cwd).length === 0 });
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        }),
      env: { PATH: "", HOME: "/nonexistent-home", TMPDIR: "/nonexistent-tmp" },
      forbiddenRoots: Effect.succeed([]),
    },
    runStep: ((input: {
      readonly command: string;
      readonly tail: { push(text: string): void };
      readonly logPath?: string;
    }) =>
      Effect.gen(function* () {
        state.runs.push(input.command);
        state.events.push("script");
        if (state.log !== null && input.logPath !== undefined) {
          NodeFS.writeFileSync(input.logPath, state.log);
        }
        if (state.gate !== null) yield* Deferred.await(state.gate);
        input.tail.push("checking docker\nDocker is not running\n");
        return state.exits.shift() ?? { status: "passed", exitCode: 0 };
      })) as never,
  });
  return { state, readiness };
};

const input = {
  repositoryKey: "github.com/acme/app",
  path: ".t3/ready.sh",
  timeoutSeconds: 60,
  checks: [] as ReadonlyArray<BoardReadinessCheck>,
  runScript: true,
};

it.effect("runs the committed script with the checkout named, and reads its exit", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    state.exits.push({ status: "failed", exitCode: 3 });
    const result = yield* readiness.check("board-a", input);
    assert.deepInclude(result, {
      state: "not-ready",
      exitCode: 3,
      lastLine: "Docker is not running",
      version: "blob-1",
    });
    assert.match(state.runs[0]!, /^T3O_READY_CHECKOUT='\/repo' sh '/);
    // The full output is fetched on demand, never in the snapshot.
    assert.include(readiness.output(readiness.forBoard("board-a")[0]!) ?? "", "checking docker");
    assert.notInclude(JSON.stringify(readiness.forBoard("board-a")), "checking docker");
    assert.strictEqual(readiness.notReady("board-a", input.repositoryKey, undefined), "not-ready");
    // A long log keeps its last 64 KB, read from the run's log file.
    state.log = `${"x".repeat(70_000)}the end`;
    yield* readiness.check("board-b", { ...input, path: "b/ready.sh" });
    const output = readiness.output(readiness.forBoard("board-b")[0]!) ?? "";
    assert.strictEqual(output.length, BOARD_CAPACITY_LOG_MAX_BYTES);
    assert.isTrue(output.endsWith("the end"));
  }),
);

it.effect("no script means ready; no checkout means not set up", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    state.script = null;
    assert.deepInclude(yield* readiness.check("board-a", input), {
      state: "ready",
      noScript: true,
    });
    const other = makeHarness();
    other.state.checkout = null;
    assert.strictEqual((yield* other.readiness.check("board-a", input)).state, "not-set-up");
    // A path outside the repository is not "no script": it never reads ready.
    const outside = yield* readiness.check("board-a", { ...input, path: "../ready.sh" });
    assert.strictEqual(outside.state, "not-ready");
  }),
);

it.effect("one run serves two boards, and a request during it joins it", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    state.gate = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(readiness.check("board-a", input));
    yield* Effect.yieldNow;
    const second = yield* Effect.forkChild(readiness.check("board-b", input));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(state.gate, undefined);
    const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)];
    assert.lengthOf(state.runs, 1);
    assert.deepStrictEqual(a, b);
    // Each board sees the project it asked about; a third sees nothing.
    assert.lengthOf(readiness.forBoard("board-b"), 1);
    assert.lengthOf(readiness.forBoard("board-c"), 0);
    // Asked again within 30 s: the same result, no new run.
    state.gate = null;
    yield* readiness.check("board-a", input);
    assert.lengthOf(state.runs, 1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a failed fetch keeps the last result; a new version keeps a ready worker ready", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    yield* readiness.check("board-a", input);
    yield* TestClock.adjust(READINESS_PASSING_INTERVAL_MS);
    state.fetchOk = false;
    state.exits.push({ status: "failed", exitCode: 1 });
    const kept = yield* readiness.check("board-a", input);
    assert.deepInclude(kept, { state: "ready", fetchFailed: true });
    assert.lengthOf(state.runs, 1);

    // The script changed on the default branch and its first scheduled run fails: the worker
    // stays ready on its last passing result until a second failure.
    state.fetchOk = true;
    state.script = { version: "blob-2", text: "stricter\n" };
    yield* TestClock.adjust(READINESS_PASSING_INTERVAL_MS);
    yield* readiness.sweep();
    assert.strictEqual(readiness.forBoard("board-a")[0]?.state, "ready");
    yield* TestClock.adjust(READINESS_PASSING_INTERVAL_MS);
    state.exits.push({ status: "failed", exitCode: 1 });
    yield* readiness.sweep();
    assert.deepInclude(readiness.forBoard("board-a")[0], { state: "not-ready", version: "blob-2" });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a re-check a human asked for counts at once", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    yield* readiness.check("board-a", input);
    yield* TestClock.adjust(60_000);
    state.exits.push({ status: "failed", exitCode: 1 });
    const result = yield* readiness.check("board-a", { ...input, requested: true });
    assert.strictEqual(result.state, "not-ready");
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "readiness gates each board at its own path, and a path no board holds gates nothing",
  () =>
    Effect.gen(function* () {
      const { state, readiness } = makeHarness();
      state.exits.push({ status: "failed", exitCode: 1 });
      yield* readiness.check("board-b", { ...input, path: "other/ready.sh" });
      yield* readiness.check("board-a", input);
      // board-b's failing path never blocks board-a.
      assert.isNull(readiness.notReady("board-a", input.repositoryKey, undefined));
      assert.strictEqual(
        readiness.notReady("board-b", input.repositoryKey, undefined),
        "not-ready",
      );
      // board-b moves to a passing path: its old failure stops gating it.
      yield* readiness.check("board-b", input);
      assert.isNull(readiness.notReady("board-b", input.repositoryKey, undefined));
      assert.lengthOf(readiness.forBoard("board-b"), 1);
      // A board that left gates nothing.
      state.exits.push({ status: "failed", exitCode: 1 });
      yield* readiness.check("board-c", { ...input, path: "c/ready.sh" });
      assert.include(readiness.boards(), "board-c");
      readiness.forgetBoard("board-c");
      assert.notInclude(readiness.boards(), "board-c");
      assert.isNull(readiness.notReady("board-c", input.repositoryKey, undefined));
      // Two projects with no remote are two entries: one's failure never gates the other.
      const local = { ...input, repositoryKey: null };
      state.exits.push({ status: "failed", exitCode: 1 });
      yield* readiness.check("board-a", { ...local, projectId: "p-fails" });
      yield* readiness.check("board-a", { ...local, projectId: "p-passes" });
      assert.strictEqual(readiness.notReady("board-a", null, "p-fails"), "not-ready");
      assert.isNull(readiness.notReady("board-a", null, "p-passes"));
    }),
);

it.effect("a caller that joined a run is answered when the run is interrupted", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    state.gate = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(readiness.check("board-a", input));
    yield* Effect.yieldNow;
    const joined = yield* Effect.forkChild(readiness.check("board-b", input));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(first);
    assert.strictEqual((yield* Fiber.join(joined)).state, "checking");
    // The entry isn't stuck: the next check runs.
    state.gate = null;
    yield* TestClock.adjust(60_000);
    assert.strictEqual((yield* readiness.check("board-a", input)).state, "ready");
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a failed fetch on a not-ready project still reads not-ready, not checking", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    state.exits.push({ status: "failed", exitCode: 1 });
    yield* readiness.check("board-a", input);
    yield* TestClock.adjust(60_000);
    state.fetchOk = false;
    assert.deepInclude(yield* readiness.check("board-a", input), {
      state: "not-ready",
      fetchFailed: true,
    });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("an untrusted script is not run, is reported, and the worker stays ready", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    state.exits.push({ status: "failed", exitCode: 1 });
    const result = yield* readiness.check("board-a", { ...input, runScript: false });
    assert.lengthOf(state.runs, 0);
    assert.deepInclude(result, { state: "ready", scriptSkipped: "not-trusted", version: null });
    assert.include(readiness.output(result) ?? "", "not run: not trusted");
    assert.isNull(readiness.notReady("board-a", input.repositoryKey, undefined));
  }),
);

it.effect("checks run first from an empty folder; a trusted script runs after them", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    state.files.set(".node-version", "22\n");
    const checks: ReadonlyArray<BoardReadinessCheck> = [
      { exists: ".node-version" },
      { git: "identity" },
    ];
    const result = yield* readiness.check("board-a", { ...input, checks });
    assert.deepStrictEqual(state.events.at(-1), "script");
    assert.isTrue(state.events.slice(0, -1).every((event) => event.startsWith("check ")));
    // git is not on this harness's PATH, so the identity check fails.
    assert.strictEqual(result.state, "not-ready");
    assert.include(result.lastLine ?? "", "git identity");
    assert.deepInclude(result, { checks: { passed: 1, failed: 1, warned: 0 } });
    const output = readiness.output(result) ?? "";
    assert.match(output, /^pass {2}\.node-version/);
    assert.include(output, "FAIL  git identity");
    assert.include(output, "checking docker");

    // A failing check marked warn is a warning: the worker is ready.
    yield* TestClock.adjust(60_000);
    const warned = yield* readiness.check("board-a", {
      ...input,
      checks: [{ exists: ".node-version" }, { git: "identity", warn: true }],
      requested: true,
    });
    assert.deepInclude(warned, { state: "ready", checks: { passed: 1, failed: 0, warned: 1 } });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a check that runs a command starts in an empty folder, never the checkout", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    const bin = NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/t3o-ready-test-bin-`);
    try {
      NodeFS.writeFileSync(`${bin}/tool`, "#!/bin/sh\necho 9.1.0\n", { mode: 0o755 });
      yield* readiness.check("board-a", {
        ...input,
        runScript: false,
        checks: [{ command: "tool", paths: [bin], version: { atLeast: "1" } }],
      });
      assert.lengthOf(state.checkCwds, 1);
      assert.isTrue(state.checkCwds[0]!.empty);
      assert.notStrictEqual(state.checkCwds[0]!.cwd, "/repo");
      // The run folder is gone afterwards.
      assert.isFalse(NodeFS.existsSync(state.checkCwds[0]!.cwd));
    } finally {
      NodeFS.rmSync(bin, { recursive: true, force: true });
    }
  }),
);

it.effect("trust and checks key separate entries; the sweep reruns what each asked", () =>
  Effect.gen(function* () {
    const { state, readiness } = makeHarness();
    state.files.set("marker", "x");
    const trusted = { ...input, checks: [{ exists: "marker" }] as const, runScript: true };
    const untrusted = { ...trusted, runScript: false };
    const a = yield* readiness.check("board-a", trusted);
    const b = yield* readiness.check("board-b", untrusted);
    assert.notStrictEqual(a.configKey, b.configKey);
    assert.lengthOf(state.runs, 1);
    assert.isUndefined(a.scriptSkipped);
    assert.strictEqual(b.scriptSkipped, "not-trusted");
    // An hour on, the sweep re-runs both with their own checks and trust: one script run more.
    yield* TestClock.adjust(READINESS_PASSING_INTERVAL_MS);
    state.files.delete("marker");
    yield* readiness.sweep();
    assert.lengthOf(state.runs, 2);
    assert.strictEqual(readiness.forBoard("board-b")[0]?.scriptSkipped, "not-trusted");
    // The stored checks ran again: the missing marker now fails both (a scheduled second
    // failure is needed to turn a ready worker not-ready, so they hold ready once).
    assert.strictEqual(readiness.forBoard("board-a")[0]?.state, "ready");
    yield* TestClock.adjust(READINESS_PASSING_INTERVAL_MS);
    yield* readiness.sweep();
    assert.strictEqual(readiness.forBoard("board-a")[0]?.state, "not-ready");
    assert.strictEqual(readiness.forBoard("board-b")[0]?.state, "not-ready");
  }).pipe(Effect.provide(TestClock.layer())),
);
