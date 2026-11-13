/**
 * T3o (T3O-87): the worker side of measured actuals, sampled every 5 s: an agent step through
 * its thread's own scope, a CI pass or setup run through scopes its commands are wrapped in.
 * A key the board saw before but this server lost (a restart) reads partial.
 */
import {
  BOARD_ACTUALS_NO_CGROUP_REASON,
  BOARD_ACTUALS_SAMPLE_INTERVAL_MS,
  type BoardStepReading,
  type BoardWorkerActualsInput,
} from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { BoardMachine } from "../capacity/machine.ts";
import { BoardCgroupReader } from "./cgroupReader.ts";
import { ActualsAccumulator, parseCgroupSample, type CgroupSample } from "./cgroupStats.ts";

/** Finished CI and setup readings kept for the board to collect. */
const MAX_FINISHED = 200;

export interface BoardActualsTapShape {
  /** The command wrapped in its own scope and sampled under the tap's key; null runs it as
      before (no systemd scopes here). */
  readonly wrap: (
    command: string,
  ) => Effect.Effect<{ readonly command: string; readonly args: ReadonlyArray<string> } | null>;
}

/** What `runBoardCiStep` wraps its command with. The default measures nothing. */
export class BoardActualsTap extends Context.Reference<BoardActualsTapShape>(
  "t3/board/actuals/BoardActualsTap",
  { defaultValue: () => ({ wrap: () => Effect.succeed(null) }) },
) {}

export interface BoardActualsMeterShape {
  /** The board's relay call (`actuals`). Null when this server has nothing for the key. */
  readonly relay: (input: BoardWorkerActualsInput) => Effect.Effect<BoardStepReading | null>;
  /** A tap sampling every command it wraps under `key` (a CI pass, a setup run). */
  readonly tap: (key: string) => BoardActualsTapShape;
  /** The pass or run is over: a last sample, kept for the board's `end`. */
  readonly finish: (key: string) => Effect.Effect<void>;
  /** One sampling pass over every running key. The layer runs it every 5 s. */
  readonly tick: Effect.Effect<void>;
}

export class BoardActualsMeter extends Context.Service<BoardActualsMeter, BoardActualsMeterShape>()(
  "t3/board/actuals/BoardActualsMeter",
) {}

/** Ticks a wrapped unit is looked up for before it is taken as gone: a short step's unit may
    have exited before any tick saw it. */
const UNIT_RESOLVE_TRIES = 3;

/** One early sample after a command is wrapped, so a step shorter than a tick is measured. */
const EARLY_SAMPLE_MS = 1_000;

type Source = (
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "unit"; readonly unit: string }
) & {
  cgroup: string | null;
  /** Groups resolved after the first: a thread's next session, created within the step. */
  resolved: number;
  tries: number;
};

interface Entry {
  readonly sources: Map<string, Source>;
  readonly accumulator: ActualsAccumulator;
  running: boolean;
  partial: boolean;
}

export const makeBoardActualsMeter = Effect.gen(function* () {
  const agentScope = yield* AgentScope;
  const reader = yield* BoardCgroupReader;
  const machine = yield* BoardMachine;
  const entries = new Map<string, Entry>();
  const ticking = yield* Semaphore.make(1);

  const sampleOf = Effect.fnUntraced(function* (controlGroup: string) {
    const [cpuStat, memoryStat, ioStat] = yield* Effect.all([
      reader.readFile(controlGroup, "cpu.stat"),
      reader.readFile(controlGroup, "memory.stat"),
      reader.readFile(controlGroup, "io.stat"),
    ]);
    return parseCgroupSample({ cpuStat, memoryStat, ioStat });
  });

  const resolve = (source: Source) =>
    source.kind === "thread"
      ? (agentScope.controlGroup?.(source.threadId) ?? Effect.succeed(null))
      : reader.unitControlGroup(source.unit);

  const lookUp = Effect.fnUntraced(function* (source: Source) {
    source.tries += 1;
    source.cgroup = yield* resolve(source);
    if (source.cgroup !== null) source.resolved += 1;
  });

  // Untraced: every running key, every 5 s. One at a time: an early sample may race a tick.
  const tickEntry = Effect.fnUntraced(function* (entry: Entry) {
    const atMs = yield* Clock.currentTimeMillis;
    const samples = new Map<string, CgroupSample | null>();
    const fresh = new Set<string>();
    for (const [id, source] of entry.sources) {
      if (
        source.cgroup === null &&
        (source.kind === "thread" || source.tries < UNIT_RESOLVE_TRIES)
      ) {
        yield* lookUp(source);
      }
      let sample = source.cgroup === null ? null : yield* sampleOf(source.cgroup);
      // A thread's next session gets a new scope: look its group up again.
      if (sample === null && source.kind === "thread" && source.cgroup !== null) {
        yield* lookUp(source);
        sample = source.cgroup === null ? null : yield* sampleOf(source.cgroup);
      }
      if (source.cgroup === null) continue;
      // Each group its own source: a new session's counters restart at 0.
      const sampleId = `${id}@${source.cgroup}`;
      samples.set(sampleId, sample);
      if (source.kind === "unit" || source.resolved > 1) fresh.add(sampleId);
    }
    entry.accumulator.addTick(atMs, samples, fresh);
  }, ticking.withPermits(1));

  const tick = Effect.gen(function* () {
    for (const entry of entries.values()) {
      if (entry.running) yield* tickEntry(entry);
    }
  });

  const newEntry = (partial: boolean): Entry => ({
    sources: new Map(),
    accumulator: new ActualsAccumulator(),
    running: true,
    partial,
  });

  const readingOf = (entry: Entry, diskBytes: number | null) =>
    entry.accumulator.reading({
      running: entry.running,
      partial: entry.partial,
      diskBytes,
      notMeasuredReason: BOARD_ACTUALS_NO_CGROUP_REASON,
    });

  const forgetOldFinished = () => {
    const finished = [...entries].filter(([, entry]) => !entry.running);
    for (const [key] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
      entries.delete(key);
    }
  };

  const relay: BoardActualsMeterShape["relay"] = Effect.fn("BoardActualsMeter.relay")(
    function* (input) {
      let entry = entries.get(input.key);
      if (entry === undefined) {
        if (input.op === "end" || input.threadId === undefined) return null;
        entry = newEntry(input.seen === true);
        entry.sources.set("thread", {
          kind: "thread",
          threadId: input.threadId,
          cgroup: null,
          resolved: 0,
          tries: 0,
        });
        entries.set(input.key, entry);
        yield* tickEntry(entry);
      }
      if (input.op === "read") return readingOf(entry, null);
      if (entry.running) {
        yield* tickEntry(entry);
        entry.running = false;
      }
      entries.delete(input.key);
      const diskBytes =
        input.worktreePath === undefined ? null : yield* machine.diskUsageBytes(input.worktreePath);
      return readingOf(entry, diskBytes);
    },
  );

  const tap = (key: string): BoardActualsTapShape => ({
    wrap: Effect.fn("BoardActualsMeter.wrap")(function* (command: string) {
      const launch = yield* agentScope.wrap({
        command: "/bin/sh",
        args: ["-c", command],
        name: key.startsWith("setup:") ? "board-setup" : "board-ci",
      });
      if (launch.unit === undefined) return null;
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = newEntry(false);
        entries.set(key, entry);
      }
      // A later segment of the same pass adds to it.
      entry.running = true;
      entry.sources.set(launch.unit, {
        kind: "unit",
        unit: launch.unit,
        cgroup: null,
        resolved: 0,
        tries: 0,
      });
      const wrapped = entry;
      yield* Effect.sleep(EARLY_SAMPLE_MS).pipe(
        Effect.andThen(Effect.suspend(() => (wrapped.running ? tickEntry(wrapped) : Effect.void))),
        Effect.forkDetach,
      );
      return { command: launch.command, args: launch.args };
    }),
  });

  const finish = Effect.fn("BoardActualsMeter.finish")(function* (key: string) {
    const entry = entries.get(key);
    if (entry === undefined || !entry.running) return;
    yield* tickEntry(entry);
    entry.running = false;
    forgetOldFinished();
  });

  return { relay, tap, finish, tick } satisfies BoardActualsMeterShape;
});

export const BoardActualsMeterLive = Layer.effect(
  BoardActualsMeter,
  Effect.gen(function* () {
    const meter = yield* makeBoardActualsMeter;
    yield* meter.tick.pipe(
      Effect.ignoreCause,
      Effect.repeat(Schedule.spaced(BOARD_ACTUALS_SAMPLE_INTERVAL_MS)),
      Effect.forkScoped,
    );
    return meter;
  }),
);
