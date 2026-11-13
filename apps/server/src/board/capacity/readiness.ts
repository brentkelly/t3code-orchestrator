// @effect-diagnostics nodeBuiltinImport:off - the committed script is written to a temp file to run.
/**
 * A project's readiness on this worker (T3O-86): the readiness script as committed on the
 * default branch, cached per version and shared by every board; one run at a time.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BOARD_CAPACITY_LOG_MAX_BYTES,
  type BoardWorkerCheckReadinessInput,
  type BoardWorkerReadiness,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { BoardCiTail, runBoardCiStep } from "../ci/BoardCiRunner.ts";

/** A result asked for within this long of the last one is that one. */
const REUSE_MS = 30_000;
export const READINESS_PASSING_INTERVAL_MS = 60 * 60_000;
export const READINESS_FAILING_INTERVAL_MS = 15 * 60_000;
const LAST_LINE_CHARS = 200;

/** Git reads of the project's checkout, so tests supply a repository of their own. */
export interface ReadinessGit {
  /** The checkout of a repository on this worker, or null when there is none. */
  readonly checkout: (repositoryKey: string | null) => Effect.Effect<string | null>;
  /** Fetch the default branch; false when the fetch failed. True with no `origin`. */
  readonly fetch: (checkout: string) => Effect.Effect<boolean>;
  /** The script's blob id and text on the default branch, or null when it isn't there. */
  readonly committed: (
    checkout: string,
    path: string,
  ) => Effect.Effect<{ readonly version: string; readonly text: string } | null>;
}

interface Entry {
  readonly key: string;
  readiness: BoardWorkerReadiness;
  /** Consecutive scheduled failures, for the two-in-a-row rule. */
  failures: number;
  lastRunAt: number | null;
  output: string | null;
  inFlight: Deferred.Deferred<BoardWorkerReadiness> | null;
  timeoutSeconds: number;
  /** Boards that asked about this one, so a board sees only its own projects. */
  readonly boards: Set<string>;
}

export const makeReadiness = (deps: {
  readonly git: ReadinessGit;
  readonly runStep?: typeof runBoardCiStep;
}) => {
  const runStep = deps.runStep ?? runBoardCiStep;
  const entries = new Map<string, Entry>();
  const keyOf = (repositoryKey: string | null, path: string) => `${repositoryKey ?? ""}\0${path}`;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const entryFor = (input: BoardWorkerCheckReadinessInput) => {
    const key = keyOf(input.repositoryKey, input.path);
    const existing = entries.get(key);
    if (existing !== undefined) {
      existing.timeoutSeconds = input.timeoutSeconds;
      return existing;
    }
    const entry: Entry = {
      key,
      readiness: {
        repositoryKey: input.repositoryKey,
        path: input.path,
        state: "checking",
        version: null,
        checkedAt: null,
      },
      failures: 0,
      lastRunAt: null,
      output: null,
      inFlight: null,
      timeoutSeconds: input.timeoutSeconds,
      boards: new Set(),
    };
    entries.set(key, entry);
    return entry;
  };

  const execute = Effect.fn("Readiness.execute")(function* (entry: Entry, requested: boolean) {
    const { repositoryKey, path } = entry.readiness;
    const checkout = yield* deps.git.checkout(repositoryKey);
    if (checkout === null) {
      entry.readiness = { ...entry.readiness, state: "not-set-up" };
      return entry.readiness;
    }
    const fetched = yield* deps.git.fetch(checkout);
    const committed = yield* deps.git.committed(checkout, path);
    const checkedAt = yield* nowIso;
    if (!fetched && entry.readiness.checkedAt !== null) {
      // A failed fetch is not a result: the last one stands.
      entry.readiness = { ...entry.readiness, fetchFailed: true };
      return entry.readiness;
    }
    if (committed === null) {
      // No script: a checkout counts as ready.
      entry.failures = 0;
      entry.readiness = {
        repositoryKey,
        path,
        state: "ready",
        version: null,
        checkedAt,
        noScript: true,
        ...(fetched ? {} : { fetchFailed: true }),
      };
      return entry.readiness;
    }
    const previous = entry.readiness;
    if (previous.state === "ready" && previous.version !== committed.version) {
      entry.readiness = { ...previous, pendingVersion: committed.version };
    }
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ready-"));
    const scriptPath = NodePath.join(dir, NodePath.basename(path));
    NodeFS.writeFileSync(scriptPath, committed.text, { mode: 0o700 });
    const tail = new BoardCiTail(400);
    const started = yield* Clock.currentTimeMillis;
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const exit = yield* runStep({
      command: `T3O_READY_CHECKOUT=${quote(checkout)} sh ${quote(scriptPath)}`,
      cwd: checkout,
      timeoutMs: entry.timeoutSeconds * 1000,
      tail,
      logPath: NodePath.join(dir, "ready.log"),
      resultPath: NodePath.join(dir, "ready.result.json"),
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
    const durationMs = (yield* Clock.currentTimeMillis) - started;
    const text = tail.text();
    entry.output =
      text.length > BOARD_CAPACITY_LOG_MAX_BYTES ? text.slice(-BOARD_CAPACITY_LOG_MAX_BYTES) : text;
    const lastLine = (text.trimEnd().split("\n").at(-1) ?? "").slice(0, LAST_LINE_CHARS);
    const passed = exit.status === "passed";
    entry.failures = passed ? 0 : entry.failures + 1;
    // A scheduled re-check turns a ready worker not-ready only after two failures in a row;
    // a first check, or one a human asked for, counts at once.
    const holdReady = !passed && !requested && previous.state === "ready" && entry.failures < 2;
    entry.readiness = holdReady
      ? { ...previous, checkedAt, pendingVersion: null }
      : {
          repositoryKey,
          path,
          state: passed ? "ready" : "not-ready",
          version: committed.version,
          checkedAt,
          exitCode: exit.exitCode,
          lastLine,
          durationMs,
          ...(fetched ? {} : { fetchFailed: true }),
        };
    return entry.readiness;
  });

  /**
   * Check a project, joining a run in flight and answering with a result under 30 s old.
   * `boardId` records who asked, so each board's snapshot names only its own projects.
   */
  const check = Effect.fn("Readiness.check")(function* (
    boardId: string,
    input: BoardWorkerCheckReadinessInput,
  ) {
    const entry = entryFor(input);
    entry.boards.add(boardId);
    if (entry.inFlight !== null) return yield* Deferred.await(entry.inFlight);
    const now = yield* Clock.currentTimeMillis;
    if (entry.lastRunAt !== null && now - entry.lastRunAt < REUSE_MS) return entry.readiness;
    const deferred = yield* Deferred.make<BoardWorkerReadiness>();
    entry.inFlight = deferred;
    if (entry.readiness.checkedAt !== null && entry.readiness.state !== "ready") {
      entry.readiness = { ...entry.readiness, state: "checking" };
    }
    const result = yield* execute(entry, input.requested === true).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          entry.lastRunAt = yield* Clock.currentTimeMillis;
          entry.inFlight = null;
        }),
      ),
    );
    yield* Deferred.succeed(deferred, result);
    return result;
  });

  /** Re-check what is due: hourly when passing, every 15 minutes when failing. */
  const sweep = Effect.fn("Readiness.sweep")(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const entry of entries.values()) {
      const interval =
        entry.readiness.state === "ready"
          ? READINESS_PASSING_INTERVAL_MS
          : READINESS_FAILING_INTERVAL_MS;
      if (entry.lastRunAt !== null && now - entry.lastRunAt < interval) continue;
      const board = entry.boards.values().next().value;
      if (board === undefined) continue;
      yield* check(board, {
        repositoryKey: entry.readiness.repositoryKey,
        path: entry.readiness.path,
        timeoutSeconds: entry.timeoutSeconds,
      });
    }
  });

  return {
    check,
    sweep,
    /** Readiness for the projects one board asked about. */
    forBoard: (boardId: string): ReadonlyArray<BoardWorkerReadiness> =>
      [...entries.values()]
        .filter((entry) => entry.boards.has(boardId))
        .map((entry) => entry.readiness),
    /** Why the worker isn't ready for a repository, or null. Only what a board asked counts. */
    notReady: (repositoryKey: string | null): string | null => {
      const states = [...entries.values()].filter(
        (entry) => entry.readiness.repositoryKey === repositoryKey,
      );
      const blocking = states.find((entry) => entry.readiness.state !== "ready");
      return blocking === undefined ? null : blocking.readiness.state;
    },
    output: (repositoryKey: string | null, path: string) =>
      entries.get(keyOf(repositoryKey, path))?.output ?? null,
    forgetBoard: (boardId: string) => {
      for (const entry of entries.values()) entry.boards.delete(boardId);
    },
  };
};

export type Readiness = ReturnType<typeof makeReadiness>;
