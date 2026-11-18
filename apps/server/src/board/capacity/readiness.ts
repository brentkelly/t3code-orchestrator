// @effect-diagnostics nodeBuiltinImport:off - the committed script is written to a temp file to run.
/**
 * A project's readiness on this worker (T3O-86): its declarative checks (T3O-124), then the
 * readiness script as committed on the default branch when the board trusts the project; cached
 * per repository, path and configuration, shared by every board; one run at a time.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  boardReadinessConfigKey,
  normalizeBoardReadinessPath,
  type BoardReadinessCheck,
  type BoardWorkerCheckReadinessInput,
  type BoardWorkerReadiness,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { BoardCiTail, runBoardCiStep } from "../ci/BoardCiRunner.ts";
import { readLogTail } from "./logTail.ts";
import {
  formatReadinessChecks,
  runReadinessChecks,
  type ReadinessCheckHost,
  type ReadinessCheckResult,
} from "./readinessChecks.ts";

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
  /** Whether a path (file or folder) is on the default branch. */
  readonly has: (checkout: string, path: string) => Effect.Effect<boolean>;
}

interface Entry {
  readonly key: string;
  /** Stored so the hourly sweep re-runs what the board last asked for. */
  readonly checks: ReadonlyArray<BoardReadinessCheck>;
  readonly runScript: boolean;
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

/** A repository by its key; with no remote, the project is the repository. */
const repositoryIdentity = (repositoryKey: string | null, projectId: string | undefined) =>
  repositoryKey ?? `project:${projectId ?? ""}`;

const whose = (repositoryKey: string | null, projectId: string | undefined) => ({
  repositoryKey,
  ...(repositoryKey === null && projectId !== undefined ? { projectId } : {}),
});

export const makeReadiness = (deps: {
  readonly git: ReadinessGit;
  readonly host: ReadinessCheckHost;
  readonly runStep?: typeof runBoardCiStep;
}) => {
  const runStep = deps.runStep ?? runBoardCiStep;
  const entries = new Map<string, Entry>();
  /** Per board, the entry it last asked about for each repository: the path it uses now. */
  const asked = new Map<string, Map<string, string>>();
  const keyOf = (
    repositoryKey: string | null,
    projectId: string | undefined,
    path: string,
    configKey: string,
  ) => `${repositoryIdentity(repositoryKey, projectId)}\0${path}\0${configKey}`;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const entryFor = (input: BoardWorkerCheckReadinessInput) => {
    const configKey = boardReadinessConfigKey(input.checks, input.runScript);
    const key = keyOf(input.repositoryKey, input.projectId, input.path, configKey);
    const existing = entries.get(key);
    if (existing !== undefined) {
      existing.timeoutSeconds = input.timeoutSeconds;
      return existing;
    }
    const entry: Entry = {
      key,
      checks: input.checks,
      runScript: input.runScript,
      readiness: {
        ...whose(input.repositoryKey, input.projectId),
        path: input.path,
        state: "checking",
        version: null,
        checkedAt: null,
        configKey,
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
    const { repositoryKey, projectId, path, configKey } = entry.readiness;
    const base = {
      ...whose(repositoryKey, projectId),
      path,
      ...(configKey === undefined ? {} : { configKey }),
    };
    if (normalizeBoardReadinessPath(path) === null) {
      // Never read as "no script": that would count the worker ready.
      entry.readiness = {
        ...base,
        state: "not-ready",
        version: null,
        checkedAt: yield* nowIso,
        lastLine: "The readiness script's path must be relative and inside the repository.",
      };
      return entry.readiness;
    }
    const checkout = yield* deps.git.checkout(repositoryKey, projectId);
    if (checkout === null) {
      entry.readiness = { ...entry.readiness, state: "not-set-up" };
      return entry.readiness;
    }
    const fetched = yield* deps.git.fetch(checkout);
    const committed = yield* deps.git.committed(checkout, path);
    if (!fetched && before.checkedAt !== null) {
      // A failed fetch is not a result: the last one stands.
      entry.readiness = { ...before, fetchFailed: true };
      return entry.readiness;
    }
    const scriptBlob = entry.runScript ? committed : null;
    if (before.state === "ready" && scriptBlob !== null && before.version !== scriptBlob.version) {
      entry.readiness = { ...before, pendingVersion: scriptBlob.version };
    }
    // Every check and the script start in a folder made empty for the run, so nothing a repository
    // commits there (a version file, a package manager pin) picks the binary that answers.
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-ready-"));
    const emptyCwd = NodePath.join(dir, "cwd");
    NodeFS.mkdirSync(emptyCwd);
    const started = yield* Clock.currentTimeMillis;
    const run = Effect.gen(function* () {
      const checkResults: ReadonlyArray<ReadinessCheckResult> =
        entry.checks.length === 0
          ? []
          : yield* runReadinessChecks({
              checks: entry.checks,
              host: deps.host,
              cwd: emptyCwd,
              repo: {
                checkout,
                file: (file) =>
                  deps.git.committed(checkout, file).pipe(Effect.map((blob) => blob?.text ?? null)),
                has: (file) => deps.git.has(checkout, file),
              },
            });
      if (scriptBlob === null) return { checkResults, script: null };
      const scriptPath = NodePath.join(dir, NodePath.basename(path));
      NodeFS.writeFileSync(scriptPath, scriptBlob.text, { mode: 0o700 });
      const tail = new BoardCiTail(400);
      const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
      const logPath = NodePath.join(dir, "ready.log");
      const exit = yield* runStep({
        command: `T3O_READY_CHECKOUT=${quote(checkout)} sh ${quote(scriptPath)}`,
        cwd: checkout,
        timeoutMs: entry.timeoutSeconds * 1000,
        tail,
        logPath,
        resultPath: NodePath.join(dir, "ready.result.json"),
        ciEnvironment: false,
      });
      // The full output is the log's last 64 KB, read before the directory goes.
      return {
        checkResults,
        script: { exit, tail, full: readLogTail(logPath), version: scriptBlob.version },
      };
    });
    const { checkResults, script } = yield* run.pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
    const checkedAt = yield* nowIso;
    const durationMs = (yield* Clock.currentTimeMillis) - started;
    const failedCheck = checkResults.find((result) => result.status === "fail");
    const counted = (status: ReadinessCheckResult["status"]) =>
      checkResults.filter((result) => result.status === status).length;
    const scriptText = script === null ? "" : script.tail.text();
    const skipped = committed !== null && !entry.runScript;
    entry.output = [
      checkResults.length === 0 ? null : formatReadinessChecks(checkResults),
      skipped ? `Readiness script ${path} not run: not trusted for this project.` : null,
      script === null ? null : (script.full ?? scriptText),
    ]
      .filter((part) => part !== null && part !== "")
      .join("\n\n");
    const scriptPassed = script === null || script.exit.status === "passed";
    const passed = failedCheck === undefined && scriptPassed;
    const lastLine = (
      failedCheck !== undefined
        ? `${failedCheck.label}: ${failedCheck.detail}`
        : (scriptText.trimEnd().split("\n").at(-1) ?? "")
    ).slice(0, LAST_LINE_CHARS);
    entry.failures = passed ? 0 : entry.failures + 1;
    // A scheduled re-check turns a ready worker not-ready only after two failures in a row;
    // a first check, or one a human asked for, counts at once.
    const holdReady = !passed && !requested && before.state === "ready" && entry.failures < 2;
    entry.readiness = holdReady
      ? { ...before, checkedAt, pendingVersion: null }
      : {
          ...base,
          state: passed ? "ready" : "not-ready",
          version: script === null ? null : script.version,
          checkedAt,
          ...(script === null ? {} : { exitCode: script.exit.exitCode }),
          ...(script === null && failedCheck === undefined ? {} : { lastLine }),
          durationMs,
          ...(committed === null ? { noScript: true } : {}),
          ...(skipped ? { scriptSkipped: "not-trusted" as const } : {}),
          ...(checkResults.length === 0
            ? {}
            : {
                checks: {
                  passed: counted("pass"),
                  failed: counted("fail"),
                  warned: counted("warn"),
                },
              }),
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
        checks: entry.checks,
        runScript: entry.runScript,
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
    /** The output behind a reported result: its repository, path and configuration. */
    output: (readiness: BoardWorkerReadiness) =>
      entries.get(
        keyOf(
          readiness.repositoryKey,
          readiness.projectId,
          readiness.path,
          readiness.configKey ?? "",
        ),
      )?.output ?? null,
    /** The boards that asked about a project here. */
    boards: (): ReadonlyArray<string> => [...asked.keys()],
    forgetBoard: (boardId: string) => {
      for (const key of asked.get(boardId)?.values() ?? []) release(boardId, key);
      asked.delete(boardId);
    },
  };
};

export type Readiness = ReturnType<typeof makeReadiness>;
