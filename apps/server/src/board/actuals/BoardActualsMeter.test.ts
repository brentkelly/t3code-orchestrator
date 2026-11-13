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
  return { set, threadGroups, provide };
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
      // The key is gone: a second end has nothing.
      assert.isNull(yield* meter.relay({ op: "end", key: "thread:t1" }));
    }).pipe(machine.provide, Effect.provide(TestClock.layer()));
  },
);

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
    assert.deepStrictEqual(launch?.args.slice(-3), ["/bin/sh", "-c", "pnpm test"]);
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
