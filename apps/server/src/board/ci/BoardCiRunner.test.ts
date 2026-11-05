// @effect-diagnostics nodeBuiltinImport:off
/**
 * The CI script runner (T3O-44) against real subprocesses: a pass, fail-fast,
 * a timeout, a cancel that kills the process group, and the output tail.
 */
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";

import {
  BoardCiTail,
  runBoardCiPass,
  type BoardCiStepProgress,
  type BoardCiRunRequest,
} from "./BoardCiRunner.ts";

const workdir = () => NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3o-ci-"));

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
    assert.strictEqual(events[1]!.step.tail.trim(), NodeFs.realpathSync(cwd));
    assert.include(events[3]!.step.tail, "out");
    assert.include(events[3]!.step.tail, "err");
    assert.strictEqual(events[3]!.step.exitCode, 0);
    const log = NodeFs.readFileSync(NodePath.join(cwd, ".t3", "ci", "run-1", "1.log"), "utf8");
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
    assert.isFalse(NodeFs.existsSync(NodePath.join(cwd, "ran")));
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

it.live("an interrupted pass kills the step's whole process group", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const started = yield* Deferred.make<void>();
    const pidFile = NodePath.join(cwd, "child.pid");
    const fiber = yield* runBoardCiPass(
      request(cwd, [
        // The shell forks a grandchild that would outlive a plain kill.
        { name: "Long", command: `sleep 60 & echo $! > ${pidFile}; wait`, timeoutMinutes: 5 },
      ]),
      (progress) =>
        progress.step.status === "running" ? Deferred.succeed(started, undefined) : Effect.void,
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    // The grandchild writes its pid as soon as it is forked.
    const pid = yield* Effect.promise(async () => {
      for (;;) {
        if (NodeFs.existsSync(pidFile)) {
          const text = NodeFs.readFileSync(pidFile, "utf8").trim();
          if (text.length > 0) return Number(text);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    yield* Fiber.interrupt(fiber);
    const alive = yield* Effect.promise(async () => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          process.kill(pid, 0);
        } catch {
          return false;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      return true;
    });
    assert.isFalse(alive);
  }),
);

it("keeps only the last lines of output", () => {
  const tail = new BoardCiTail(3);
  tail.push("one\ntwo\nthr");
  tail.push("ee\nfour\nfive");
  assert.strictEqual(tail.text(), "three\nfour\nfive");
});
