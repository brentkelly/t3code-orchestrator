// @effect-diagnostics nodeBuiltinImport:off
// Remove scripts need a detached process group, and the /proc scan needs readlink.
/**
 * Every removal T3o starts is retired first: stop T3o's processes, then a reclaim with
 * survivors is `blocked` (forced kills them), then `runOnWorktreeRemove` scripts run (a card's
 * settle script first; a failure is only a `hookWarning`), then git removes it. Containers are
 * invisible to the process check, so stopping them is the scripts' job.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { CommandId, GitCommandError, type ProjectScript } from "@t3tools/contracts";
import { Platform as HostProcessPlatform } from "@t3tools/shared/HostProcess";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  settleProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { BoardTerminals } from "./ports/BoardTerminals.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { ThreadGateway, type BoardProject, type BoardWorktreeThread } from "./ThreadGateway.ts";

export type WorktreeRetireKind = "reclaim" | "forced";

export interface WorktreeRetireInput {
  readonly projectCwd: string;
  /** The project, when the caller knows it; otherwise it is found by `projectCwd`. */
  readonly projectId?: string | undefined;
  readonly worktreePath: string;
  readonly kind: WorktreeRetireKind;
  /** True only when the reclaim decision just proved the tree clean and its work durable. */
  readonly verifiedClean: boolean;
  /**
   * Asked before anything is stopped and again just before the removal. False
   * abandons the retirement (the result is null) and leaves the worktree. A
   * reclaim of a path already being retired is abandoned the same way.
   */
  readonly stillWanted?: Effect.Effect<boolean> | undefined;
  /** The removal itself. Defaults to `git worktree remove`, forced for `forced`. */
  readonly remove?: Effect.Effect<void, GitCommandError> | undefined;
  /** Runs once the checks have passed and remove scripts are about to start. */
  readonly onScriptsStarting?: Effect.Effect<void> | undefined;
  /**
   * Abandon (null) rather than wait when the path is already being retired.
   * Always the case for a reclaim; a forced caller that must not block, such
   * as the stock RPC, opts in.
   */
  readonly skipIfBusy?: boolean | undefined;
  /**
   * A card's worktree. Its threads skip `runOnSettle` while they share it, so the settle
   * script runs here once, before the remove scripts.
   */
  readonly cardWorktree?: boolean | undefined;
}

export type WorktreeRetireResult =
  | { readonly outcome: "removed"; readonly hookWarning: string | null }
  | { readonly outcome: "blocked"; readonly reason: string }
  | null;

export interface WorktreeProcess {
  readonly pid: number;
  readonly name: string;
}

export class WorktreeRetirer extends Context.Service<
  WorktreeRetirer,
  {
    readonly retire: (
      input: WorktreeRetireInput,
    ) => Effect.Effect<WorktreeRetireResult, GitCommandError>;
  }
>()("t3/board/worktreeRetire/WorktreeRetirer") {}

export interface WorktreeRetirerOptions {
  /** Processes whose working directory is inside the path. */
  readonly findProcessesInDirectory?: (
    path: string,
  ) => Effect.Effect<ReadonlyArray<WorktreeProcess>>;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void>;
  readonly hookTimeoutMs?: number;
  /** How long a SIGTERM gets before SIGKILL, on a forced removal. */
  readonly killGraceMs?: number;
  /** Closing a terminal kills its processes asynchronously: how often, and how
      many times, to look again before treating what is left as real. */
  readonly settleIntervalMs?: number;
  readonly settleAttempts?: number;
}

const HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const SETTLE_INTERVAL_MS = 500;
const SETTLE_ATTEMPTS = 6;

const pathExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  );

const isWithin = (child: string, root: string): boolean => {
  const relative = NodePath.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** The /proc reads the Linux finder makes, injectable so a test can refuse one. */
export interface ProcFs {
  readonly readdir: (path: string) => Promise<ReadonlyArray<string>>;
  readonly readlink: (path: string) => Promise<string>;
  readonly readFile: (path: string) => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
}

const nodeProcFs: ProcFs = {
  readdir: (path) => NodeFSP.readdir(path),
  readlink: (path) => NodeFSP.readlink(path),
  readFile: (path) => NodeFSP.readFile(path, "utf8"),
  realpath: (path) => NodeFSP.realpath(path),
};

/**
 * Linux: every process whose `/proc/<pid>/cwd` resolves inside `directory`. An
 * entry that cannot be read — another user's process, a container's, or one
 * that exited mid-scan — is skipped, not counted: it is not one we could stop.
 */
export const findProcessesInDirectoryLinux = async (
  directory: string,
  options: { readonly procFs?: ProcFs; readonly selfPid?: number } = {},
): Promise<ReadonlyArray<WorktreeProcess>> => {
  const procFs = options.procFs ?? nodeProcFs;
  const selfPid = options.selfPid ?? process.pid;
  const root = await procFs.realpath(directory).catch(() => directory);
  const entries = await procFs.readdir("/proc").catch(() => [] as ReadonlyArray<string>);
  const found: Array<WorktreeProcess> = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    const cwd = await procFs.readlink(`/proc/${entry}/cwd`).catch(() => null);
    if (cwd === null) continue;
    const resolved = await procFs.realpath(cwd).catch(() => cwd);
    if (!isWithin(resolved, root)) continue;
    const name = await procFs.readFile(`/proc/${entry}/comm`).catch(() => "");
    found.push({ pid, name: name.trim() || "process" });
  }
  return found;
};

/**
 * Parse `lsof -F pcf` output into the processes holding `cwd` or `txt` under
 * the directory. Fields arrive as one per line: `p<pid>`, `c<command>`, then
 * `f<fd>` for each open file.
 */
export const parseLsofProcesses = (
  output: string,
  selfPid: number = process.pid,
): ReadonlyArray<WorktreeProcess> => {
  const found = new Map<number, WorktreeProcess>();
  let pid: number | null = null;
  let name = "process";
  for (const line of output.split("\n")) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === "p") {
      pid = Number(value);
      name = "process";
    } else if (tag === "c") {
      name = value || "process";
    } else if (tag === "f" && pid !== null && pid !== selfPid && Number.isFinite(pid)) {
      if (value === "cwd" || value === "txt") found.set(pid, { pid, name });
    }
  }
  return [...found.values()];
};

const findProcessesInDirectoryMac = (directory: string): Promise<ReadonlyArray<WorktreeProcess>> =>
  new Promise((resolve) => {
    // lsof exits 1 when it finds nothing; only its output matters.
    const child = NodeChildProcess.spawn("lsof", ["-w", "-F", "pcf", "+D", directory], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => resolve([]));
    child.on("close", () => resolve(parseLsofProcesses(output)));
  });

/** The host's process finder. Windows refuses to delete open files on its own. */
const findProcessesInDirectory = Effect.fn("worktreeRetire.findProcessesInDirectory")(
  function* (directory: string) {
    const platform = yield* HostProcessPlatform;
    return yield* Effect.promise((): Promise<ReadonlyArray<WorktreeProcess>> =>
      platform === "linux"
        ? findProcessesInDirectoryLinux(directory)
        : platform === "darwin"
          ? findProcessesInDirectoryMac(directory)
          : Promise.resolve([]),
    );
  },
  Effect.orElseSucceed((): ReadonlyArray<WorktreeProcess> => []),
);

const signalProcessDefault = (pid: number, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone, or not ours to signal; the re-check reports what is left.
    }
  });

/**
 * `cargo and rustc are still running in the worktree`. Program names only, no
 * pids or counts: the reason is compared between sweeps, and a build's
 * changing set of rustc processes is not a new reason to report.
 */
export const survivorReason = (survivors: ReadonlyArray<WorktreeProcess>): string => {
  const names = [...new Set(survivors.map((survivor) => survivor.name))].sort();
  if (names.length === 0) return "A process is still running in the worktree";
  if (names.length === 1) return `${names[0]} is still running in the worktree`;
  const listed = names.length > 3 ? [...names.slice(0, 3), "others"] : names;
  return `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)} are still running in the worktree`;
};

export interface WorktreeHookRun {
  readonly script: Pick<ProjectScript, "name" | "command">;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}

export type WorktreeHookExit =
  | { readonly kind: "exited"; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: "timed-out" }
  | { readonly kind: "spawn-failed"; readonly message: string };

/**
 * Run one remove script as a plain child process in its own process group, so
 * a timeout can kill everything it started. Output goes to the server log one
 * line at a time, prefixed with the worktree path.
 */
const runWorktreeHook = Effect.fn("runWorktreeHook")(function* (run: WorktreeHookRun) {
  // Windows has no process groups to kill; there the shell alone is stopped.
  const detached = (yield* HostProcessPlatform) !== "win32";
  const lines = yield* Queue.unbounded<string, Cause.Done>();
  const logger = yield* Stream.fromQueue(lines).pipe(
    Stream.runForEach((line) => Effect.logInfo(`[${run.cwd}] ${line}`)),
    Effect.forkChild,
  );
  const exit = yield* Effect.callback<WorktreeHookExit>((resume) => {
    let child: ReturnType<typeof NodeChildProcess.spawn>;
    try {
      child = NodeChildProcess.spawn(run.script.command, {
        cwd: run.cwd,
        env: { ...process.env, ...run.env },
        shell: true,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resume(Effect.succeed({ kind: "spawn-failed", message: String(error) }));
      return;
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue;
      NodeReadline.createInterface({ input: stream }).on("line", (line) => {
        Queue.offerUnsafe(lines, line);
      });
    }
    child.on("error", (error) =>
      resume(Effect.succeed({ kind: "spawn-failed", message: error.message })),
    );
    child.on("exit", (code, signal) =>
      resume(Effect.succeed({ kind: "exited", code, signal: signal ?? null })),
    );
    // Interrupted — the timeout below — so the whole group goes.
    return Effect.sync(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(detached ? -child.pid : child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    });
  }).pipe(
    Effect.timeoutOption(run.timeoutMs),
    Effect.map((result) =>
      result._tag === "Some" ? result.value : ({ kind: "timed-out" } satisfies WorktreeHookExit),
    ),
  );
  yield* Queue.end(lines);
  // A grandchild that left the group can hold the pipes open; never wait on it.
  yield* Fiber.join(logger).pipe(Effect.timeoutOption(1_000), Effect.ignore);
  return exit;
});

const hookFailure = (name: string, exit: WorktreeHookExit, timeoutMs: number): string | null => {
  switch (exit.kind) {
    case "exited":
      if (exit.code === 0) return null;
      return exit.code === null
        ? `Remove script "${name}" was stopped by ${exit.signal ?? "a signal"}`
        : `Remove script "${name}" exited with code ${exit.code}`;
    case "timed-out": {
      const minutes = timeoutMs / 60_000;
      const limit =
        minutes >= 1 && Number.isInteger(minutes)
          ? `${minutes} minute${minutes === 1 ? "" : "s"}`
          : `${timeoutMs} ms`;
      return `Remove script "${name}" timed out after ${limit} and was stopped`;
    }
    case "spawn-failed":
      return `Remove script "${name}" could not start: ${exit.message}`;
  }
};

/** The project's remove scripts, in stored order, after a card's settle script. */
const worktreeRemoveScripts = (
  scripts: ReadonlyArray<ProjectScript>,
  cardWorktree: boolean,
): ReadonlyArray<ProjectScript> => {
  const remove = scripts.filter((script) => script.runOnWorktreeRemove === true);
  const settle = cardWorktree ? settleProjectScript(scripts) : null;
  return settle === null || remove.includes(settle) ? remove : [settle, ...remove];
};

export const makeWorktreeRetirer = Effect.fn("worktreeRetire.makeWorktreeRetirer")(function* (
  options: WorktreeRetirerOptions = {},
) {
  const terminals = yield* BoardTerminals;
  const threads = yield* ThreadGateway;
  const serverSettings = yield* ServerSettingsService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const findProcesses = options.findProcessesInDirectory ?? findProcessesInDirectory;
  const signalProcess = options.signalProcess ?? signalProcessDefault;
  const hookTimeoutMs = options.hookTimeoutMs ?? HOOK_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const settleIntervalMs = options.settleIntervalMs ?? SETTLE_INTERVAL_MS;
  const settleAttempts = options.settleAttempts ?? SETTLE_ATTEMPTS;

  const samePath = (left: string, right: string) =>
    NodePath.resolve(left) === NodePath.resolve(right);

  /** Survivors once the asynchronous kills have had a moment to land. */
  const settledSurvivors = Effect.fn("worktreeRetire.settledSurvivors")(function* (path: string) {
    let survivors = yield* findProcesses(path);
    for (let attempt = 1; attempt < settleAttempts && survivors.length > 0; attempt += 1) {
      yield* Effect.sleep(settleIntervalMs);
      survivors = yield* findProcesses(path);
    }
    return survivors;
  });

  const stopOwnProcesses = Effect.fn("worktreeRetire.stopOwnProcesses")(function* (
    inWorktree: ReadonlyArray<BoardWorktreeThread>,
  ) {
    for (const thread of inWorktree) {
      yield* terminals.close({ threadId: thread.threadId, deleteHistory: false }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree retire: closing a thread's terminals failed", {
            threadId: thread.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      // A deleted thread's session is stopped by its deletion.
      if (thread.deleted || !thread.sessionLive) continue;
      yield* threads
        .stopSession({
          commandId: CommandId.make(`server:worktree-retire-stop:${NodeCrypto.randomUUID()}`),
          threadId: thread.threadId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("worktree retire: stopping a thread's session failed", {
              threadId: thread.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    }
  });

  const killSurvivors = Effect.fn("worktreeRetire.killSurvivors")(function* (
    worktreePath: string,
    survivors: ReadonlyArray<WorktreeProcess>,
  ) {
    yield* Effect.logWarning("worktree retire: stopping processes left in the worktree", {
      worktreePath,
      processes: survivors.map((survivor) => `${survivor.name} (${survivor.pid})`),
    });
    for (const survivor of survivors) yield* signalProcess(survivor.pid, "SIGTERM");
    yield* Effect.sleep(killGraceMs);
    const stubborn = yield* findProcesses(worktreePath);
    if (stubborn.length === 0) return;
    for (const survivor of stubborn) yield* signalProcess(survivor.pid, "SIGKILL");
    const left = yield* settledSurvivors(worktreePath);
    if (left.length > 0) {
      yield* Effect.logWarning("worktree retire: processes survived SIGKILL; removing anyway", {
        worktreePath,
        reason: survivorReason(left),
      });
    }
  });

  const runHooks = Effect.fn("worktreeRetire.runHooks")(function* (
    projects: ReadonlyArray<BoardProject>,
    input: WorktreeRetireInput,
  ) {
    const project =
      projects.find(
        (candidate) =>
          !candidate.deleted &&
          (input.projectId !== undefined
            ? candidate.id === input.projectId
            : samePath(candidate.workspaceRoot, input.projectCwd)),
      ) ?? null;
    if (project === null) return null;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("worktree retire: settings unreadable; no remove scripts run", {
          worktreePath: input.worktreePath,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );
    if (settings === null) return null;
    const scripts = worktreeRemoveScripts(
      resolveProjectScripts(settings, project),
      input.cardWorktree === true,
    );
    if (scripts.length === 0) return null;
    if (input.onScriptsStarting !== undefined) yield* input.onScriptsStarting;
    const env = {
      ...projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: input.worktreePath,
      }),
      T3_WORKTREE_PATH: input.worktreePath,
      T3_PROJECT_ROOT: project.workspaceRoot,
      T3_REMOVAL: input.kind,
      T3_WORKTREE_VERIFIED_CLEAN: input.verifiedClean ? "1" : "0",
    };
    const failures: Array<string> = [];
    for (const script of scripts) {
      yield* Effect.logInfo("worktree retire: running remove script", {
        worktreePath: input.worktreePath,
        script: script.name,
      });
      const exit = yield* runWorktreeHook({
        script,
        cwd: input.worktreePath,
        env,
        timeoutMs: hookTimeoutMs,
      });
      const failure = hookFailure(script.name, exit, hookTimeoutMs);
      if (failure === null) continue;
      yield* Effect.logWarning("worktree retire: remove script failed; removing anyway", {
        worktreePath: input.worktreePath,
        failure,
      });
      failures.push(failure);
    }
    return failures.length === 0 ? null : failures.join("; ");
  });

  const retireOnce = Effect.fn("worktreeRetire.retireOnce")(function* (input: WorktreeRetireInput) {
    const stillWanted = input.stillWanted ?? Effect.succeed(true);
    // Before anything is stopped, too: a card restarted since the caller
    // decided owns live sessions in this checkout.
    if (!(yield* stillWanted)) return null;
    const unreadable = (cause: Cause.Cause<unknown>) =>
      Effect.logWarning("worktree retire: threads and projects unreadable", {
        worktreePath: input.worktreePath,
        cause: Cause.pretty(cause),
      });
    const inWorktree = yield* threads
      .threadsInWorktree(input.worktreePath)
      .pipe(Effect.catchCause((cause) => unreadable(cause).pipe(Effect.as([]))));
    const projects = yield* threads
      .projects()
      .pipe(Effect.catchCause((cause) => unreadable(cause).pipe(Effect.as([]))));
    yield* stopOwnProcesses(inWorktree);
    const survivors = yield* settledSurvivors(input.worktreePath);
    if (survivors.length > 0) {
      if (input.kind === "reclaim") {
        return { outcome: "blocked", reason: survivorReason(survivors) } as const;
      }
      yield* killSurvivors(input.worktreePath, survivors);
    }
    const hookWarning = yield* runHooks(projects, input);
    // Stopping and the scripts take long enough for a person to drag the
    // card back out of Done. Its caches may have moved out; that only costs
    // a rebuild.
    if (!(yield* stillWanted)) return null;
    yield* (
      input.remove ??
        git.removeWorktree({
          cwd: input.projectCwd,
          path: input.worktreePath,
          ...(input.kind === "forced" ? { force: true } : {}),
        })
    );
    return { outcome: "removed", hookWarning } as const;
  });

  // Paths being retired, each with a latch. The remove scripts must never run twice at once:
  // a second reclaim is abandoned (null), a second forced removal waits its turn, and finding
  // the folder gone afterwards means the first one removed it.
  const retiring = new Map<string, Deferred.Deferred<void>>();

  const retire: (
    input: WorktreeRetireInput,
  ) => Effect.Effect<WorktreeRetireResult, GitCommandError> = Effect.fn("worktreeRetire.retire")(
    function* (input) {
      const key = NodePath.resolve(input.worktreePath);
      let waited = false;
      while (true) {
        // Checked and claimed in one step, so two callers never both win.
        const claim = yield* Effect.sync(() => {
          const busy = retiring.get(key);
          if (busy !== undefined) return { busy } as const;
          const done = Deferred.makeUnsafe<void>();
          retiring.set(key, done);
          return { done } as const;
        });
        if ("done" in claim) {
          const release = Effect.sync(() => retiring.delete(key)).pipe(
            Effect.andThen(Deferred.succeed(claim.done, undefined)),
          );
          const gone = waited ? pathExists(key).pipe(Effect.map((exists) => !exists)) : null;
          return yield* (gone === null ? Effect.succeed(false) : gone).pipe(
            Effect.flatMap(
              (removedMeanwhile): Effect.Effect<WorktreeRetireResult, GitCommandError> =>
                removedMeanwhile
                  ? Effect.succeed({ outcome: "removed", hookWarning: null })
                  : retireOnce(input),
            ),
            Effect.ensuring(release),
          );
        }
        if (input.kind === "reclaim" || input.skipIfBusy === true) {
          yield* Effect.logInfo("worktree retire: already being retired; skipped", {
            worktreePath: input.worktreePath,
          });
          return null;
        }
        yield* Effect.logInfo("worktree retire: already being retired; waiting", {
          worktreePath: input.worktreePath,
        });
        yield* Deferred.await(claim.busy);
        waited = true;
      }
    },
  );

  return WorktreeRetirer.of({ retire });
});

/**
 * The stock thread-delete removal, retired first. `force` picks the kind; a busy path fails
 * it either way, so the client's VCS queue never waits on a board cleanup. With remove
 * scripts it returns once they start and finishes in the background; later failures reach
 * only the server log, and `afterRemoval` refreshes git status.
 */
export const retireRemovedThreadWorktree = Effect.fn("worktreeRetire.retireRemovedThreadWorktree")(
  function* (
    retirer: WorktreeRetirer["Service"],
    input: { readonly cwd: string; readonly path: string; readonly force?: boolean | undefined },
    remove: Effect.Effect<void, GitCommandError>,
    afterRemoval: Effect.Effect<void>,
  ) {
    const scriptsStarted = yield* Deferred.make<void>();
    const retirement = yield* retirer
      .retire({
        projectCwd: input.cwd,
        worktreePath: input.path,
        kind: input.force === true ? "forced" : "reclaim",
        verifiedClean: false,
        skipIfBusy: true,
        remove,
        onScriptsStarting: Deferred.succeed(scriptsStarted, undefined).pipe(Effect.asVoid),
      })
      .pipe(
        Effect.flatMap((result) =>
          result === null || result.outcome === "blocked"
            ? Effect.fail(
                new GitCommandError({
                  operation: "WorktreeRetirer.retire",
                  command: "git worktree remove",
                  cwd: input.cwd,
                  // Null: a board cleanup is retiring this worktree right now.
                  detail: result?.reason ?? "The worktree is already being removed.",
                }),
              )
            : Effect.void,
        ),
        Effect.tapCause((cause) =>
          Deferred.isDone(scriptsStarted).pipe(
            Effect.flatMap((inBackground) =>
              inBackground
                ? Effect.logWarning("worktree retire: background removal failed", {
                    worktreePath: input.path,
                    cause: Cause.pretty(cause),
                  })
                : Effect.void,
            ),
          ),
        ),
        Effect.ensuring(afterRemoval),
        Effect.forkDetach,
      );
    yield* Effect.raceFirst(Fiber.join(retirement), Deferred.await(scriptsStarted));
  },
);

export const WorktreeRetirerLive = Layer.effect(WorktreeRetirer, makeWorktreeRetirer());
