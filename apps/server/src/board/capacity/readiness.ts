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
const READINESS_FAILING_INTERVAL_MS = 15 * 60_000;
const LAST_LINE_CHARS = 200;

/** Git reads of the project's checkout, so tests supply a repository of their own. */
export interface ReadinessGit {
  /** The checkout of a repository on this worker, or null when there is none. */
  readonly checkout: (
    repositoryKey: string | null,
    projectId: string | undefined,
  ) => Effect.Effect<string | null>;
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

/** A log file's last `BOARD_CAPACITY_LOG_MAX_BYTES`, or null when it can't be read. */
const readLogTail = (logPath: string): string | null => {
  try {
    const size = NodeFS.statSync(logPath).size;
    const length = Math.min(size, BOARD_CAPACITY_LOG_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = NodeFS.openSync(logPath, "r");
    try {
      NodeFS.readSync(fd, buffer, 0, length, size - length);
    } finally {
      NodeFS.closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  }
};

/** A repository by its key; with no remote, the project is the repository. */
export const repositoryIdentity = (repositoryKey: string | null, projectId: string | undefined) =>
  repositoryKey ?? `project:${projectId ?? ""}`;

const whose = (repositoryKey: string | null, projectId: string | undefined) => ({
  repositoryKey,
  ...(repositoryKey === null && projectId !== undefined ? { projectId } : {}),
});

export const makeReadiness = (deps: {
  readonly git: ReadinessGit;
  readonly runStep?: typeof runBoardCiStep;
}) => {
  const runStep = deps.runStep ?? runBoardCiStep;
  const entries = new Map<string, Entry>();
  /** Per board, the entry it last asked about for each repository: the path it uses now. */
  const asked = new Map<string, Map<string, string>>();
  const keyOf = (repositoryKey: string | null, projectId: string | undefined, path: string) =>
    `${repositoryIdentity(repositoryKey, projectId)}\0${path}`;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const entryFor = (input: BoardWorkerCheckReadinessInput) => {
    const key = keyOf(input.repositoryKey, input.projectId, input.path);
    const existing = entries.get(key);
    if (existing !== undefined) {
      existing.timeoutSeconds = input.timeoutSeconds;
      return existing;
    }
    const entry: Entry = {
      key,
      readiness: {
        ...whose(input.repositoryKey, input.projectId),
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

  /** A board's current entry for a repository, dropping its claim on a path it moved off. */
  const noteAsked = (boardId: string, entry: Entry) => {
    const byRepository = asked.get(boardId) ?? new Map<string, string>();
    const identity = repositoryIdentity(entry.readiness.repositoryKey, entry.readiness.projectId);
    const before = byRepository.get(identity);
    if (before !== undefined && before !== entry.key) release(boardId, before);
    byRepository.set(identity, entry.key);
    asked.set(boardId, byRepository);
    entry.boards.add(boardId);
  };

  /** No board holds an entry any more: it is forgotten, so it can block nothing. */
  const release = (boardId: string, key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entry.boards.delete(boardId);
    if (entry.boards.size === 0 && entry.inFlight === null) entries.delete(key);
  };

  const execute = Effect.fn("Readiness.execute")(function* (
    entry: Entry,
    requested: boolean,
    before: BoardWorkerReadiness,
  ) {
    const { repositoryKey, projectId, path } = entry.readiness;
    const checkout = yield* deps.git.checkout(repositoryKey, projectId);
    if (checkout === null) {
      entry.readiness = { ...entry.readiness, state: "not-set-up" };
      return entry.readiness;
    }
    const fetched = yield* deps.git.fetch(checkout);
    const committed = yield* deps.git.committed(checkout, path);
    const checkedAt = yield* nowIso;
    if (!fetched && before.checkedAt !== null) {
      // A failed fetch is not a result: the last one stands.
      entry.readiness = { ...before, fetchFailed: true };
      return entry.readiness;
    }
    if (committed === null) {
      // No script: a checkout counts as ready.
      entry.failures = 0;
      entry.readiness = {
        ...whose(repositoryKey, projectId),
        path,
        state: "ready",
        version: null,
        checkedAt,
        noScript: true,
        ...(fetched ? {} : { fetchFailed: true }),
      };
      return entry.readiness;
    }
    const previous = before;
    if (previous.state === "ready" && previous.version !== committed.version) {
      entry.readiness = { ...previous, pendingVersion: committed.version };
    }
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ready-"));
    const scriptPath = NodePath.join(dir, NodePath.basename(path));
    NodeFS.writeFileSync(scriptPath, committed.text, { mode: 0o700 });
    const tail = new BoardCiTail(400);
    const started = yield* Clock.currentTimeMillis;
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const logPath = NodePath.join(dir, "ready.log");
    const { exit, full } = yield* runStep({
      command: `T3O_READY_CHECKOUT=${quote(checkout)} sh ${quote(scriptPath)}`,
      cwd: checkout,
      timeoutMs: entry.timeoutSeconds * 1000,
      tail,
      logPath,
      resultPath: NodePath.join(dir, "ready.result.json"),
    }).pipe(
      // The full output is the log's last 64 KB, read before the directory goes.
      Effect.map((exit) => ({ exit, full: readLogTail(logPath) })),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
    const durationMs = (yield* Clock.currentTimeMillis) - started;
    const text = tail.text();
    entry.output = full ?? text;
    const lastLine = (text.trimEnd().split("\n").at(-1) ?? "").slice(0, LAST_LINE_CHARS);
    const passed = exit.status === "passed";
    entry.failures = passed ? 0 : entry.failures + 1;
    // A scheduled re-check turns a ready worker not-ready only after two failures in a row;
    // a first check, or one a human asked for, counts at once.
    const holdReady = !passed && !requested && previous.state === "ready" && entry.failures < 2;
    entry.readiness = holdReady
      ? { ...previous, checkedAt, pendingVersion: null }
      : {
          ...whose(repositoryKey, projectId),
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
    noteAsked(boardId, entry);
    if (entry.inFlight !== null) return yield* Deferred.await(entry.inFlight);
    const now = yield* Clock.currentTimeMillis;
    if (entry.lastRunAt !== null && now - entry.lastRunAt < REUSE_MS) return entry.readiness;
    const deferred = yield* Deferred.make<BoardWorkerReadiness>();
    entry.inFlight = deferred;
    const before = entry.readiness;
    if (before.checkedAt !== null && before.state !== "ready") {
      entry.readiness = { ...before, state: "checking" };
    }
    // Whatever ends the run (a result, a defect, the caller going away), every caller that
    // joined it gets an answer: an unfinished run leaves the last result standing.
    return yield* execute(entry, input.requested === true, before).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (exit._tag === "Failure") entry.readiness = before;
          entry.lastRunAt = yield* Clock.currentTimeMillis;
          entry.inFlight = null;
          yield* Deferred.succeed(deferred, entry.readiness);
        }),
      ),
    );
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
        ...whose(entry.readiness.repositoryKey, entry.readiness.projectId),
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
    /** Why the worker isn't ready for this board's project, at the path this board uses, or
        null. Another board's path for the same repository never counts. */
    notReady: (
      boardId: string,
      repositoryKey: string | null,
      projectId: string | undefined,
    ): string | null => {
      const key = asked.get(boardId)?.get(repositoryIdentity(repositoryKey, projectId));
      const state = key === undefined ? undefined : entries.get(key)?.readiness.state;
      return state === undefined || state === "ready" ? null : state;
    },
    output: (repositoryKey: string | null, projectId: string | undefined, path: string) =>
      entries.get(keyOf(repositoryKey, projectId, path))?.output ?? null,
    forgetBoard: (boardId: string) => {
      for (const key of asked.get(boardId)?.values() ?? []) release(boardId, key);
      asked.delete(boardId);
    },
  };
};

export type Readiness = ReturnType<typeof makeReadiness>;
