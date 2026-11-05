// @effect-diagnostics nodeBuiltinImport:off
/**
 * The CI script runner (T3O-44) against real subprocesses: a pass, fail-fast,
 * a timeout, a cancel that kills the process group, and the output tail.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  BoardCiTail,
  runBoardCiPass,
  type BoardCiStepProgress,
  type BoardCiRunRequest,
} from "./BoardCiRunner.ts";

const workdir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ci-"));

const request = (cwd: string, steps: BoardCiRunRequest["steps"]): BoardCiRunRequest => ({
  runId: "run-1",
  cwd,
  steps,
  logDir: NodePath.join(cwd, ".t3", "ci", "run-1"),
});

const collect = () => {
  const events: BoardCiStepProgress[] = [];
  return {
    events,
    emit: (progress: BoardCiStepProgress) => Effect.sync(() => events.push(progress)),
  };
};

it.live("runs every step in the worktree and passes", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const { events, emit } = collect();
    const result = yield* runBoardCiPass(
      request(cwd, [
        { name: "Where", command: "pwd", timeoutMinutes: 1 },
        { name: "Both streams", command: "echo out; echo err 1>&2", timeoutMinutes: 1 },
      ]),
      emit,
    );
    assert.deepStrictEqual(result, { result: "passed", failedIndex: null });
    assert.deepStrictEqual(
      events.map((event) => [event.index, event.step.status]),
      [
        [0, "running"],
        [0, "passed"],
        [1, "running"],
        [1, "passed"],
      ],
    );
    assert.strictEqual(events[1]!.step.tail.trim(), NodeFS.realpathSync(cwd));
    assert.include(events[3]!.step.tail, "out");
    assert.include(events[3]!.step.tail, "err");
    assert.strictEqual(events[3]!.step.exitCode, 0);
    const log = NodeFS.readFileSync(NodePath.join(cwd, ".t3", "ci", "run-1", "1.log"), "utf8");
    assert.include(log, "err");
  }),
);

it.live("stops at the first failing step", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const { events, emit } = collect();
    const result = yield* runBoardCiPass(
      request(cwd, [
        { name: "Fails", command: "echo broken; exit 3", timeoutMinutes: 1 },
        { name: "Never runs", command: "touch ran", timeoutMinutes: 1 },
      ]),
      emit,
    );
    assert.deepStrictEqual(result, { result: "failed", failedIndex: 0 });
    const last = events.at(-1)!;
    assert.strictEqual(last.step.status, "failed");
    assert.strictEqual(last.step.exitCode, 3);
    assert.include(last.step.tail, "broken");
    assert.isFalse(events.some((event) => event.index === 1));
    assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "ran")));
  }),
);

it.live("times a step out and kills it", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const { events, emit } = collect();
    // A fractional minute: 0.0005 min is 30 ms.
    const result = yield* runBoardCiPass(
      request(cwd, [{ name: "Hangs", command: "sleep 30", timeoutMinutes: 0.0005 }]),
      emit,
    );
    assert.deepStrictEqual(result, { result: "failed", failedIndex: 0 });
    assert.strictEqual(events.at(-1)!.step.status, "timed-out");
    assert.include(events.at(-1)!.step.tail, "timed out");
  }),
);

/** Resolves once `path` exists, woken by the directory's change events. */
const awaitFile = (path: string) =>
  Effect.callback<void>((resume) => {
    const watcher = NodeFS.watch(NodePath.dirname(path), () => {
      if (NodeFS.existsSync(path)) {
        watcher.close();
        resume(Effect.void);
      }
    });
    if (NodeFS.existsSync(path)) {
      watcher.close();
      resume(Effect.void);
    }
    return Effect.sync(() => watcher.close());
  });

it.live("an interrupted pass kills the step's whole process group", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const started = NodePath.join(cwd, "started");
    const gone = NodePath.join(cwd, "gone");
    // The shell forks a grandchild that would outlive a kill of the shell
    // alone; it records the TERM the process-group kill sends it.
    const grandchild = `sh -c 'trap "echo gone > ${gone}; exit 0" TERM; echo up > ${started}; while :; do sleep 1; done' & wait`;
    const fiber = yield* runBoardCiPass(
      request(cwd, [{ name: "Long", command: grandchild, timeoutMinutes: 5 }]),
      () => Effect.void,
    ).pipe(Effect.forkChild);
    yield* awaitFile(started);
    yield* Fiber.interrupt(fiber);
    yield* awaitFile(gone);
    assert.strictEqual(NodeFS.readFileSync(gone, "utf8").trim(), "gone");
  }),
);

it("keeps only the last lines of output", () => {
  const tail = new BoardCiTail(3);
  tail.push("one\ntwo\nthr");
  tail.push("ee\nfour\nfive");
  assert.strictEqual(tail.text(), "three\nfour\nfive");
});

it.live("keeps its logs out of git status in a repo that does not ignore .t3/", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd });
    const { emit } = collect();
    const steps = [{ name: "Say", command: "echo hi", timeoutMinutes: 1 }];
    yield* runBoardCiPass(request(cwd, steps), emit);
    yield* runBoardCiPass(request(cwd, steps), emit);
    assert.isTrue(NodeFS.existsSync(NodePath.join(cwd, ".t3", "ci", "run-1", "0.log")));
    const status = NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
    });
    assert.strictEqual(status, "");
    const exclude = NodeFS.readFileSync(NodePath.join(cwd, ".git", "info", "exclude"), "utf8");
    assert.lengthOf(
      exclude.split("\n").filter((line) => line === "/.t3/ci/"),
      1,
    );
  }),
);

it.live("a log directory it cannot create makes the pass unavailable, not a crash", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    NodeFS.writeFileSync(NodePath.join(cwd, ".t3"), "a file, not a directory");
    const { events, emit } = collect();
    const result = yield* runBoardCiPass(
      request(cwd, [{ name: "Say", command: "echo hi", timeoutMinutes: 1 }]),
      emit,
    );
    assert.strictEqual(result.result, "unavailable");
    assert.lengthOf(events, 0);
  }),
);
