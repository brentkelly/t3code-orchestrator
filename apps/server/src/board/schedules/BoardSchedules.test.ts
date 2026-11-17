/**
 * t3o.json schedules (T3O-117): the reconciler, import and export, the runner and
 * retention, against the real store on SQLite and fakes for upstream's services.
 */
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type T3oFileSchedule,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../../persistence/Migrations.ts";
import { attachBoardDatabase } from "../boardDatabase.ts";
import { BOARD_MIGRATIONS } from "../migrations/index.ts";
import {
  deletedThreadState,
  type BoardProject,
  type BoardThreadState,
  type UnknownThreadState,
} from "../ThreadGateway.ts";
import { makeBoardSchedules, type BoardSchedulesDeps } from "./BoardSchedules.ts";
import { BoardScheduleStore, BoardScheduleStoreLive } from "./BoardScheduleStore.ts";
import { orThread, registerBoardScheduleRunner } from "./scheduleRuns.ts";
import { SKIPPED_NOT_SCHEDULED, SKIPPED_STILL_GOING } from "./scheduleLogic.ts";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const T0 = "2026-03-01T00:00:00.000Z";
const projectId = ProjectId.make("project-a");
const server = EnvironmentId.make("env-board");
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const nightly: T3oFileSchedule = {
  id: "nightly-tests",
  title: "Nightly full test run",
  schedule: { type: "fixed_time", timeOfDay: "02:00" },
  enabled: true,
  prompt: "Run the suite.",
};

const handMade = (id: string, title: string, over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title,
  prompt: "Do it by hand.",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId,
  threadId: null,
  threadMode: "new_thread",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "haiku" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: T0,
  updatedAt: T0,
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...over,
});

const thread = (threadId: string, over: Partial<BoardThreadState> = {}): BoardThreadState => ({
  ...deletedThreadState(ThreadId.make(threadId), projectId),
  deleted: false,
  ...over,
});

/** Upstream's scheduled tasks and the board's ports, in memory. */
const makeWorld = () => {
  const tasks = new Map<string, ScheduledTask>();
  const upserts: ScheduledTaskUpsertInput[] = [];
  const deletedTasks: string[] = [];
  const states = new Map<string, BoardThreadState | UnknownThreadState>();
  const deletedThreads: string[] = [];
  const removed: Array<{ worktreePath: string | null; branch: string | null }> = [];
  const launches: Array<{ threadId: ThreadId; recordedFirst: boolean }> = [];
  const world = {
    tasks,
    upserts,
    deletedTasks,
    states,
    deletedThreads,
    removed,
    launches,
    failUpsert: null as string | null,
    failLaunch: null as string | null,
    /** One stale `list`, as a page that hasn't seen a hand deletion yet. */
    staleList: null as ReadonlyArray<ScheduledTask> | null,
    uuids: 0,
  };
  const fail = (message: string) => Effect.fail(new ScheduledTaskError({ message }));
  const deps = (store: BoardScheduleStore["Service"]): BoardSchedulesDeps => ({
    store,
    tasks: {
      list: () =>
        Effect.sync(() => {
          const stale = world.staleList;
          world.staleList = null;
          return stale ?? [...tasks.values()];
        }),
      upsert: (input) =>
        Effect.gen(function* () {
          upserts.push(input);
          if (world.failUpsert !== null) return yield* fail(world.failUpsert);
          const existing = tasks.get(input.id!);
          if (input.requireExisting === true && existing === undefined) {
            return yield* fail("Schedule task not found.");
          }
          const task: ScheduledTask = {
            ...(existing ?? handMade(input.id!, input.title)),
            title: input.title,
            prompt: input.prompt,
            enabled: input.enabled,
            schedule: input.schedule as ScheduledTask["schedule"],
            threadMode: input.threadMode ?? "new_thread",
            workspaceStrategy: input.workspaceStrategy,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            creationSource: input.creationSource ?? "web",
          };
          tasks.set(task.id, task);
          return { task };
        }),
      delete: (id) =>
        Effect.sync(() => {
          deletedTasks.push(id);
          tasks.delete(id);
        }),
      runNow: (id) => fail(`no runner in this world (${id})`),
    },
    serverEnvironmentId: server,
    projects: () =>
      Effect.succeed([
        { id: projectId, title: "mesh.relay", workspaceRoot: "/repo", deleted: false, scripts: [] },
      ] satisfies ReadonlyArray<BoardProject>),
    threadState: (threadId) => Effect.sync(() => states.get(threadId) ?? null),
    deleteThread: (threadId) =>
      Effect.sync(() => {
        deletedThreads.push(threadId);
        states.set(threadId, deletedThreadState(threadId, projectId));
      }),
    threadWorkspace: (threadId) =>
      Effect.succeed({ worktreePath: `/worktrees/${threadId}`, branch: `t3code/${threadId}` }),
    removeRunWorktree: ({ worktreePath, branch }) =>
      Effect.sync(() => {
        removed.push({ worktreePath, branch });
        return true;
      }),
    defaultBranch: () => Effect.succeed("main"),
    modelFor: () => Effect.succeed(codex),
    launch: (input) =>
      Effect.gen(function* () {
        const recorded = yield* store.runByThread(input.threadId).pipe(Effect.orDie);
        launches.push({ threadId: input.threadId, recordedFirst: recorded !== null });
        if (world.failLaunch !== null) return yield* Effect.fail({ message: world.failLaunch });
        states.set(input.threadId, thread(input.threadId, { activeTurnRef: "turn-1" }));
        return input.threadId;
      }),
    uuid: Effect.sync(() => `uuid-${++world.uuids}`),
    utcOffsetMinutes: Effect.succeed(60),
    retainInBackground: false,
  });
  return { world, deps };
};

const setup = Effect.gen(function* () {
  yield* attachBoardDatabase();
  yield* runMigrations();
  for (const [, , migration] of BOARD_MIGRATIONS) yield* migration;
  yield* TestClock.setTime(NOW);
  const store = yield* BoardScheduleStore;
  const { world, deps } = makeWorld();
  const schedules = makeBoardSchedules(deps(store));
  return { world, store, schedules };
});

const layer = BoardScheduleStoreLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

type Setup = Effect.Success<typeof setup>;

/** Each test on its own database. */
const test = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, BoardScheduleStore | SqlClient.SqlClient>,
) => it.effect(name, () => body().pipe(Effect.provide(layer)));

const importFile = (
  { schedules }: Setup,
  file: ReadonlyArray<T3oFileSchedule> | null,
  placements: Record<string, EnvironmentId | null> = {},
) =>
  Effect.gen(function* () {
    const preview = yield* schedules.previewImport(projectId, file);
    const outcome = yield* schedules.applyImport(projectId, preview, placements);
    return { preview, outcome };
  });

const rowOf = ({ store }: Setup, fileId = nightly.id) =>
  store.row(projectId, fileId).pipe(Effect.map((row) => row!));

describe("BoardSchedules", () => {
  test("creates the task with the id allocated in the row, as a full-access timer", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const { preview, outcome } = yield* importFile(ctx, [nightly], { [nightly.id]: server });
      assert.deepStrictEqual(
        preview.entries.map((entry) => entry.row.kind),
        ["create"],
      );
      assert.deepStrictEqual(outcome, { setUp: 1, stopped: 0, deleted: 0, failures: [] });
      const row = yield* rowOf(ctx);
      assert.strictEqual(row.taskId, "scheduled-task:board:uuid-1");
      const [upsert] = ctx.world.upserts;
      assert.strictEqual(upsert?.id, row.taskId);
      assert.isUndefined(upsert?.requireExisting);
      assert.strictEqual(upsert?.runtimeMode, "full-access");
      assert.strictEqual(upsert?.threadMode, "new_thread");
      assert.strictEqual(upsert?.creationSource, "server");
      assert.strictEqual(upsert?.createdBy, "system");
      assert.deepStrictEqual(upsert?.workspaceStrategy, {
        type: "worktree",
        baseRef: "main",
        startFromOrigin: true,
      });
      assert.deepStrictEqual(row.applied?.prompt, nightly.prompt);
    }));

  test("Don't schedule imports the row and creates no task", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const { outcome } = yield* importFile(ctx, [nightly]);
      assert.strictEqual(outcome.setUp, 0);
      assert.strictEqual(ctx.world.tasks.size, 0);
      assert.strictEqual((yield* rowOf(ctx)).environmentId, null);
      const listed = yield* ctx.schedules.list({ projectId });
      assert.strictEqual(listed.schedules[0]?.environmentId, null);
      assert.strictEqual(listed.serverEnvironmentId, server);
    }));

  test("updates in place, keeping the task's model and workspace", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* importFile(ctx, [nightly], { [nightly.id]: server });
      const row = yield* rowOf(ctx);
      const live = ctx.world.tasks.get(row.taskId)!;
      const handPicked = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
      ctx.world.tasks.set(row.taskId, {
        ...live,
        modelSelection: handPicked,
        workspaceStrategy: { type: "root" },
      });
      const changed = { ...nightly, prompt: "Run the suite twice." };
      const { preview } = yield* importFile(ctx, [changed], { [nightly.id]: server });
      assert.strictEqual(preview.entries[0]?.row.kind, "update");
      assert.strictEqual(preview.entries[0]?.row.previousPrompt, nightly.prompt);
      const upsert = ctx.world.upserts.at(-1)!;
      assert.strictEqual(upsert.id, row.taskId);
      assert.isTrue(upsert.requireExisting);
      assert.deepStrictEqual(upsert.modelSelection, handPicked);
      assert.deepStrictEqual(upsert.workspaceStrategy, { type: "root" });
      assert.strictEqual(ctx.world.tasks.get(row.taskId)?.prompt, changed.prompt);
    }));

  test("adopts the one hand-made task with the title, and shows what changes", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      ctx.world.tasks.set(
        "hand-1",
        handMade("hand-1", "  Nightly full test run ", {
          threadMode: "continue",
          threadId: ThreadId.make("thread-old"),
        }),
      );
      const { preview } = yield* importFile(ctx, [nightly], { [nightly.id]: server });
      const row = preview.entries[0]!.row;
      assert.strictEqual(row.kind, "adopt");
      assert.strictEqual(row.currentEnvironmentId, server);
      const labels = row.changes.map((change) => `${change.label}: ${change.from} → ${change.to}`);
      assert.include(labels, "Access: approval-required → full access");
      assert.include(labels, "Thread: continues thread thread-old → a new thread each run");
      assert.include(labels, "Workspace: project folder → fresh worktree off origin");
      assert.include(labels, "Schedule: Every hour → Daily at 02:00");
      assert.strictEqual((yield* rowOf(ctx)).taskId, "hand-1");
      assert.strictEqual(ctx.world.tasks.get("hand-1")?.runtimeMode, "full-access");
    }));

  test("creates rather than adopts when two hand-made tasks share the title", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      ctx.world.tasks.set("hand-1", handMade("hand-1", nightly.title));
      ctx.world.tasks.set("hand-2", handMade("hand-2", nightly.title));
      const preview = yield* ctx.schedules.previewImport(projectId, [nightly]);
      assert.strictEqual(preview.entries[0]?.row.kind, "create");
      assert.include(preview.warnings[0], "2 hand-made tasks");
    }));

  test("an adoption left on Don't schedule deletes the hand-made task and says it stopped", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      ctx.world.tasks.set("hand-1", handMade("hand-1", nightly.title));
      const { outcome } = yield* importFile(ctx, [nightly]);
      assert.strictEqual(outcome.stopped, 1);
      assert.deepStrictEqual(ctx.world.deletedTasks, ["hand-1"]);
    }));

  test("deletes a schedule that left the file, and only when the key is present", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* importFile(ctx, [nightly], { [nightly.id]: server });
      const taskId = (yield* rowOf(ctx)).taskId;
      const absent = yield* ctx.schedules.previewImport(projectId, null);
      assert.deepStrictEqual(absent.entries, []);
      const { preview, outcome } = yield* importFile(ctx, []);
      assert.strictEqual(preview.entries[0]?.row.kind, "delete");
      assert.strictEqual(outcome.deleted, 1);
      assert.deepStrictEqual(ctx.world.deletedTasks, [taskId]);
      assert.isNull(yield* ctx.store.row(projectId, nightly.id));
    }));

  test("never touches a task no row links", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      ctx.world.tasks.set("hand-1", handMade("hand-1", "Weekly changelog draft"));
      yield* importFile(ctx, [nightly], { [nightly.id]: server });
      yield* importFile(ctx, []);
      assert.notInclude(
        ctx.world.upserts.map((upsert) => String(upsert.id)),
        "hand-1",
      );
      assert.notInclude(ctx.world.deletedTasks, "hand-1");
      assert.deepStrictEqual(
        ctx.world.tasks.get("hand-1"),
        handMade("hand-1", "Weekly changelog draft"),
      );
    }));

  test("an import whose schedules didn't change leaves every placement alone", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* importFile(ctx, [nightly], { [nightly.id]: server });
      const upserts = ctx.world.upserts.length;
      // Only CI changed: the schedules diff is empty, whatever the placements say.
      const { preview, outcome } = yield* importFile(ctx, [nightly], { [nightly.id]: null });
      assert.deepStrictEqual(preview.entries, []);
      assert.deepStrictEqual(outcome, { setUp: 0, stopped: 0, deleted: 0, failures: [] });
      assert.strictEqual((yield* rowOf(ctx)).environmentId, server);
      assert.strictEqual(ctx.world.upserts.length, upserts);
    }));

  test("concurrent reconciles of one project create one task", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* importFile(ctx, [nightly]);
      const row = yield* rowOf(ctx);
      yield* ctx.store.put({ ...row, environmentId: server });
      yield* Effect.all([ctx.schedules.reconcile(projectId), ctx.schedules.reconcile(projectId)], {
        concurrency: "unbounded",
      });
      assert.strictEqual(ctx.world.upserts.length, 1);
      assert.strictEqual(ctx.world.tasks.size, 1);
    }));

  test("a task deleted by hand becomes Not scheduled and missing, and isn't recreated", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* importFile(ctx, [nightly], { [nightly.id]: server });
      ctx.world.tasks.clear();
      const listed = yield* ctx.schedules.list({ projectId });
      assert.strictEqual(listed.schedules[0]?.environmentId, null);
      assert.isTrue(listed.schedules[0]?.missing);
      yield* ctx.schedules.reconcile(projectId);
      assert.strictEqual(ctx.world.tasks.size, 0);
      // Picking a machine schedules it again.
      yield* ctx.schedules.setMachine({ projectId, fileId: nightly.id, environmentId: server });
      assert.strictEqual(ctx.world.tasks.size, 1);
      assert.isFalse((yield* rowOf(ctx)).missing);
    }));

  test("an update whose task was deleted by hand is refused and the row goes missing", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* importFile(ctx, [nightly], { [nightly.id]: server });
      const live = [...ctx.world.tasks.values()];
      ctx.world.tasks.clear();
      // The reconcile's own read hasn't seen the deletion yet; the save has.
      ctx.world.staleList = live;
      const preview = yield* ctx.schedules.previewImport(projectId, [
        { ...nightly, prompt: "Changed." },
      ]);
      ctx.world.staleList = live;
      yield* ctx.schedules.applyImport(projectId, preview, { [nightly.id]: server });
      assert.isTrue(ctx.world.upserts.at(-1)?.requireExisting);
      const row = yield* rowOf(ctx);
      assert.isTrue(row.missing);
      assert.strictEqual(row.environmentId, null);
      assert.strictEqual(ctx.world.tasks.size, 0);
    }));

  test("a hand edit survives a retry, and the next import reasserts the file", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* importFile(ctx, [nightly], { [nightly.id]: server });
      const taskId = (yield* rowOf(ctx)).taskId;
      ctx.world.tasks.set(taskId, { ...ctx.world.tasks.get(taskId)!, title: "Renamed by hand" });
      const upserts = ctx.world.upserts.length;
      yield* ctx.schedules.retry({ projectId, fileIds: [nightly.id] });
      assert.strictEqual(ctx.world.upserts.length, upserts);
      assert.isTrue((yield* ctx.schedules.list({ projectId })).schedules[0]?.editedByHand);
      // A hand edit never makes the file differ.
      assert.deepStrictEqual(
        (yield* ctx.schedules.previewImport(projectId, [nightly])).entries,
        [],
      );
      yield* importFile(ctx, [{ ...nightly, prompt: "Run it all." }], { [nightly.id]: server });
      assert.strictEqual(ctx.world.tasks.get(taskId)?.title, nightly.title);
      assert.isFalse((yield* ctx.schedules.list({ projectId })).schedules[0]?.editedByHand);
    }));

  test("an update shows a hand pause the import resumes", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* importFile(ctx, [nightly], { [nightly.id]: server });
      const taskId = (yield* rowOf(ctx)).taskId;
      ctx.world.tasks.set(taskId, { ...ctx.world.tasks.get(taskId)!, enabled: false });
      const preview = yield* ctx.schedules.previewImport(projectId, [
        { ...nightly, prompt: "New." },
      ]);
      assert.deepInclude(preview.entries[0]?.row.changes ?? [], {
        label: "Enabled",
        from: "Paused by hand",
        to: "Resumes (paused by hand)",
      });
    }));

  test("reports a failed reconcile, and Retry sets it up", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      ctx.world.failUpsert = "Full access is turned off by policy.";
      const { outcome } = yield* importFile(ctx, [nightly], { [nightly.id]: server });
      assert.deepStrictEqual(outcome.failures, [
        {
          fileId: nightly.id,
          title: nightly.title,
          environmentId: server,
          reason: "Full access is turned off by policy.",
        },
      ]);
      const listed = yield* ctx.schedules.list({ projectId });
      assert.strictEqual(listed.schedules[0]?.lastResult.kind, "schedule-failed");
      ctx.world.failUpsert = null;
      const retried = yield* ctx.schedules.retry({ projectId, fileIds: [nightly.id] });
      assert.deepStrictEqual(retried, { setUp: 1, failures: [] });
      assert.strictEqual(ctx.world.tasks.size, 1);
    }));

  test("refuses a placement on a machine the board can't target", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      assert.isNull(ctx.schedules.placementRefusal(server));
      assert.isNull(ctx.schedules.placementRefusal(null));
      assert.isNotNull(ctx.schedules.placementRefusal(EnvironmentId.make("env-other")));
      yield* importFile(ctx, [nightly]);
      const refused = yield* Effect.flip(
        ctx.schedules.setMachine({
          projectId,
          fileId: nightly.id,
          environmentId: EnvironmentId.make("env-other"),
        }),
      );
      assert.include(refused.message, "isn't a machine");
    }));

  test("export links hand-made tasks under slugged ids, and Export again unlinks them", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* importFile(ctx, [{ ...nightly, id: "weekly-changelog-draft" }]);
      ctx.world.tasks.set("hand-1", handMade("hand-1", "Weekly changelog draft"));
      ctx.world.tasks.set("hand-2", handMade("hand-2", "Weekly changelog draft"));
      ctx.world.tasks.set(
        "hook",
        handMade("hook", "Webhook", { schedule: { type: "webhook", signature: null } }),
      );
      ctx.world.tasks.set(
        "bound",
        handMade("bound", "Bound", { threadMode: "continue", threadId: ThreadId.make("t-1") }),
      );
      const exported = yield* ctx.schedules.exportSchedules(projectId, { excludeHandMade: false });
      assert.deepStrictEqual(
        exported.handMade.map((task) => [task.taskId, task.fileId]),
        [
          ["hand-1", "weekly-changelog-draft-2"],
          ["hand-2", "weekly-changelog-draft-3"],
        ],
      );
      assert.strictEqual(exported.schedules?.length, 3);
      assert.include(exported.warnings[0], "Bound");
      // Linked, never rewritten.
      assert.strictEqual(ctx.world.upserts.length, 0);
      const linked = yield* rowOf(ctx, "weekly-changelog-draft-2");
      assert.strictEqual(linked.environmentId, server);
      assert.isTrue(linked.exportLinked);
      const managed = yield* ctx.schedules.managedTasks();
      assert.deepStrictEqual(managed.tasks.map((task) => task.taskId).toSorted(), [
        "hand-1",
        "hand-2",
      ]);
      const again = yield* ctx.schedules.exportSchedules(projectId, { excludeHandMade: true });
      assert.deepStrictEqual(
        again.schedules?.map((schedule) => schedule.id),
        ["weekly-changelog-draft"],
      );
      assert.isNull(yield* ctx.store.row(projectId, "weekly-changelog-draft-2"));
      assert.isTrue(ctx.world.tasks.has("hand-1"));
      assert.deepStrictEqual(ctx.world.deletedTasks, []);
    }));
});

describe("BoardSchedules runs", () => {
  const scheduled = Effect.gen(function* () {
    const ctx = yield* setup;
    yield* importFile(ctx, [nightly], { [nightly.id]: server });
    const row = yield* rowOf(ctx);
    return { ...ctx, task: ctx.world.tasks.get(row.taskId)! };
  });

  test("records the run's thread before it launches, in a fresh worktree", () =>
    Effect.gen(function* () {
      const ctx = yield* scheduled;
      const threadId = yield* ctx.schedules.run(ctx.task);
      assert.deepStrictEqual(ctx.world.launches, [{ threadId: threadId!, recordedFirst: true }]);
      const [run] = yield* ctx.store.runs(projectId, nightly.id);
      assert.strictEqual(run?.threadId, threadId);
      assert.strictEqual(run?.launchError, null);
      const listed = yield* ctx.schedules.list({ projectId });
      assert.strictEqual(listed.schedules[0]?.lastResult.kind, "running");
    }));

  test("skips an unscheduled schedule and one whose previous run is still turning", () =>
    Effect.gen(function* () {
      const ctx = yield* scheduled;
      yield* ctx.schedules.run(ctx.task);
      const going = yield* Effect.flip(ctx.schedules.run(ctx.task));
      assert.strictEqual(going.message, SKIPPED_STILL_GOING);
      yield* ctx.schedules.setMachine({ projectId, fileId: nightly.id, environmentId: null });
      const off = yield* Effect.flip(ctx.schedules.run(ctx.task));
      assert.strictEqual(off.message, SKIPPED_NOT_SCHEDULED);
      assert.strictEqual(ctx.world.launches.length, 1);
    }));

  test("a run awaiting a human doesn't hold the next one back", () =>
    Effect.gen(function* () {
      const ctx = yield* scheduled;
      const first = yield* ctx.schedules.run(ctx.task);
      ctx.world.states.set(
        first!,
        thread(first!, { activeTurnRef: "turn-1", awaitingUserInput: true }),
      );
      yield* ctx.schedules.run(ctx.task);
      assert.strictEqual(ctx.world.launches.length, 2);
      const listed = yield* ctx.schedules.list({ projectId });
      assert.strictEqual(listed.schedules[0]?.lastResult.kind, "running");
    }));

  test("a launch failure fails the run and is shown as Failed to start", () =>
    Effect.gen(function* () {
      const ctx = yield* scheduled;
      ctx.world.failLaunch = "Base ref main is gone.";
      const failure = yield* Effect.flip(ctx.schedules.run(ctx.task));
      assert.strictEqual(failure.message, "Base ref main is gone.");
      const [run] = yield* ctx.store.runs(projectId, nightly.id);
      assert.strictEqual(run?.launchError, "Base ref main is gone.");
      const listed = yield* ctx.schedules.list({ projectId });
      assert.strictEqual(listed.schedules[0]?.lastResult.kind, "failed-to-start");
    }));

  test("retention keeps 7 days, the newest 3, and every run still in use", () =>
    Effect.gen(function* () {
      const ctx = yield* scheduled;
      const day = 24 * 60 * 60 * 1000;
      const ages = [1, 2, 3, 4, 8, 9, 10, 11, 12, 13];
      for (const [index, age] of ages.entries()) {
        const threadId = ThreadId.make(`run-${index}`);
        yield* ctx.store.recordRun({
          threadId,
          projectId,
          fileId: nightly.id,
          environmentId: server,
          startedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW - age * day)),
          launchError: null,
        });
        ctx.world.states.set(threadId, thread(threadId));
      }
      ctx.world.states.set("run-4", thread("run-4", { activeTurnRef: "turn-9" }));
      ctx.world.states.set("run-5", thread("run-5", { awaitingPermission: true }));
      yield* ctx.store.recordTouchedCard(ThreadId.make("run-6"), "card-1");
      yield* ctx.store.recordCreatedCard({
        cardId: "card-2",
        projectId,
        fileId: nightly.id,
        threadId: ThreadId.make("run-7"),
        createdAt: T0,
      });
      yield* ctx.schedules.retain(projectId, nightly.id);
      assert.deepStrictEqual(ctx.world.deletedThreads, ["run-8", "run-9"]);
      assert.deepStrictEqual(ctx.world.removed, [
        { worktreePath: "/worktrees/run-8", branch: "t3code/run-8" },
        { worktreePath: "/worktrees/run-9", branch: "t3code/run-9" },
      ]);
      const kept = (yield* ctx.store.runs(projectId, nightly.id)).map((run) => run.threadId);
      assert.deepStrictEqual(kept, [
        "run-0",
        "run-1",
        "run-2",
        "run-3",
        "run-4",
        "run-5",
        "run-6",
        "run-7",
      ]);
    }));
});

describe("BoardScheduleRuns.orThread", () => {
  const upstream = Effect.succeed(Exit.succeed(ThreadId.make("thread-upstream")));

  test("runs an unlinked task's own thread, and hands a linked one to the runner", () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const unlinked = handMade("hand-1", "Hand-made");
      assert.deepStrictEqual(yield* orThread(sql, unlinked, upstream), yield* upstream);
      yield* importFile(ctx, [nightly], { [nightly.id]: server });
      const linked = ctx.world.tasks.get((yield* rowOf(ctx)).taskId)!;
      const noRunner = yield* orThread(sql, linked, upstream);
      assert.isTrue(Exit.isFailure(noRunner));
      assert.include(
        String(Exit.isFailure(noRunner) ? noRunner.cause : ""),
        "Board is not running",
      );
      const viaRunner = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* registerBoardScheduleRunner({
            run: () => Effect.succeed(ThreadId.make("thread-board")),
          });
          return yield* orThread(sql, linked, upstream);
        }),
      );
      assert.deepStrictEqual(viaRunner, Exit.succeed(ThreadId.make("thread-board")));
    }));
});
