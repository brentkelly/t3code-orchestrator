/**
 * The worker side of measured actuals (T3O-87): an agent step through its thread's own
 * scope, a CI pass through the scopes it wraps its steps in, a restart's partial reading,
 * and a machine without scopes that reads "not measured", never 0.
 */
import { BOARD_ACTUALS_NO_CGROUP_REASON } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { BoardMachine } from "../capacity/machine.ts";
import { BoardActualsTap, makeBoardActualsMeter } from "./BoardActualsMeter.ts";
import { BoardCgroupReader } from "./cgroupReader.ts";

const GiB = 1024 ** 3;

/** Cgroup files by group, and the groups each thread and unit lives in. */
const makeMachine = () => {
  const files = new Map<string, Record<string, string>>();
  const threadGroups = new Map<string, string>();
  const unitGroups = new Map<string, string>();
  /** What a wrapped scope copied out as it exited, by the meter's id for it. */
  const finals = new Map<string, Record<string, string>>();
  let units = 0;
  const set = (group: string, cpuSeconds: number, ramGiB: number, ioRead = 0) =>
    files.set(group, {
      "cpu.stat": `usage_usec ${cpuSeconds * 1e6}\nuser_usec 0\n`,
      "memory.stat": `anon ${ramGiB * GiB}\nfile ${100 * GiB}\nshmem 0\n`,
      "io.stat": `8:0 rbytes=${ioRead} wbytes=0 rios=0 wios=0\n`,
    });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(BoardCgroupReader, {
        readFile: (group, file) => Effect.sync(() => files.get(group)?.[file] ?? null),
        unitControlGroup: (unit) => Effect.sync(() => unitGroups.get(unit) ?? null),
        finalSnapshot: {
          script: (id) => `trap 'copy ${id}' EXIT`,
          read: (id) =>
            Effect.sync(() => {
              const copy = finals.get(id);
              finals.delete(id);
              return copy === undefined
                ? null
                : {
                    controlGroup: copy.group!,
                    cpuStat: copy["cpu.stat"] ?? null,
                    memoryStat: copy["memory.stat"] ?? null,
                    ioStat: copy["io.stat"] ?? null,
                  };
            }),
        },
      }),
      Effect.provideService(BoardMachine, {
        cpuCount: Effect.succeed(8),
        totalMemoryBytes: Effect.succeed(32 * GiB),
        availableMemoryBytes: Effect.succeed(null),
        agentSliceMemoryHighBytes: Effect.succeed(null),
        freeDiskBytes: () => Effect.succeed(null),
        diskUsageBytes: () => Effect.succeed(7 * 1000 ** 3),
      }),
      Effect.provideService(AgentScope, {
        ...AgentScope.defaultValue(),
        wrap: ({ command, args }) =>
          Effect.sync(() => {
            units += 1;
            const unit = `t3code-board-ci-${units}.scope`;
            unitGroups.set(unit, `/ci/${units}`);
            return { command: "/bin/sh", args: ["-c", "scoped", command, ...args], unit };
          }),
        controlGroup: (threadId) => Effect.sync(() => threadGroups.get(threadId) ?? null),
      }),
    );
  /** A scope that ended: its files are gone. */
  const drop = (group: string) => void files.delete(group);
  /** The `n`th wrapped scope exits: its group goes, and its trap's copy is left behind. */
  const exit = (n: number) => {
    const group = `/ci/${n}`;
    finals.set(String(n), { ...files.get(group), group });
    files.delete(group);
  };
  return { set, drop, exit, threadGroups, provide };
};

it.effect(
  "an agent step reads so far while it runs, then ends with its worktree's footprint",
  () => {
    const machine = makeMachine();
    return Effect.gen(function* () {
      machine.threadGroups.set("t1", "/agent/t1");
      machine.set("/agent/t1", 100, 1);
      const meter = yield* makeBoardActualsMeter;
      const read = { op: "read", key: "thread:t1", threadId: "t1" } as const;
      const first = yield* meter.relay(read);
      assert.include(first, { measured: true, running: true, partial: false, cpuCoreSeconds: 0 });
      for (let tick = 1; tick <= 12; tick++) {
        yield* TestClock.adjust("5 seconds");
        machine.set("/agent/t1", 100 + tick * 10, tick === 6 ? 3 : 1);
        yield* meter.tick;
      }
      const soFar = yield* meter.relay(read);
      assert.include(soFar, { running: true, cpuCoreSeconds: 120, peakRamBytes: 3 * GiB });
      // Two cores for the minute, page cache never counted.
      assert.strictEqual(soFar?.peakCpuCores, 2);
      const ended = yield* meter.relay({ op: "end", key: "thread:t1", worktreePath: "/w/card" });
      assert.include(ended, { running: false, diskBytes: 7 * 1000 ** 3 });
      // A retried end, its first reply lost, gets the same reading, disk included.
      assert.deepStrictEqual(yield* meter.relay({ op: "end", key: "thread:t1" }), ended);
      // A resumed thread under the same key starts a new run.
      const resumed = yield* meter.relay(read);
      assert.include(resumed, { running: true, cpuCoreSeconds: 0 });
    }).pipe(machine.provide, Effect.provide(TestClock.layer()));
  },
);

it.effect("a thread entry the board stops asking about is dropped, not sampled forever", () => {
  const machine = makeMachine();
  return Effect.gen(function* () {
    machine.threadGroups.set("t1", "/agent/t1");
    machine.set("/agent/t1", 100, 1);
    const meter = yield* makeBoardActualsMeter;
    // The reply to this read is lost, and the step ends before the board's next sweep.
    yield* meter.relay({ op: "read", key: "thread:t1", threadId: "t1" });
    for (let tick = 1; tick <= 120; tick++) {
      yield* TestClock.adjust("5 seconds");
      yield* meter.tick;
    }
    assert.isNull(yield* meter.relay({ op: "end", key: "thread:t1" }));
  }).pipe(machine.provide, Effect.provide(TestClock.layer()));
});

it.effect("a key the board saw before but this worker lost reads partial", () => {
  const machine = makeMachine();
  return Effect.gen(function* () {
    machine.threadGroups.set("t1", "/agent/t1");
    machine.set("/agent/t1", 50, 1);
    const meter = yield* makeBoardActualsMeter;
    const reading = yield* meter.relay({
      op: "read",
      key: "thread:t1",
      threadId: "t1",
      seen: true,
    });
    assert.include(reading, { measured: true, partial: true });
  }).pipe(machine.provide, Effect.provide(TestClock.layer()));
});

it.effect("a thread with no scope of its own reads not measured, never 0", () => {
  const machine = makeMachine();
  return Effect.gen(function* () {
    const meter = yield* makeBoardActualsMeter;
    const reading = yield* meter.relay({ op: "read", key: "thread:t2", threadId: "t2" });
    assert.include(reading, { measured: false, reason: BOARD_ACTUALS_NO_CGROUP_REASON });
    assert.isNull(reading?.cpuCoreSeconds);
  }).pipe(machine.provide, Effect.provide(TestClock.layer()));
});

it.effect("a CI pass is wrapped in scopes of its own, sampled across its steps", () => {
  const machine = makeMachine();
  return Effect.gen(function* () {
    const meter = yield* makeBoardActualsMeter;
    const tap = meter.tap("ci:run-1");
    const launch = yield* tap.wrap("pnpm test");
    assert.deepStrictEqual(launch?.args.slice(-3), [
      "/bin/sh",
      "-c",
      "trap 'copy 1' EXIT\npnpm test",
    ]);
    machine.set("/ci/1", 0, 2, 0);
    yield* meter.tick;
    yield* TestClock.adjust("5 seconds");
    machine.set("/ci/1", 20, 6, 4096);
    yield* meter.tick;
    // The pass's runner reads the tap from its context: a second step joins the same key.
    const second = yield* Effect.flatMap(BoardActualsTap, (current) =>
      current.wrap("pnpm lint"),
    ).pipe(Effect.provideService(BoardActualsTap, tap));
    assert.isNotNull(second);
    machine.set("/ci/2", 0, 1);
    yield* meter.finish("ci:run-1");
    // Not the board's to begin: an unknown CI key reads nothing.
    assert.isNull(yield* meter.relay({ op: "read", key: "ci:other" }));
    const ended = yield* meter.relay({ op: "end", key: "ci:run-1" });
    assert.include(ended, {
      measured: true,
      running: false,
      cpuCoreSeconds: 20,
      peakRamBytes: 7 * GiB,
      ioReadBytes: 4096,
    });
  }).pipe(machine.provide, Effect.provide(TestClock.layer()));
});

it.effect("a thread's next session is counted from 0, not against its last session", () => {
  const machine = makeMachine();
  return Effect.gen(function* () {
    machine.threadGroups.set("t1", "/agent/t1-a");
    machine.set("/agent/t1-a", 100, 1);
    const meter = yield* makeBoardActualsMeter;
    const read = { op: "read", key: "thread:t1", threadId: "t1" } as const;
    yield* meter.relay(read);
    yield* TestClock.adjust("5 seconds");
    machine.set("/agent/t1-a", 130, 1);
    yield* meter.tick;
    // The session ends and a new one starts in a scope of its own, its counters from 0.
    machine.drop("/agent/t1-a");
    machine.threadGroups.set("t1", "/agent/t1-b");
    machine.set("/agent/t1-b", 40, 1);
    yield* TestClock.adjust("5 seconds");
    yield* meter.tick;
    const reading = yield* meter.relay(read);
    assert.strictEqual(reading?.cpuCoreSeconds, 30 + 40);
  }).pipe(machine.provide, Effect.provide(TestClock.layer()));
});

it.effect("a CI step shorter than a tick is measured, from its first second", () => {
  const machine = makeMachine();
  return Effect.gen(function* () {
    const meter = yield* makeBoardActualsMeter;
    yield* meter.tap("ci:run-1").wrap("pnpm fmt");
    // The step's scope has run for a second when it is first seen, and is gone before a tick.
    machine.set("/ci/1", 3, 1);
    yield* TestClock.adjust("1 second");
    machine.drop("/ci/1");
    yield* meter.finish("ci:run-1");
    const ended = yield* meter.relay({ op: "end", key: "ci:run-1" });
    assert.include(ended, { measured: true, cpuCoreSeconds: 3 });
  }).pipe(machine.provide, Effect.provide(TestClock.layer()));
});

// The scope's group goes the moment its command exits, before the last tick can read it.
it.effect("a step's last seconds count, from the copy its scope leaves as it exits", () => {
  const machine = makeMachine();
  return Effect.gen(function* () {
    const meter = yield* makeBoardActualsMeter;
    yield* meter.tap("setup:/w").wrap("pnpm install");
    machine.set("/ci/1", 0, 1);
    yield* meter.tick;
    yield* TestClock.adjust("5 seconds");
    machine.set("/ci/1", 10, 1);
    yield* meter.tick;
    // Four more seconds of work, then the command exits between ticks.
    machine.set("/ci/1", 14, 1);
    machine.exit(1);
    yield* meter.finish("setup:/w");
    const ended = yield* meter.relay({ op: "end", key: "setup:/w" });
    assert.include(ended, { measured: true, cpuCoreSeconds: 14 });
  }).pipe(machine.provide, Effect.provide(TestClock.layer()));
});
