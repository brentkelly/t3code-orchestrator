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
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import {
  BoardCiLineReader,
  BoardCiTail,
  BOARD_CI_TAIL_LINE_CHARS,
  runBoardCiPass,
  runBoardCiStep,
  type BoardCiLine,
  type BoardCiStepProgress,
  type BoardCiRunRequest,
} from "./BoardCiRunner.ts";
import { BoardDiskSpace } from "./diskSpace.ts";

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
    assert.deepStrictEqual(result, { result: "failed", failedIndex: 0, exitCode: 3 });
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
    assert.deepStrictEqual(result, { result: "failed", failedIndex: 0, exitCode: null });
    assert.strictEqual(events.at(-1)!.step.status, "timed-out");
    assert.include(events.at(-1)!.step.tail, "timed out");
  }),
);

it.live("a step settles when its shell exits, even if an escaped child holds the pipes", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    // setsid puts the sleeper outside the step's process group, so the group
    // kill misses it and it keeps stdout open well past the project timeout.
    const result = yield* runBoardCiPass(
      request(cwd, [
        { name: "Daemon", command: "setsid sleep 600 & echo started", timeoutMinutes: 5 },
      ]),
      () => Effect.void,
    );
    assert.deepStrictEqual(result, { result: "passed", failedIndex: null });
  }),
);

it.live("a step's log is complete by the time the step settles", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const result = yield* runBoardCiPass(
      request(cwd, [
        { name: "Loud", command: "head -c 8000000 /dev/zero | tr '\\0' a", timeoutMinutes: 1 },
      ]),
      () => Effect.void,
    );
    assert.deepStrictEqual(result, { result: "passed", failedIndex: null });
    const log = NodeFS.statSync(NodePath.join(cwd, ".t3", "ci", "run-1", "0.log"));
    assert.strictEqual(log.size, 8_000_000);
  }),
);

/** Resolves when process `pid` exits, via `tail --pid` rather than polling. */
const awaitExit = (pid: number) =>
  Effect.callback<void>((resume) => {
    const watcher = NodeChildProcess.spawn("tail", [`--pid=${pid}`, "-f", "/dev/null"], {
      stdio: "ignore",
    });
    watcher.on("exit", () => resume(Effect.void));
    return Effect.sync(() => watcher.kill());
  });

it.live("a group member that ignores TERM is killed after the step exits", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const pidFile = NodePath.join(cwd, "pid");
    // Stays in the step's group with its pipes closed, so the step settles,
    // and ignores the TERM sent on exit; only the SIGKILL fallback stops it.
    const stubborn = `sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 600' >/dev/null 2>&1 & while [ ! -s ${pidFile} ]; do sleep 0.05; done`;
    const result = yield* runBoardCiPass(
      request(cwd, [{ name: "Leaves one", command: stubborn, timeoutMinutes: 1 }]),
      () => Effect.void,
    );
    assert.deepStrictEqual(result, { result: "passed", failedIndex: null });
    yield* awaitExit(Number(NodeFS.readFileSync(pidFile, "utf8").trim()));
  }),
);

it.live("a step that leaves nothing running arms no SIGKILL fallback", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    using timers = vi.spyOn(globalThis, "setTimeout");
    const result = yield* runBoardCiPass(
      request(cwd, [{ name: "Clean", command: "true", timeoutMinutes: 1 }]),
      () => Effect.void,
    );
    assert.deepStrictEqual(result, { result: "passed", failedIndex: null });
    // The exit's TERM finds the group empty, so no SIGKILL can later hit a reused pgid.
    assert.notInclude(
      timers.mock.calls.map((call) => call[1]),
      5_000,
    );
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

it.live("decodes a multi-byte character split across output chunks", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const { events, emit } = collect();
    yield* runBoardCiPass(
      request(cwd, [
        // ✓ is \342\234\223; the pause makes the two writes separate pipe chunks.
        {
          name: "Split",
          command: "printf '\\342'; sleep 0.2; printf '\\234\\223 done\\n'",
          timeoutMinutes: 1,
        },
      ]),
      emit,
    );
    assert.strictEqual(events[1]!.step.tail, "✓ done");
    const log = NodeFS.readFileSync(NodePath.join(cwd, ".t3", "ci", "run-1", "0.log"), "utf8");
    assert.strictEqual(log, "✓ done\n");
  }),
);

it("keeps only the last lines of output", () => {
  const tail = new BoardCiTail(3);
  tail.push("one\ntwo\nthr");
  tail.push("ee\nfour\nfive");
  assert.strictEqual(tail.text(), "three\nfour\nfive");
});

it("bounds the tail's size when output is one 10 MB line", () => {
  const tail = new BoardCiTail();
  const chunk = "x".repeat(64 * 1024);
  for (let pushed = 0; pushed < 10 * 1024 * 1024; pushed += chunk.length) tail.push(chunk);
  assert.isAtMost(tail.text().length, BOARD_CI_TAIL_LINE_CHARS + 40);
  tail.push("\nnext\n");
  const lines = tail.text().split("\n");
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0]!, /\[line truncated\]$/);
  assert.strictEqual(lines[1], "next");
});

it("treats a bare carriage return as a line break, and \\r\\n split across chunks as one", () => {
  const tail = new BoardCiTail(3);
  tail.push("10%\r20%\r30%\r");
  tail.push("\ndone");
  assert.strictEqual(tail.text(), "20%\n30%\ndone");
});

it("keeps a bare \\r that ends a clipped unfinished line", () => {
  const tail = new BoardCiTail(3, 5);
  tail.push("0123456789\r");
  tail.push("ok\n");
  assert.strictEqual(tail.text(), "01234 … [line truncated]\nok");
});

it("caps the whole tail in size on a line boundary", () => {
  const tail = new BoardCiTail(200, 500, 1_000);
  for (let line = 0; line < 200; line += 1) tail.push(`${"y".repeat(99)}\n`);
  const text = tail.text();
  assert.isAtMost(text.length, 1_000);
  assert.isTrue(text.split("\n").every((line) => line.length === 99));
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

it.live("runs a parallel group together and stops later groups once it finishes", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const { events, emit } = collect();
    // Each waits for the other's marker, so they only pass when run together.
    const result = yield* runBoardCiPass(
      request(cwd, [
        {
          name: "A",
          command: "touch a; for i in $(seq 50); do [ -f b ] && exit 0; sleep 0.1; done; exit 1",
          timeoutMinutes: 1,
        },
        {
          name: "B",
          command: "touch b; for i in $(seq 50); do [ -f a ] && exit 7; sleep 0.1; done; exit 1",
          timeoutMinutes: 1,
          parallel: true,
        },
        { name: "Never runs", command: "touch ran", timeoutMinutes: 1 },
      ]),
      emit,
    );
    assert.deepStrictEqual(result, { result: "failed", failedIndex: 1, exitCode: 7 });
    const finals = events.filter((event) => event.step.status !== "running");
    assert.deepStrictEqual(
      finals.map((event) => [event.index, event.step.status, event.step.exitCode]),
      [
        [0, "passed", 0],
        [1, "failed", 7],
      ],
    );
    assert.isTrue(events.every((event) => event.index !== 2));
    assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "ran")));
  }),
);

it.live("reads the step's result file, which adds detail and never overrides the exit code", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const { events, emit } = collect();
    const write = `printf '%s' '{"summary":"1 of 3 failed","failures":[{"title":"boom","file":"src/a.ts","line":4},{"nope":1}]}' > "$T3O_CI_RESULT"`;
    const result = yield* runBoardCiPass(
      request(cwd, [{ name: "Reports", command: `${write}; exit 0`, timeoutMinutes: 1 }]),
      emit,
    );
    assert.deepStrictEqual(result, { result: "passed", failedIndex: null });
    const final = events.at(-1)!.step;
    assert.deepStrictEqual(final.result, {
      summary: "1 of 3 failed",
      failures: [{ title: "boom", file: "src/a.ts", line: 4 }],
    });
    assert.include(final.tail, "weren't { title, detail?, file?, line? }");
  }),
);

it.live("fails a group that leaves tracked changes in the worktree", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const git = (args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("git", [...args], { cwd, stdio: "ignore" });
    git(["init", "-q"]);
    NodeFS.writeFileSync(NodePath.join(cwd, "tracked.txt"), "one\n");
    git(["add", "tracked.txt"]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    const { events, emit } = collect();
    const result = yield* runBoardCiPass(
      request(cwd, [{ name: "Formats", command: "echo two > tracked.txt", timeoutMinutes: 1 }]),
      emit,
    );
    assert.deepStrictEqual(result, { result: "failed", failedIndex: 0, exitCode: 0 });
    assert.include(events.at(-1)!.step.tail, "left tracked changes");
    // An edit that was there before the group ran is not the group's.
    const again = yield* runBoardCiPass(
      request(cwd, [{ name: "Reads", command: "cat tracked.txt", timeoutMinutes: 1 }]),
      () => Effect.void,
    );
    assert.deepStrictEqual(again, { result: "passed", failedIndex: null });
    // Re-editing an already-dirty file is still this group's doing.
    const reedit = yield* runBoardCiPass(
      request(cwd, [{ name: "Formats", command: "echo three > tracked.txt", timeoutMinutes: 1 }]),
      () => Effect.void,
    );
    assert.deepStrictEqual(reedit, { result: "failed", failedIndex: 0, exitCode: 0 });
  }),
);

it("the line reader numbers lines from 1 with each line's byte offset in the log", () => {
  const reader = new BoardCiLineReader();
  const chunks = ["héllo\r\nwor", "ld\n", "a\rb\n\nlast"];
  const lines = chunks.flatMap((chunk) => reader.push(chunk, 5));
  lines.push(...reader.flush());
  const log = Buffer.from(chunks.join(""), "utf8");
  assert.deepStrictEqual(
    lines.map((line) => [line.lineNo, line.line]),
    [
      [1, "héllo"],
      [2, "world"],
      // A bare \r doesn't end a line: only \n does, as the log file reads.
      [3, "a\rb"],
      [4, ""],
      [5, "last"],
    ],
  );
  for (const line of lines) {
    const text = log.subarray(line.byteOffset).toString("utf8");
    assert.isTrue(text.startsWith(line.line), `line ${line.lineNo} starts at its offset`);
  }
  assert.strictEqual(lines[1]!.byteOffset, Buffer.byteLength("héllo\r\n"));
  assert.strictEqual(reader.lastOutputAt, 5);
  assert.deepStrictEqual(reader.flush(), []);
});

it.live("delivers every output line to onLine, by pass index, before the step settles", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const seen: Array<[number, BoardCiLine]> = [];
    const result = yield* runBoardCiPass(
      {
        ...request(cwd, [
          { name: "Says", command: "printf 'one\\ntwo\\nthree'", timeoutMinutes: 1 },
        ]),
        indexOffset: 2,
        onLine: (index, line) => Effect.sync(() => seen.push([index, line])),
      },
      () => Effect.void,
    );
    assert.strictEqual(result.result, "passed");
    assert.deepStrictEqual(
      seen.map(([index, line]) => [index, line.lineNo, line.line, line.byteOffset]),
      [
        [2, 1, "one", 0],
        [2, 2, "two", 4],
        [2, 3, "three", 8],
      ],
    );
  }),
);

it.live("a step past its limit settles timed-out even when its kill never lands", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const tail = new BoardCiTail();
    // The kill is stubbed out, so the child neither dies nor closes its pipes
    // in time: only the hard bound can settle the step.
    const exit = yield* runBoardCiStep({
      command: "sleep 3",
      cwd,
      timeoutMs: 30,
      tail,
      logPath: NodePath.join(cwd, "0.log"),
      resultPath: NodePath.join(cwd, "0.result.json"),
      timing: { killGraceMs: 40, exitDrainMs: 40, killGroup: () => false },
    }).pipe(Effect.timeoutOption("2 seconds"));
    assert.deepStrictEqual(exit, Option.some({ status: "timed-out" as const, exitCode: null }));
    assert.include(tail.text(), "timed out");
  }),
);

it.live("a full disk makes the pass unavailable as a machine problem before any step runs", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const { events, emit } = collect();
    const result = yield* runBoardCiPass(
      request(cwd, [{ name: "Say", command: "touch ran", timeoutMinutes: 1 }]),
      emit,
    ).pipe(
      Effect.provideService(BoardDiskSpace, { freeBytes: () => Effect.succeed(1.25 * 1024 ** 3) }),
    );
    assert.strictEqual(result.result, "unavailable");
    assert.isTrue(result.result === "unavailable" && result.machine === true);
    assert.match(
      result.result === "unavailable" ? result.detail : "",
      /^Disk nearly full on .+: 1\.3 GiB free\.$/,
    );
    assert.lengthOf(events, 0);
    assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "ran")));
  }),
);

it.live("a disk that can't be read never blocks the pass", () =>
  Effect.gen(function* () {
    const cwd = workdir();
    const result = yield* runBoardCiPass(
      request(cwd, [{ name: "Say", command: "echo hi", timeoutMinutes: 1 }]),
      () => Effect.void,
    ).pipe(Effect.provideService(BoardDiskSpace, { freeBytes: () => Effect.die("statfs broke") }));
    assert.strictEqual(result.result, "passed");
  }),
);
