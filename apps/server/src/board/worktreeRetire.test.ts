// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3o (T3O-23): retiring a worktree — stop its processes, run its remove
 * scripts, then remove it.
 *
 * The retirer is the real one; terminals, sessions, the read model, settings
 * and git are doubles (see `worktreeRetire.testkit.ts`). Remove scripts run as
 * real child processes in a real temporary worktree folder.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { GitCommandError, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  findProcessesInDirectoryLinux,
  parseLsofProcesses,
  retireRemovedThreadWorktree,
  survivorReason,
  WorktreeRetirer,
  type ProcFs,
  type WorktreeProcess,
  type WorktreeRetireInput,
  type WorktreeRetirerOptions,
} from "./worktreeRetire.ts";
import {
  worktreeRetirerTestLayer,
  type WorktreeRetirerTestThread,
} from "./worktreeRetire.testkit.ts";
import type { BoardProject } from "./ThreadGateway.ts";

const projectId = ProjectId.make("project-1");

const project = (workspaceRoot: string, scripts: ReadonlyArray<ProjectScript>): BoardProject => ({
  id: projectId,
  title: "Project 1",
  workspaceRoot,
  deleted: false,
  scripts,
});

const makeDirs = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-retire-test-"));
  const projectCwd = NodePath.join(root, "repo");
  const worktreePath = NodePath.join(root, "worktree");
  NodeFS.mkdirSync(projectCwd);
  NodeFS.mkdirSync(worktreePath);
  return { root, projectCwd, worktreePath };
};

const script = (
  id: string,
  command: string,
  flags: Partial<Pick<ProjectScript, "runOnWorktreeCreate" | "runOnWorktreeRemove">> = {},
): ProjectScript => ({
  id,
  name: id,
  command,
  icon: "play",
  runOnWorktreeCreate: flags.runOnWorktreeCreate ?? false,
  ...(flags.runOnWorktreeRemove === undefined
    ? {}
    : { runOnWorktreeRemove: flags.runOnWorktreeRemove }),
});

const thread = (
  id: string,
  worktreePath: string | null,
  session: "running" | "stopped" | null,
  deletedAt: string | null = null,
): WorktreeRetirerTestThread => ({
  threadId: id,
  worktreePath,
  deleted: deletedAt !== null,
  sessionLive: session === "running",
});

interface Fixture {
  readonly scripts?: ReadonlyArray<ProjectScript>;
  readonly threads?: ReadonlyArray<ReturnType<typeof thread>>;
  readonly survivors?: ReadonlyArray<ReadonlyArray<WorktreeProcess>>;
  readonly options?: WorktreeRetirerOptions;
}

/** Run `body` with a retirer over a fresh pair of folders, returning what happened. */
const withRetirer = <A, E>(
  fixture: Fixture,
  body: (
    retirer: WorktreeRetirer["Service"],
    dirs: ReturnType<typeof makeDirs>,
    events: ReadonlyArray<string>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const dirs = makeDirs();
    const events: Array<string> = [];
    const git = {
      removeWorktree: (request: { readonly path: string; readonly force?: boolean }) =>
        Effect.sync(() => {
          events.push(`remove:${request.force === true ? "force" : "plain"}`);
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const layer = worktreeRetirerTestLayer({
      threads: () => fixture.threads ?? [],
      projects: () => [project(dirs.projectCwd, fixture.scripts ?? [])],
      events,
      ...(fixture.survivors === undefined ? {} : { survivors: fixture.survivors }),
      ...(fixture.options === undefined ? {} : { options: fixture.options }),
    }).pipe(Layer.provide(Layer.succeed(GitVcsDriver.GitVcsDriver, git)));
    const result = yield* Effect.gen(function* () {
      return yield* body(yield* WorktreeRetirer, dirs, events);
    }).pipe(Effect.provide(layer));
    const read = (name: string) => {
      const path = NodePath.join(dirs.root, name);
      return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : null;
    };
    return { result, events, dirs, read };
  });

/** Retire once against a fresh pair of folders, returning what happened. */
const retireWith = (
  fixture: Fixture,
  input: (
    dirs: ReturnType<typeof makeDirs>,
  ) => Omit<WorktreeRetireInput, "projectCwd" | "worktreePath">,
) =>
  withRetirer(fixture, (retirer, dirs) =>
    retirer.retire({
      projectCwd: dirs.projectCwd,
      worktreePath: dirs.worktreePath,
      ...input(dirs),
    }),
  );

const reclaim = { kind: "reclaim", verifiedClean: true } as const;
const forced = { kind: "forced", verifiedClean: false } as const;

/** Start a forced retirement and park it just before its remove scripts run. */
const parkedRetirement = (
  retirer: WorktreeRetirer["Service"],
  dirs: ReturnType<typeof makeDirs>,
  events: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const fiber = yield* retirer
      .retire({
        projectCwd: dirs.projectCwd,
        worktreePath: dirs.worktreePath,
        ...forced,
        onScriptsStarting: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
        // Removes the folder for real, as git would.
        remove: Effect.sync(() => {
          NodeFS.rmSync(dirs.worktreePath, { recursive: true, force: true });
          (events as Array<string>).push("remove:first");
        }),
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    return { fiber, release: Deferred.succeed(gate, undefined) };
  });

const teardownOnce = {
  scripts: [script("teardown", "echo ran >> ../hook.log", { runOnWorktreeRemove: true })],
};

describe("retireWorktree", () => {
  it.effect("runs the steps in order: stop, check, hook, remove", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const dirs = makeDirs();
      const marker = NodePath.join(dirs.root, "hook.log");
      const git = {
        removeWorktree: () =>
          Effect.sync(() => {
            events.push(NodeFS.existsSync(marker) ? "remove-after-hook" : "remove-before-hook");
          }),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"];
      const layer = worktreeRetirerTestLayer({
        events,
        threads: () => [
          thread("thread-live", dirs.worktreePath, "running"),
          thread("thread-stopped", dirs.worktreePath, "stopped"),
          thread("thread-deleted", dirs.worktreePath, "running", "2026-01-01T00:00:00.000Z"),
          thread("thread-elsewhere", "/somewhere/else", "running"),
        ],
        projects: () => [
          project(dirs.projectCwd, [
            script("park", `echo hook >> "${marker}"`, { runOnWorktreeRemove: true }),
          ]),
        ],
      }).pipe(Layer.provide(Layer.succeed(GitVcsDriver.GitVcsDriver, git)));
      const result = yield* Effect.gen(function* () {
        const retirer = yield* WorktreeRetirer;
        return yield* retirer.retire({
          projectCwd: dirs.projectCwd,
          worktreePath: dirs.worktreePath,
          ...reclaim,
        });
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(result, { outcome: "removed", hookWarning: null });
      assert.deepStrictEqual(events, [
        "close-terminals:thread-live",
        "stop-session:thread-live",
        "close-terminals:thread-stopped",
        "close-terminals:thread-deleted",
        "check-processes",
        "remove-after-hook",
      ]);
    }),
  );

  it.effect("holds a reclaim back while something still runs there, naming it", () =>
    Effect.gen(function* () {
      const { result, events, read } = yield* retireWith(
        {
          survivors: [
            [
              { pid: 4412, name: "cargo" },
              { pid: 4413, name: "rustc" },
              { pid: 4414, name: "rustc" },
            ],
          ],
          scripts: [script("park", "echo ran > ../hook.log", { runOnWorktreeRemove: true })],
        },
        () => reclaim,
      );
      assert.deepStrictEqual(result, {
        outcome: "blocked",
        reason: "cargo and rustc are still running in the worktree",
      });
      assert.isFalse(events.some((event) => event.startsWith("remove")));
      assert.isFalse(events.some((event) => event.startsWith("SIG")));
      assert.isNull(read("hook.log"), "the hook must not run while something writes there");
    }),
  );

  it.effect("waits for closed terminals' processes to exit before calling them survivors", () =>
    Effect.gen(function* () {
      const { result, events } = yield* retireWith(
        {
          survivors: [[{ pid: 7, name: "vite" }], []],
          options: { settleAttempts: 3, settleIntervalMs: 0 },
        },
        () => reclaim,
      );
      assert.deepStrictEqual(result, { outcome: "removed", hookWarning: null });
      assert.deepStrictEqual(events, ["check-processes", "check-processes", "remove:plain"]);
    }),
  );

  it.effect("kills survivors of a forced removal, TERM then KILL, and removes", () =>
    Effect.gen(function* () {
      const survivor = { pid: 4412, name: "cargo" };
      const { result, events } = yield* retireWith(
        { survivors: [[survivor], [survivor], []] },
        () => forced,
      );
      assert.deepStrictEqual(result, { outcome: "removed", hookWarning: null });
      assert.deepStrictEqual(events, [
        "check-processes",
        "SIGTERM:4412",
        "check-processes",
        "SIGKILL:4412",
        "check-processes",
        "remove:force",
      ]);
    }),
  );

  it.effect("a survivor that exits on SIGTERM gets no SIGKILL", () =>
    Effect.gen(function* () {
      const { events } = yield* retireWith(
        { survivors: [[{ pid: 9, name: "node" }], []] },
        () => forced,
      );
      assert.deepStrictEqual(events, [
        "check-processes",
        "SIGTERM:9",
        "check-processes",
        "remove:force",
      ]);
    }),
  );

  it.effect("runs the hook in the worktree with the documented environment", () =>
    Effect.gen(function* () {
      const command =
        'pwd -P > ../cwd.txt; printf "%s\\n%s\\n%s\\n%s\\n%s\\n" "$T3_WORKTREE_PATH" "$T3_PROJECT_ROOT" "$T3_REMOVAL" "$T3_WORKTREE_VERIFIED_CLEAN" "$T3CODE_WORKTREE_PATH" > ../env.txt';
      const scripts = [script("env", command, { runOnWorktreeRemove: true })];

      const reclaimed = yield* retireWith({ scripts }, () => reclaim);
      assert.strictEqual(
        reclaimed.read("cwd.txt")?.trim(),
        NodeFS.realpathSync(reclaimed.dirs.worktreePath),
      );
      assert.deepStrictEqual(reclaimed.read("env.txt")?.trimEnd().split("\n"), [
        reclaimed.dirs.worktreePath,
        reclaimed.dirs.projectCwd,
        "reclaim",
        "1",
        reclaimed.dirs.worktreePath,
      ]);

      const removed = yield* retireWith({ scripts }, () => forced);
      assert.deepStrictEqual(removed.read("env.txt")?.trimEnd().split("\n").slice(2, 4), [
        "forced",
        "0",
      ]);
    }),
  );

  it.effect("runs every remove script in stored order, and no other script", () =>
    Effect.gen(function* () {
      const { read } = yield* retireWith(
        {
          scripts: [
            script("dev", "echo dev >> ../order.log"),
            script("first", "echo first >> ../order.log", { runOnWorktreeRemove: true }),
            script("setup", "echo setup >> ../order.log", { runOnWorktreeCreate: true }),
            script("second", "echo second >> ../order.log", { runOnWorktreeRemove: true }),
          ],
        },
        () => reclaim,
      );
      assert.strictEqual(read("order.log"), "first\nsecond\n");
    }),
  );

  it.effect("a failing hook still removes the worktree and reports the failure", () =>
    Effect.gen(function* () {
      const { result, events, read } = yield* retireWith(
        {
          scripts: [
            script("broken", "exit 3", { runOnWorktreeRemove: true }),
            script("after", "echo after > ../after.log", { runOnWorktreeRemove: true }),
          ],
        },
        () => reclaim,
      );
      assert.deepStrictEqual(result, {
        outcome: "removed",
        hookWarning: 'Remove script "broken" exited with code 3',
      });
      assert.include(events, "remove:plain");
      assert.strictEqual(read("after.log"), "after\n", "a failure does not skip later scripts");
    }),
  );

  // Live: the timeout is a real one, and it.effect would run it on a test clock.
  it.live("a hanging hook is killed with its process group at the timeout", () =>
    Effect.gen(function* () {
      const { result, events, read } = yield* retireWith(
        {
          scripts: [
            script("hang", "sleep 30 & echo $! > ../child.pid; wait", {
              runOnWorktreeRemove: true,
            }),
          ],
          options: { hookTimeoutMs: 300 },
        },
        () => reclaim,
      );
      assert.deepStrictEqual(result, {
        outcome: "removed",
        hookWarning: 'Remove script "hang" timed out after 300 ms and was stopped',
      });
      assert.include(events, "remove:plain");
      const childPid = Number(read("child.pid")?.trim());
      assert.isTrue(Number.isInteger(childPid) && childPid > 0);
      // The group was SIGKILLed; the signal is delivered before kill() returns,
      // and reaping can lag, so a zombie (state Z) also counts as dead.
      const alive = (() => {
        try {
          process.kill(childPid, 0);
        } catch {
          return false;
        }
        const stat = NodeFS.existsSync(`/proc/${childPid}/stat`)
          ? NodeFS.readFileSync(`/proc/${childPid}/stat`, "utf8")
          : "";
        return !/\) Z /.test(stat);
      })();
      if ((yield* HostProcessPlatform) === "linux") {
        assert.isFalse(alive, "the hook's child was not killed");
      }
    }),
  );

  it.effect("a card wanted again while the hook runs keeps its worktree", () =>
    Effect.gen(function* () {
      let asked = 0;
      const { result, events, read } = yield* retireWith(
        { scripts: [script("park", "echo ran > ../hook.log", { runOnWorktreeRemove: true })] },
        () => ({
          ...reclaim,
          // Wanted when the retirement starts; not by the time the hook is done.
          stillWanted: Effect.sync(() => {
            asked += 1;
            return asked === 1;
          }),
        }),
      );
      assert.isNull(result);
      assert.strictEqual(read("hook.log"), "ran\n");
      assert.isFalse(events.some((event) => event.startsWith("remove")));
    }),
  );

  it.effect("a card wanted again before it starts is left untouched", () =>
    Effect.gen(function* () {
      const { result, events } = yield* retireWith(
        { threads: [thread("thread-live", null, "running")] },
        () => ({ ...reclaim, stillWanted: Effect.succeed(false) }),
      );
      assert.isNull(result);
      assert.deepStrictEqual(events, []);
    }),
  );

  it.effect("with no remove script configured it only stops, checks and removes", () =>
    Effect.gen(function* () {
      const { result, events } = yield* retireWith(
        { scripts: [script("dev", "echo dev > ../dev.log")] },
        () => forced,
      );
      assert.deepStrictEqual(result, { outcome: "removed", hookWarning: null });
      assert.deepStrictEqual(events, ["check-processes", "remove:force"]);
    }),
  );

  it.effect("a reclaim of a path already being retired is skipped", () =>
    Effect.gen(function* () {
      const { result, events, read } = yield* withRetirer(teardownOnce, (retirer, dirs, events) =>
        Effect.gen(function* () {
          const first = yield* parkedRetirement(retirer, dirs, events);
          const second = yield* retirer.retire({
            projectCwd: dirs.projectCwd,
            worktreePath: NodePath.join(dirs.worktreePath, "."),
            ...reclaim,
          });
          yield* first.release;
          return { first: yield* Fiber.join(first.fiber), second };
        }),
      );
      assert.isNull(result.second);
      assert.deepStrictEqual(result.first, { outcome: "removed", hookWarning: null });
      assert.strictEqual(read("hook.log"), "ran\n");
      assert.deepStrictEqual(
        events.filter((event) => event.startsWith("remove")),
        ["remove:first"],
      );
    }),
  );

  it.effect("a forced removal of a path already being retired waits for it, not skips it", () =>
    Effect.gen(function* () {
      const { result, events, read } = yield* withRetirer(teardownOnce, (retirer, dirs, events) =>
        Effect.gen(function* () {
          const first = yield* parkedRetirement(retirer, dirs, events);
          const second = yield* retirer
            .retire({
              projectCwd: dirs.projectCwd,
              worktreePath: NodePath.join(dirs.worktreePath, "."),
              ...forced,
            })
            .pipe(
              Effect.tap(() => Effect.sync(() => (events as Array<string>).push("second-done"))),
              Effect.forkChild,
            );
          yield* first.release;
          return { first: yield* Fiber.join(first.fiber), second: yield* Fiber.join(second) };
        }),
      );
      // A real removal, reported only once the first one has made it.
      assert.deepStrictEqual(result.second, { outcome: "removed", hookWarning: null });
      assert.deepStrictEqual(result.first, { outcome: "removed", hookWarning: null });
      assert.strictEqual(read("hook.log"), "ran\n", "the scripts must not run twice");
      assert.deepStrictEqual(
        events.filter((event) => event.startsWith("remove") || event === "second-done"),
        ["remove:first", "second-done"],
      );
    }),
  );

  it.effect("a forced removal still runs after the retirement it waited for left the folder", () =>
    Effect.gen(function* () {
      const { result, events } = yield* withRetirer({}, (retirer, dirs) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const started = yield* Deferred.make<void>();
          // A reclaim abandoned at its first stillWanted: it leaves the worktree.
          const first = yield* retirer
            .retire({
              projectCwd: dirs.projectCwd,
              worktreePath: dirs.worktreePath,
              ...reclaim,
              stillWanted: Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as(false),
              ),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const second = yield* retirer
            .retire({ projectCwd: dirs.projectCwd, worktreePath: dirs.worktreePath, ...forced })
            .pipe(Effect.forkChild);
          yield* Deferred.succeed(gate, undefined);
          return { first: yield* Fiber.join(first), second: yield* Fiber.join(second) };
        }),
      );
      assert.isNull(result.first);
      assert.deepStrictEqual(result.second, { outcome: "removed", hookWarning: null });
      assert.deepStrictEqual(events, ["check-processes", "remove:force"]);
    }),
  );

  it.effect("uses the caller's removal when one is given", () =>
    Effect.gen(function* () {
      let called = false;
      const { result, events } = yield* retireWith({}, () => ({
        ...forced,
        remove: Effect.sync(() => {
          called = true;
        }),
      }));
      assert.deepStrictEqual(result, { outcome: "removed", hookWarning: null });
      assert.isTrue(called);
      assert.isFalse(events.some((event) => event.startsWith("remove")));
    }),
  );
});

describe("retireRemovedThreadWorktree (the stock vcsRemoveWorktree)", () => {
  const stockRemove = (events: ReadonlyArray<string>) =>
    Effect.sync(() => void (events as Array<string>).push("stock-remove"));

  it.effect("force:false fails on a process still running, and removes nothing", () =>
    Effect.gen(function* () {
      const { result, events } = yield* withRetirer(
        { survivors: [[{ pid: 4412, name: "cargo" }]] },
        (retirer, dirs, events) =>
          retireRemovedThreadWorktree(
            retirer,
            { cwd: dirs.projectCwd, path: dirs.worktreePath, force: false },
            stockRemove(events),
            Effect.void,
          ).pipe(Effect.flip),
      );
      assert.instanceOf(result, GitCommandError);
      assert.include(result.detail, "cargo is still running in the worktree");
      assert.deepStrictEqual(events, ["check-processes"]);
    }),
  );

  it.effect("force:false fails while a board cleanup is retiring the same worktree", () =>
    Effect.gen(function* () {
      const { result, events } = yield* withRetirer(teardownOnce, (retirer, dirs, events) =>
        Effect.gen(function* () {
          const first = yield* parkedRetirement(retirer, dirs, events);
          const error = yield* retireRemovedThreadWorktree(
            retirer,
            { cwd: dirs.projectCwd, path: dirs.worktreePath, force: false },
            stockRemove(events),
            Effect.void,
          ).pipe(Effect.flip);
          yield* first.release;
          yield* Fiber.join(first.fiber);
          return error;
        }),
      );
      assert.instanceOf(result, GitCommandError);
      assert.include(result.detail, "already being removed");
      assert.isFalse(events.includes("stock-remove"));
    }),
  );

  it.effect(
    "force:true fails, not waits, while a board cleanup is retiring the same worktree",
    () =>
      Effect.gen(function* () {
        const { result, events } = yield* withRetirer(teardownOnce, (retirer, dirs, events) =>
          Effect.gen(function* () {
            const first = yield* parkedRetirement(retirer, dirs, events);
            // The first retirement stays parked: a call that waited would hang.
            const error = yield* retireRemovedThreadWorktree(
              retirer,
              { cwd: dirs.projectCwd, path: dirs.worktreePath, force: true },
              stockRemove(events),
              Effect.void,
            ).pipe(Effect.flip);
            yield* first.release;
            yield* Fiber.join(first.fiber);
            return error;
          }),
        );
        assert.instanceOf(result, GitCommandError);
        assert.include(result.detail, "already being removed");
        assert.isFalse(events.includes("stock-remove"));
      }),
  );

  it.effect("force:true kills what is left, then makes the stock removal", () =>
    Effect.gen(function* () {
      const survivor = { pid: 4412, name: "cargo" };
      const { events } = yield* withRetirer(
        { survivors: [[survivor], []] },
        (retirer, dirs, events) =>
          retireRemovedThreadWorktree(
            retirer,
            { cwd: dirs.projectCwd, path: dirs.worktreePath, force: true },
            stockRemove(events),
            Effect.void,
          ),
      );
      assert.deepStrictEqual(events, [
        "check-processes",
        "SIGTERM:4412",
        "check-processes",
        "stock-remove",
      ]);
    }),
  );

  // Live: the remove script is a real process the test lets finish.
  it.live("returns once remove scripts start, and finishes the removal in the background", () =>
    Effect.gen(function* () {
      const removed = yield* Deferred.make<void>();
      const { result, events, read } = yield* withRetirer(
        {
          scripts: [
            script("park", "while [ ! -f ../go ]; do sleep 0.05; done; echo ran > ../hook.log", {
              runOnWorktreeRemove: true,
            }),
          ],
        },
        (retirer, dirs, events) =>
          Effect.gen(function* () {
            yield* retireRemovedThreadWorktree(
              retirer,
              { cwd: dirs.projectCwd, path: dirs.worktreePath, force: true },
              stockRemove(events),
              Deferred.succeed(removed, undefined).pipe(Effect.asVoid),
            );
            // Back while the script still waits: nothing removed yet.
            const early = [...events];
            NodeFS.writeFileSync(NodePath.join(dirs.root, "go"), "");
            yield* Deferred.await(removed);
            return early;
          }),
      );
      assert.deepStrictEqual(result, ["check-processes"]);
      assert.strictEqual(read("hook.log"), "ran\n");
      assert.deepStrictEqual(events, ["check-processes", "stock-remove"]);
    }),
  );
});

describe("survivorReason", () => {
  it("names the programs, without pids or counts, so it stays the same between sweeps", () => {
    assert.strictEqual(
      survivorReason([{ pid: 1, name: "cargo" }]),
      "cargo is still running in the worktree",
    );
    const building = (rustcPids: ReadonlyArray<number>) =>
      survivorReason([
        { pid: 1, name: "cargo" },
        ...rustcPids.map((pid) => ({ pid, name: "rustc" })),
      ]);
    assert.strictEqual(building([2]), "cargo and rustc are still running in the worktree");
    assert.strictEqual(building([3, 4, 5]), building([2]));
    assert.strictEqual(
      survivorReason(["vite", "node", "esbuild", "cargo"].map((name, pid) => ({ pid, name }))),
      "cargo, esbuild, node and others are still running in the worktree",
    );
  });
});

describe("findProcessesInDirectoryLinux", () => {
  const fakeProc = (cwds: Record<string, string | "EACCES">): ProcFs => ({
    readdir: async () => [...Object.keys(cwds), "self", "meminfo"],
    readlink: async (path) => {
      const pid = path.split("/")[2] ?? "";
      const cwd = cwds[pid];
      if (cwd === undefined || cwd === "EACCES") {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return cwd;
    },
    readFile: async (path) => `comm-${path.split("/")[2]}\n`,
    realpath: async (path) => path,
  });

  it("finds processes inside the worktree, skipping unreadable entries and itself", async () => {
    const found = await findProcessesInDirectoryLinux("/wt/board-1", {
      selfPid: 10,
      procFs: fakeProc({
        "10": "/wt/board-1",
        "11": "/wt/board-1/crates/domain",
        "12": "/wt/board-10",
        "13": "EACCES",
        "14": "/wt/board-1",
      }),
    });
    assert.deepStrictEqual(found, [
      { pid: 11, name: "comm-11" },
      { pid: 14, name: "comm-14" },
    ]);
  });

  it.live("finds a real process running in a folder (Linux)", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "linux") return;
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-retire-proc-"));
      const child = NodeChildProcess.spawn("sleep", ["30"], { cwd: dir, stdio: "ignore" });
      const found = yield* Effect.promise(async () => {
        await new Promise((resolve) => child.once("spawn", resolve));
        return findProcessesInDirectoryLinux(dir);
      }).pipe(Effect.ensuring(Effect.sync(() => child.kill("SIGKILL"))));
      assert.deepInclude(found, { pid: child.pid!, name: "sleep" });
    }),
  );
});

describe("parseLsofProcesses", () => {
  it("keeps processes whose cwd or executable is in the folder", () => {
    const output = [
      "p100",
      "ccargo",
      "fcwd",
      "f3",
      "p200",
      "cvim",
      "f4",
      "p300",
      "cnode",
      "ftxt",
      "",
    ].join("\n");
    assert.deepStrictEqual(parseLsofProcesses(output, 1), [
      { pid: 100, name: "cargo" },
      { pid: 300, name: "node" },
    ]);
  });
});
