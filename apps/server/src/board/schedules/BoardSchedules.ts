/**
 * T3o: t3o.json schedules on the board (T3O-117). One long-lived service: it keeps the
 * upstream timer tasks in step with the store, runs each schedule when its timer fires,
 * and answers the Schedules tab, import and export. Every reconcile of a project runs
 * under that project's lock. The upstream task is only a timer; never touch one no row links.
 */
import {
  BoardScheduleError,
  type BoardScheduleExportedTask,
  type BoardScheduleHandMadeTask,
  type BoardScheduleImportFailure,
  type BoardScheduleImportOutcome,
  type BoardScheduleImportRow,
  type BoardScheduleListInput,
  type BoardScheduleListResult,
  type BoardScheduleManagedTasksResult,
  type BoardScheduleRef,
  type BoardScheduleRetryInput,
  type BoardScheduleRetryResult,
  type BoardScheduleRow,
  type BoardScheduleRunNowResult,
  type BoardScheduleSetMachineInput,
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskError,
  type ScheduledTaskUpsertInput,
  scheduledTaskThreadMode,
  type T3oFileSchedule,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import type { BoardProject, BoardThreadState, UnknownThreadState } from "../ThreadGateway.ts";
import type { BoardScheduleStoreRow, BoardScheduleStoreShape } from "./BoardScheduleStore.ts";
import { BoardScheduleRunError } from "./scheduleRuns.ts";
import {
  SCHEDULE_RUN_BRANCH_PREFIX,
  SKIPPED_NOT_SCHEDULED,
  SKIPPED_STILL_GOING,
  adoptChanges,
  appliedFromTask,
  deriveLastResult,
  desiredFields,
  fieldChanges,
  fileScheduleOf,
  isAdoptable,
  previousRunStillGoing,
  retentionCandidates,
  retentionKeeps,
  sameDefinition,
  sameFields,
  slugScheduleId,
} from "./scheduleLogic.ts";

/** The upstream and board services the schedules reach, as ports so tests can stand in. */
export interface BoardSchedulesDeps {
  readonly store: BoardScheduleStoreShape;
  readonly tasks: {
    readonly list: () => Effect.Effect<ReadonlyArray<ScheduledTask>, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<{ readonly task: ScheduledTask }, ScheduledTaskError>;
    readonly delete: (id: ScheduledTaskId) => Effect.Effect<void, ScheduledTaskError>;
    readonly runNow: (
      id: ScheduledTaskId,
    ) => Effect.Effect<
      { readonly task: ScheduledTask; readonly threadId: ThreadId | null },
      ScheduledTaskError
    >;
  };
  /** This server: where every schedule's timer lives. */
  readonly serverEnvironmentId: EnvironmentId;
  readonly projects: () => Effect.Effect<ReadonlyArray<BoardProject>, BoardScheduleError>;
  /** A run thread's routed state; a failed read is `unknown`. */
  readonly threadState: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardThreadState | UnknownThreadState | null>;
  readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void, BoardScheduleError>;
  /** The run thread's worktree path, null when it has none or the thread is gone. */
  readonly threadWorktree: (threadId: ThreadId) => Effect.Effect<string | null, BoardScheduleError>;
  /** Remove a pruned run's worktree, then its branch; true only once both are confirmed gone. */
  readonly removeRunWorktree: (input: {
    readonly project: BoardProject;
    readonly worktreePath: string | null;
    readonly branch: string | null;
  }) => Effect.Effect<boolean>;
  /** The project's default branch now, or null when it can't be resolved. */
  readonly defaultBranch: (projectId: ProjectId) => Effect.Effect<string | null>;
  readonly modelFor: (projectId: ProjectId) => Effect.Effect<ModelSelection>;
  /** Create the run's thread and send its first message; preparation forks inside. */
  readonly launch: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly prompt: string;
    readonly taskId: ScheduledTaskId;
    readonly modelSelection: ModelSelection;
    readonly baseRef: string;
    readonly branch: string;
  }) => Effect.Effect<ThreadId, { readonly message: string }>;
  readonly uuid: Effect.Effect<string>;
  readonly utcOffsetMinutes: Effect.Effect<number>;
  /** Off in tests, which run retention and worker launches inline to observe them. */
  readonly retainInBackground: boolean;
  /** The board's workers a schedule can run on (T3O-118); absent, only this server. */
  readonly workers?: BoardScheduleWorkers;
}

/** Where a worker-targeted run goes, or why it can't go there now. */
export type BoardScheduleWorkerTarget =
  | { readonly kind: "ready"; readonly workerProjectId: ProjectId; readonly label: string }
  | { readonly kind: "skip"; readonly reason: string };

export interface BoardScheduleWorkerLaunchInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly workerProjectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly branch: string;
  readonly previousRuns: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly touchedCard: boolean;
  }>;
}

export interface BoardScheduleWorkers {
  /** The board's registered workers' labels, by id. */
  readonly labels: Effect.Effect<ReadonlyMap<EnvironmentId, string>>;
  readonly target: (input: {
    readonly workerId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<BoardScheduleWorkerTarget>;
  /** Launch on the worker; answers which previous runs it pruned. */
  readonly launch: (
    workerId: EnvironmentId,
    input: BoardScheduleWorkerLaunchInput,
  ) => Effect.Effect<
    ReadonlyArray<ThreadId>,
    { readonly message: string; readonly agentCap: boolean }
  >;
}

/** One import entry the service applies: the previewed row and what it rests on. */
export interface BoardScheduleImportEntry {
  readonly row: BoardScheduleImportRow;
  readonly definition: T3oFileSchedule | null;
  readonly existing: BoardScheduleStoreRow | null;
  readonly adoptTask: ScheduledTask | null;
}

export interface BoardSchedulePreview {
  readonly entries: ReadonlyArray<BoardScheduleImportEntry>;
  readonly warnings: ReadonlyArray<string>;
}

export interface BoardSchedulesShape {
  readonly list: (
    input: BoardScheduleListInput,
  ) => Effect.Effect<BoardScheduleListResult, BoardScheduleError>;
  readonly setMachine: (
    input: BoardScheduleSetMachineInput,
  ) => Effect.Effect<BoardScheduleRow, BoardScheduleError>;
  readonly runNow: (
    input: BoardScheduleRef,
  ) => Effect.Effect<BoardScheduleRunNowResult, BoardScheduleError>;
  readonly retry: (
    input: BoardScheduleRetryInput,
  ) => Effect.Effect<BoardScheduleRetryResult, BoardScheduleError>;
  readonly managedTasks: () => Effect.Effect<BoardScheduleManagedTasksResult, BoardScheduleError>;
  /** Reconcile one project, reasserting the file's version on the rows named. */
  readonly reconcile: (
    projectId: ProjectId,
    reassert?: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyMap<string, RowOutcome>, BoardScheduleError>;
  /** What importing the file's schedules (null: key absent) would change. */
  readonly previewImport: (
    projectId: ProjectId,
    schedules: ReadonlyArray<T3oFileSchedule> | null,
  ) => Effect.Effect<BoardSchedulePreview, BoardScheduleError>;
  /** Why a placement can't be used, or null. */
  readonly placementRefusal: (environmentId: EnvironmentId | null) => Effect.Effect<string | null>;
  readonly applyImport: (
    projectId: ProjectId,
    preview: BoardSchedulePreview,
    placements: Readonly<Record<string, EnvironmentId | null>>,
  ) => Effect.Effect<BoardScheduleImportOutcome, BoardScheduleError>;
  /** The schedules an export writes, linking the project's hand-made tasks into the file. */
  readonly exportSchedules: (
    projectId: ProjectId,
    options: { readonly excludeHandMade: boolean },
  ) => Effect.Effect<
    {
      readonly schedules: ReadonlyArray<T3oFileSchedule> | undefined;
      readonly handMade: ReadonlyArray<BoardScheduleExportedTask>;
      readonly warnings: ReadonlyArray<string>;
    },
    BoardScheduleError
  >;
  /** The runner `ScheduledTaskService` hands a linked task's run to. */
  readonly run: (task: ScheduledTask) => Effect.Effect<ThreadId | null, BoardScheduleRunError>;
  /** Prune a schedule's old settled run threads. */
  readonly retain: (projectId: ProjectId, fileId: string) => Effect.Effect<void>;
}

export class BoardSchedules extends Context.Service<BoardSchedules, BoardSchedulesShape>()(
  "t3/board/schedules/BoardSchedules",
) {}

export type RowOutcome =
  | { readonly kind: "set-up" | "stopped" | "deleted" | "missing" | "unchanged" }
  | { readonly kind: "failed"; readonly reason: string };

const KIND_ORDER = { update: 0, adopt: 1, create: 2, delete: 3 } as const;

const scheduleError = (message: string, cause?: unknown) =>
  new BoardScheduleError({ message, ...(cause === undefined ? {} : { cause }) });

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

export const makeBoardSchedules = (deps: BoardSchedulesDeps): BoardSchedulesShape => {
  const { store } = deps;
  const locks = new Map<string, Semaphore.Semaphore>();
  const withProjectLock = <A, E, R>(projectId: ProjectId, effect: Effect.Effect<A, E, R>) => {
    let lock = locks.get(projectId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(projectId, lock);
    }
    return lock.withPermits(1)(effect);
  };
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const listTasks = deps.tasks
    .list()
    .pipe(Effect.mapError((cause) => scheduleError("Couldn't read the scheduled tasks.", cause)));
  const tasksById = listTasks.pipe(
    Effect.map((tasks) => new Map(tasks.map((task) => [task.id as string, task]))),
  );

  const workerLabels =
    deps.workers === undefined
      ? Effect.succeed(new Map<EnvironmentId, string>() as ReadonlyMap<EnvironmentId, string>)
      : deps.workers.labels;
  const machineName = (environmentId: EnvironmentId) =>
    environmentId === deps.serverEnvironmentId
      ? Effect.succeed("This server")
      : workerLabels.pipe(Effect.map((labels) => labels.get(environmentId) ?? environmentId));

  // Any registered worker: one offline or not ready yet is skipped when its run is due.
  const placementRefusal: BoardSchedulesShape["placementRefusal"] = (environmentId) =>
    environmentId === null || environmentId === deps.serverEnvironmentId
      ? Effect.succeed(null)
      : workerLabels.pipe(
          Effect.map((labels) =>
            labels.has(environmentId)
              ? null
              : `${environmentId} isn't a machine this board can run schedules on.`,
          ),
        );

  const upsertInput = (
    row: BoardScheduleStoreRow,
    live: ScheduledTask | null,
    baseRef: string,
    modelSelection: ModelSelection,
  ): ScheduledTaskUpsertInput => ({
    id: row.taskId,
    ...(row.applied === null ? {} : { requireExisting: true }),
    title: row.definition.title,
    prompt: row.definition.prompt,
    enabled: row.definition.enabled,
    schedule: row.definition.schedule,
    projectId: row.projectId,
    threadId: null,
    threadMode: "new_thread",
    // An update keeps the task's model and workspace; runs never use them anyway.
    workspaceStrategy: live?.workspaceStrategy ?? {
      type: "worktree",
      baseRef,
      startFromOrigin: true,
    },
    modelSelection: live?.modelSelection ?? modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "system",
    // Upstream defaults it to "web" on any save that omits it.
    creationSource: "server",
  });

  const save = (row: BoardScheduleStoreRow, patch: Partial<BoardScheduleStoreRow>) =>
    Effect.flatMap(nowIso, (updatedAt) => store.put({ ...row, ...patch, updatedAt }));

  const deleteTask = (taskId: ScheduledTaskId) =>
    deps.tasks.delete(taskId).pipe(Effect.mapError((error) => error.message));

  const reconcileRow = Effect.fn("BoardSchedules.reconcileRow")(function* (
    row: BoardScheduleStoreRow,
    live: ScheduledTask | null,
    reassert: boolean,
  ) {
    if (row.tombstone) {
      if (live !== null) {
        const deleted = yield* Effect.result(deleteTask(row.taskId));
        if (deleted._tag === "Failure") {
          yield* save(row, { lastError: deleted.failure });
          return { kind: "failed", reason: deleted.failure } satisfies RowOutcome;
        }
      }
      yield* store.remove(row.projectId, row.fileId);
      return { kind: "deleted" } satisfies RowOutcome;
    }
    // Still the human's task until an import adopts it: never rewritten or deleted here.
    if (row.exportLinked) return { kind: "unchanged" } satisfies RowOutcome;
    if (row.environmentId === null) {
      if (live === null) {
        if (row.applied !== null || row.lastError !== null) {
          yield* save(row, { applied: null, lastError: null });
        }
        return { kind: "unchanged" } satisfies RowOutcome;
      }
      const deleted = yield* Effect.result(deleteTask(row.taskId));
      if (deleted._tag === "Failure") {
        yield* save(row, { lastError: deleted.failure });
        return { kind: "failed", reason: deleted.failure } satisfies RowOutcome;
      }
      yield* save(row, { applied: null, lastError: null });
      return { kind: "stopped" } satisfies RowOutcome;
    }
    if (row.applied !== null && live === null) {
      // Deleted by hand on upstream's page: an Unschedule, never recreated silently.
      yield* save(row, { environmentId: null, missing: true, applied: null, lastError: null });
      return { kind: "missing" } satisfies RowOutcome;
    }
    const desired = desiredFields(row.definition);
    if (
      row.applied !== null &&
      !reassert &&
      row.lastError === null &&
      sameFields(desired, row.applied)
    ) {
      return { kind: "unchanged" } satisfies RowOutcome;
    }
    const baseRef = live === null ? ((yield* deps.defaultBranch(row.projectId)) ?? "main") : "";
    const model = live === null ? yield* deps.modelFor(row.projectId) : live.modelSelection;
    const upserted = yield* Effect.result(
      deps.tasks.upsert(upsertInput(row, live, baseRef, model)),
    );
    if (upserted._tag === "Failure") {
      const stillThere = yield* listTasks.pipe(
        Effect.map((tasks) => tasks.some((task) => task.id === row.taskId)),
        Effect.orElseSucceed(() => true),
      );
      if (row.applied !== null && !stillThere) {
        yield* save(row, { environmentId: null, missing: true, applied: null, lastError: null });
        return { kind: "missing" } satisfies RowOutcome;
      }
      const reason = upserted.failure.message;
      yield* save(row, { lastError: reason });
      return { kind: "failed", reason } satisfies RowOutcome;
    }
    yield* save(row, { applied: desired, lastError: null, missing: false });
    return { kind: "set-up" } satisfies RowOutcome;
  });

  const reconcileUnlocked = Effect.fn("BoardSchedules.reconcile")(function* (
    projectId: ProjectId,
    reassert: ReadonlySet<string>,
    only?: ReadonlySet<string>,
  ) {
    const outcomes = new Map<string, RowOutcome>();
    const rows = yield* store.rows(projectId);
    if (rows.length === 0) return outcomes;
    const tasks = yield* tasksById;
    const projects = yield* deps.projects();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined || project.deleted) {
      // A deleted project clears its rows, and the tasks they link.
      for (const row of rows) {
        if (tasks.has(row.taskId)) yield* Effect.ignore(deleteTask(row.taskId));
        yield* store.remove(row.projectId, row.fileId);
        outcomes.set(row.fileId, { kind: "deleted" });
      }
      return outcomes;
    }
    for (const row of rows) {
      if (only !== undefined && !only.has(row.fileId)) continue;
      outcomes.set(
        row.fileId,
        yield* reconcileRow(row, tasks.get(row.taskId) ?? null, reassert.has(row.fileId)),
      );
    }
    return outcomes;
  });

  const reconcile: BoardSchedulesShape["reconcile"] = (projectId, reassert = new Set()) =>
    withProjectLock(projectId, reconcileUnlocked(projectId, reassert));

  /** Tasks the board owns: export-linked ones are still the human's. */
  const boardLinked = (rows: ReadonlyArray<BoardScheduleStoreRow>) =>
    new Set<string>(rows.filter((row) => !row.exportLinked).map((row) => row.taskId));

  const handMadeOf = (
    tasks: ReadonlyArray<ScheduledTask>,
    linked: ReadonlySet<string>,
    projectId: ProjectId | undefined,
  ): ReadonlyArray<BoardScheduleHandMadeTask> =>
    tasks
      .filter(
        (task) => !linked.has(task.id) && (projectId === undefined || task.projectId === projectId),
      )
      .map((task) => ({
        taskId: task.id,
        projectId: task.projectId,
        title: task.title,
        schedule: scheduledTaskThreadMode(task) === "new_thread" ? fileScheduleOf(task) : null,
        environmentId: deps.serverEnvironmentId,
      }));

  const latestOf = Effect.fn("BoardSchedules.latestRun")(function* (row: BoardScheduleStoreRow) {
    const runs = yield* store.runs(row.projectId, row.fileId);
    const latestRun = runs[0];
    const latestState =
      latestRun === undefined || latestRun.launchError !== null
        ? null
        : yield* deps.threadState(latestRun.threadId);
    return { latestRun, latestState };
  });

  const toListRow = Effect.fn("BoardSchedules.toListRow")(function* (
    row: BoardScheduleStoreRow,
    live: ScheduledTask | null,
  ) {
    const { latestRun, latestState } = yield* latestOf(row);
    const scheduled = row.environmentId !== null && live !== null;
    const lastResult = deriveLastResult({
      lastError: row.lastError,
      scheduled,
      task: live,
      rowUpdatedAt: row.updatedAt,
      latestRun,
      latestState,
      now: yield* localNow,
    });
    return {
      projectId: row.projectId,
      fileId: row.fileId,
      title: row.definition.title,
      schedule: row.definition.schedule,
      enabled: row.definition.enabled,
      prompt: row.definition.prompt,
      environmentId: row.environmentId,
      taskId: row.taskId,
      missing: row.missing,
      lastError: row.lastError,
      editedByHand:
        live !== null && row.applied !== null && !sameFields(appliedFromTask(live), row.applied),
      nextRunAt: scheduled && live.enabled ? live.nextRunAt : null,
      running: lastResult.kind === "running",
      lastResult,
    } satisfies BoardScheduleRow;
  });

  /** Rows whose task was deleted by hand become Not scheduled and missing when read. */
  const settleMissing = Effect.fn("BoardSchedules.settleMissing")(function* (
    rows: ReadonlyArray<BoardScheduleStoreRow>,
    tasks: ReadonlyMap<string, ScheduledTask>,
  ) {
    const gone = rows.filter(
      (row) =>
        !row.tombstone &&
        !row.exportLinked &&
        row.environmentId !== null &&
        row.applied !== null &&
        !tasks.has(row.taskId),
    );
    const projectIds = [...new Set(gone.map((row) => row.projectId))];
    // Only the gone rows: a read must not retry or reassert any other.
    for (const projectId of projectIds) {
      const only = new Set(
        gone.filter((row) => row.projectId === projectId).map((row) => row.fileId),
      );
      yield* withProjectLock(projectId, reconcileUnlocked(projectId, new Set(), only));
    }
    return projectIds.length === 0 ? rows : yield* store.rows();
  });

  const list: BoardSchedulesShape["list"] = Effect.fn("BoardSchedules.list")(function* (input) {
    const all = yield* store.rows();
    const tasks = yield* listTasks;
    const byId = new Map(tasks.map((task) => [task.id as string, task]));
    // An export-linked task is still hand-made until an import adopts it.
    const rows = (yield* settleMissing(all, byId)).filter(
      (row) =>
        !row.tombstone &&
        !row.exportLinked &&
        (input.projectId === undefined || row.projectId === input.projectId),
    );
    const linked = boardLinked(all);
    return {
      schedules: yield* Effect.forEach(rows, (row) => toListRow(row, byId.get(row.taskId) ?? null)),
      handMade: handMadeOf(tasks, linked, input.projectId),
      serverEnvironmentId: deps.serverEnvironmentId,
      serverUtcOffsetMinutes: yield* deps.utcOffsetMinutes,
    };
  });

  const requireRow = (projectId: ProjectId, fileId: string) =>
    store.row(projectId, fileId).pipe(
      Effect.filterOrFail(
        (row): row is BoardScheduleStoreRow => row !== null && !row.tombstone,
        () => scheduleError(`No schedule '${fileId}' in this project.`),
      ),
      Effect.filterOrFail(
        (row) => !row.exportLinked,
        () =>
          scheduleError(
            `'${fileId}' is still a hand-made task; import t3o.json to schedule it from the board.`,
          ),
      ),
    );

  const setMachine: BoardSchedulesShape["setMachine"] = Effect.fn("BoardSchedules.setMachine")(
    function* (input) {
      const refusal = yield* placementRefusal(input.environmentId);
      if (refusal !== null) return yield* scheduleError(refusal);
      yield* withProjectLock(
        input.projectId,
        Effect.gen(function* () {
          const row = yield* requireRow(input.projectId, input.fileId);
          const placed = input.environmentId !== null;
          yield* save(row, {
            environmentId: input.environmentId,
            ...(placed && row.missing ? { missing: false, applied: null } : {}),
            lastError: null,
          });
          yield* reconcileUnlocked(input.projectId, new Set(), new Set([input.fileId]));
        }),
      );
      const row = yield* requireRow(input.projectId, input.fileId);
      const live = (yield* tasksById).get(row.taskId) ?? null;
      return yield* toListRow(row, live);
    },
  );

  const runNow: BoardSchedulesShape["runNow"] = Effect.fn("BoardSchedules.runNow")(
    function* (input) {
      const row = yield* requireRow(input.projectId, input.fileId);
      if (row.environmentId === null) return yield* scheduleError("Pick a machine first.");
      const ran = yield* deps.tasks
        .runNow(row.taskId)
        .pipe(Effect.mapError((error) => scheduleError(error.message, error)));
      if (ran.threadId === null && ran.task.lastRunStatus === "failed") {
        return yield* scheduleError(ran.task.lastRunError ?? "The run didn't start.");
      }
      return { threadId: ran.threadId };
    },
  );

  const failuresOf = (
    outcomes: ReadonlyMap<string, RowOutcome>,
    rows: ReadonlyArray<BoardScheduleStoreRow>,
  ): ReadonlyArray<BoardScheduleImportFailure> =>
    rows.flatMap((row) => {
      const outcome = outcomes.get(row.fileId);
      return outcome?.kind === "failed"
        ? [
            {
              fileId: row.fileId,
              title: row.definition.title,
              environmentId: row.environmentId,
              reason: outcome.reason,
            },
          ]
        : [];
    });

  const retry: BoardSchedulesShape["retry"] = Effect.fn("BoardSchedules.retry")(function* (input) {
    const only = new Set(input.fileIds);
    const outcomes = yield* withProjectLock(
      input.projectId,
      reconcileUnlocked(input.projectId, new Set(), only),
    );
    const rows = (yield* store.rows(input.projectId)).filter((row) => only.has(row.fileId));
    return {
      setUp: [...outcomes.values()].filter((outcome) => outcome.kind === "set-up").length,
      failures: failuresOf(outcomes, rows),
    };
  });

  const managedTasks: BoardSchedulesShape["managedTasks"] = Effect.fn(
    "BoardSchedules.managedTasks",
  )(function* () {
    const all = yield* store.rows();
    const tasks = yield* listTasks;
    const byId = new Map(tasks.map((task) => [task.id as string, task]));
    // An export-linked task still runs as hand-made, so upstream's own status is the truth.
    const rows = (yield* settleMissing(all, byId)).filter(
      (row) => !row.tombstone && !row.exportLinked,
    );
    const managed = yield* Effect.forEach(
      rows.filter((row) => byId.has(row.taskId)),
      (row) =>
        Effect.map(toListRow(row, byId.get(row.taskId)!), (listed) => ({
          environmentId: deps.serverEnvironmentId,
          taskId: row.taskId,
          projectId: row.projectId,
          fileId: row.fileId,
          targetEnvironmentId: row.environmentId,
          editedByHand: listed.editedByHand,
          lastResult: listed.lastResult,
        })),
    );
    return {
      tasks: managed,
      handMade: handMadeOf(tasks, boardLinked(all), undefined),
    };
  });

  const previewImport: BoardSchedulesShape["previewImport"] = Effect.fn(
    "BoardSchedules.previewImport",
  )(function* (projectId, schedules) {
    if (schedules === null) return { entries: [], warnings: [] };
    const rows = yield* store.rows(projectId);
    const byFile = new Map(rows.map((row) => [row.fileId, row]));
    const fileIds = new Set(schedules.map((schedule) => schedule.id));
    // An export-linked task is open to a title match unless its exported id is still in the file.
    const linked = boardLinked(yield* store.rows());
    for (const row of rows) {
      if (row.exportLinked && fileIds.has(row.fileId)) linked.add(row.taskId);
    }
    const tasks = yield* listTasks;
    const byId = new Map(tasks.map((task) => [task.id as string, task]));
    const adopted = new Set<string>();
    const entries: BoardScheduleImportEntry[] = [];
    const warnings: string[] = [];
    const base = (definition: T3oFileSchedule) => ({
      fileId: definition.id,
      title: definition.title,
      schedule: definition.schedule,
      enabled: definition.enabled,
      prompt: definition.prompt,
    });
    for (const definition of schedules) {
      const existing = byFile.get(definition.id);
      const exportedTask =
        existing?.exportLinked === true && !existing.tombstone
          ? (byId.get(existing.taskId) ?? null)
          : null;
      if (existing !== undefined && exportedTask !== null) {
        // An export linked this task; only importing it hands its runs to the board.
        adopted.add(exportedTask.id);
        entries.push({
          row: {
            ...base(definition),
            kind: "adopt",
            ...(exportedTask.prompt === definition.prompt
              ? {}
              : { previousPrompt: exportedTask.prompt }),
            currentEnvironmentId: deps.serverEnvironmentId,
            changes: adoptChanges(exportedTask, definition),
          },
          definition,
          existing,
          adoptTask: exportedTask,
        });
        continue;
      }
      if (existing !== undefined && !existing.tombstone && !existing.exportLinked) {
        if (sameDefinition(existing.definition, definition)) continue;
        const live = byId.get(existing.taskId) ?? null;
        const current =
          live === null
            ? (existing.applied ?? desiredFields(existing.definition))
            : appliedFromTask(live);
        entries.push({
          row: {
            ...base(definition),
            kind: "update",
            ...(current.prompt === definition.prompt ? {} : { previousPrompt: current.prompt }),
            currentEnvironmentId: existing.environmentId,
            changes: fieldChanges(current, definition, {
              pausedByHand: live !== null && !live.enabled && existing.applied?.enabled === true,
            }),
          },
          definition,
          existing,
          adoptTask: null,
        });
        continue;
      }
      const candidates = tasks.filter(
        (task) =>
          task.projectId === projectId &&
          !linked.has(task.id) &&
          !adopted.has(task.id) &&
          isAdoptable(task) &&
          task.title.trim() === definition.title,
      );
      if (candidates.length === 1) {
        const task = candidates[0]!;
        adopted.add(task.id);
        entries.push({
          row: {
            ...base(definition),
            kind: "adopt",
            ...(task.prompt === definition.prompt ? {} : { previousPrompt: task.prompt }),
            currentEnvironmentId: deps.serverEnvironmentId,
            changes: adoptChanges(task, definition),
          },
          definition,
          existing: existing ?? null,
          adoptTask: task,
        });
        continue;
      }
      if (candidates.length > 1) {
        warnings.push(
          `schedules ("${definition.id}"): ${candidates.length} hand-made tasks are titled "${definition.title}", so it is created new rather than adopting one.`,
        );
      }
      entries.push({
        row: { ...base(definition), kind: "create", changes: [] },
        definition,
        existing: existing ?? null,
        adoptTask: null,
      });
    }
    for (const row of rows) {
      // An export-linked row is still a hand-made task, which a file never deletes.
      if (row.tombstone || row.exportLinked || fileIds.has(row.fileId)) continue;
      entries.push({
        row: {
          fileId: row.fileId,
          kind: "delete",
          title: row.definition.title,
          schedule: row.definition.schedule,
          enabled: row.definition.enabled,
          prompt: row.definition.prompt,
          currentEnvironmentId: row.environmentId,
          changes: [],
        },
        definition: null,
        existing: row,
        adoptTask: null,
      });
    }
    entries.sort((a, b) => KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind]);
    return { entries, warnings };
  });

  const blankRow = (
    projectId: ProjectId,
    definition: T3oFileSchedule,
    taskId: ScheduledTaskId,
  ): BoardScheduleStoreRow => ({
    projectId,
    fileId: definition.id,
    definition,
    environmentId: null,
    taskId,
    applied: null,
    lastError: null,
    missing: false,
    tombstone: false,
    exportLinked: false,
    updatedAt: "",
  });

  const newTaskId = Effect.map(deps.uuid, (uuid) =>
    ScheduledTaskId.make(`scheduled-task:board:${uuid}`),
  );

  const applyImport: BoardSchedulesShape["applyImport"] = Effect.fn("BoardSchedules.applyImport")(
    function* (projectId, preview, placements) {
      if (preview.entries.length === 0) return { setUp: 0, stopped: 0, deleted: 0, failures: [] };
      return yield* withProjectLock(
        projectId,
        Effect.gen(function* () {
          const reassert = new Set<string>();
          const placementOf = (fileId: string) =>
            Object.hasOwn(placements, fileId) ? (placements[fileId] ?? null) : null;
          for (const entry of preview.entries) {
            const { row, definition, existing } = entry;
            const placement = placementOf(row.fileId);
            if (row.kind === "delete") {
              if (existing !== null) yield* save(existing, { tombstone: true });
              continue;
            }
            reassert.add(row.fileId);
            const def = definition!;
            if (row.kind === "adopt") {
              const task = entry.adoptTask!;
              // Exported under an id the file since renamed: that link gives way to this one.
              for (const stale of yield* store.rows(projectId)) {
                if (stale.exportLinked && stale.taskId === task.id && stale.fileId !== def.id) {
                  yield* store.remove(projectId, stale.fileId);
                }
              }
              yield* save(blankRow(projectId, def, task.id), {
                environmentId: placement,
                applied: appliedFromTask(task),
              });
              continue;
            }
            if (row.kind === "update" && existing !== null) {
              yield* save(existing, {
                definition: def,
                environmentId: placement,
                lastError: null,
                exportLinked: false,
                ...(placement !== null && existing.missing
                  ? { missing: false, applied: null }
                  : {}),
              });
              continue;
            }
            // A create; a returning tombstone keeps its task id so its old task is reused.
            const taskId = existing?.taskId ?? (yield* newTaskId);
            yield* save(blankRow(projectId, def, taskId), {
              environmentId: placement,
              ...(existing === null
                ? {}
                : {
                    applied: existing.tombstone || existing.exportLinked ? null : existing.applied,
                  }),
            });
          }
          const outcomes = yield* reconcileUnlocked(projectId, reassert);
          const rows = preview.entries.map((entry) => entry.row);
          const storeRows = yield* store.rows(projectId);
          return {
            setUp: rows.filter(
              (row) => row.kind !== "delete" && outcomes.get(row.fileId)?.kind === "set-up",
            ).length,
            stopped: rows.filter(
              (row) =>
                (row.kind === "update" || row.kind === "adopt") &&
                row.currentEnvironmentId != null &&
                placementOf(row.fileId) === null,
            ).length,
            deleted: rows.filter((row) => row.kind === "delete").length,
            failures: failuresOf(
              outcomes,
              storeRows.filter((stored) => rows.some((row) => row.fileId === stored.fileId)),
            ),
          };
        }),
      );
    },
  );

  const exportSchedules: BoardSchedulesShape["exportSchedules"] = Effect.fn(
    "BoardSchedules.exportSchedules",
  )(function* (projectId, options) {
    return yield* withProjectLock(
      projectId,
      Effect.gen(function* () {
        const rows = yield* store.rows(projectId);
        if (options.excludeHandMade) {
          // The tasks keep running, hand-made again.
          for (const row of rows) {
            if (row.exportLinked) yield* store.remove(row.projectId, row.fileId);
          }
          const kept = rows.filter((row) => !row.tombstone && !row.exportLinked);
          return {
            schedules: kept.length === 0 ? undefined : kept.map((row) => row.definition),
            handMade: [],
            warnings: [],
          };
        }
        // An earlier export's links are rebuilt from the live tasks under the same ids:
        // edits by hand are carried, and a task deleted or no longer exportable drops out.
        const previous = new Map(
          rows.filter((row) => row.exportLinked).map((row) => [row.taskId as string, row]),
        );
        const refreshed = new Set<string>();
        const linked = boardLinked(yield* store.rows());
        const tasks = yield* listTasks;
        const taken = new Set(rows.map((row) => row.fileId));
        const definitions = rows
          .filter((row) => !row.tombstone && !row.exportLinked)
          .map((row) => row.definition);
        const handMade: BoardScheduleExportedTask[] = [];
        const warnings: string[] = [];
        for (const task of tasks) {
          if (task.projectId !== projectId || linked.has(task.id)) continue;
          if (task.schedule.type === "webhook" || task.schedule.type === "once") continue;
          if (scheduledTaskThreadMode(task) !== "new_thread") {
            warnings.push(
              `"${task.title}" continues one conversation, which ${"t3o.json"} can't express; left out.`,
            );
            continue;
          }
          const when = fileScheduleOf(task);
          if (when === null) {
            warnings.push(`"${task.title}" runs more often than once a minute; left out.`);
            continue;
          }
          const id = previous.get(task.id)?.fileId ?? slugScheduleId(task.title, taken);
          taken.add(id);
          refreshed.add(id);
          const definition: T3oFileSchedule = {
            id,
            title: task.title,
            schedule: when,
            enabled: task.enabled,
            prompt: task.prompt,
          };
          // Linked, never rewritten: nothing is upserted until a confirmed import.
          yield* save(blankRow(projectId, definition, task.id), {
            environmentId: deps.serverEnvironmentId,
            applied: appliedFromTask(task),
            exportLinked: true,
          });
          definitions.push(definition);
          handMade.push({
            taskId: task.id,
            fileId: id,
            title: task.title,
            environmentId: deps.serverEnvironmentId,
          });
        }
        for (const row of previous.values()) {
          if (!refreshed.has(row.fileId)) yield* store.remove(row.projectId, row.fileId);
        }
        return {
          schedules: definitions.length === 0 ? undefined : definitions,
          handMade,
          warnings,
        };
      }),
    );
  });

  const retain: BoardSchedulesShape["retain"] = Effect.fn("BoardSchedules.retain")(
    function* (projectId, fileId) {
      const runs = yield* store.runs(projectId, fileId);
      const candidates = retentionCandidates(runs, yield* Clock.currentTimeMillis).filter(
        // A worker prunes its own runs.
        (run) => run.environmentId === deps.serverEnvironmentId,
      );
      if (candidates.length === 0) return;
      const project = (yield* deps.projects()).find((candidate) => candidate.id === projectId);
      if (project === undefined) return;
      for (const run of candidates) {
        const state = yield* deps.threadState(run.threadId);
        if (retentionKeeps(state, yield* store.threadTouchedCard(run.threadId))) continue;
        let worktreePath = run.worktreePath;
        if (worktreePath === null && run.launchError === null) {
          // Kept on the run before the thread goes, so a retry after a refused removal has it.
          const read = yield* Effect.result(deps.threadWorktree(run.threadId));
          if (read._tag === "Failure") continue;
          worktreePath =
            read.success ?? (state !== null && state !== "unknown" ? state.worktreePath : null);
          if (worktreePath !== null) yield* store.setRunWorktree(run.threadId, worktreePath);
        }
        if (state !== null && state !== "unknown" && !state.deleted) {
          const deleted = yield* Effect.result(deps.deleteThread(run.threadId));
          if (deleted._tag === "Failure") continue;
        }
        const removed = yield* deps.removeRunWorktree({
          project,
          worktreePath,
          branch: run.branch,
        });
        if (!removed) continue;
        yield* store.deleteRun(run.threadId);
      }
    },
    (effect, projectId, fileId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Schedule run retention failed", { projectId, fileId, cause }),
        ),
      ),
  );

  const skip = (message: string) => new BoardScheduleRunError({ message });

  /**
   * A run on a worker (T3O-118): the worker must be online, on protocol 6, ready for the
   * project with a checkout of it, and hold a signed-in provider for the model. The launch
   * is forked; the worker prunes the schedule's old runs before it, and the board forgets
   * the runs it confirms removed.
   */
  const runOnWorker = Effect.fn("BoardSchedules.runOnWorker")(function* (
    row: BoardScheduleStoreRow,
    workerId: EnvironmentId,
    task: ScheduledTask,
  ) {
    const workers = deps.workers;
    if (workers === undefined) {
      return yield* skip(
        `Skipped: ${yield* machineName(workerId)} isn't a machine this board can run schedules on.`,
      );
    }
    const modelSelection = yield* deps.modelFor(row.projectId);
    const target = yield* workers.target({ workerId, projectId: row.projectId, modelSelection });
    if (target.kind === "skip") return yield* skip(`Skipped: ${target.reason}`);
    const uuid = yield* deps.uuid;
    const threadId = ThreadId.make(`thread-schedule-${uuid}`);
    const branch = `${SCHEDULE_RUN_BRANCH_PREFIX}${uuid}`;
    yield* store
      .recordRun({
        threadId,
        projectId: row.projectId,
        fileId: row.fileId,
        environmentId: workerId,
        startedAt: yield* nowIso,
        launchError: null,
        branch,
      })
      .pipe(Effect.mapError((error) => skip(error.message)));
    const launch = Effect.gen(function* () {
      const candidates = retentionCandidates(
        yield* store.runs(row.projectId, row.fileId),
        yield* Clock.currentTimeMillis,
      ).filter((run) => run.environmentId === workerId && run.threadId !== threadId);
      const previousRuns = yield* Effect.forEach(candidates, (run) =>
        Effect.map(store.threadTouchedCard(run.threadId), (touchedCard) => ({
          threadId: run.threadId,
          branch: run.branch,
          touchedCard,
        })),
      );
      const launched = yield* Effect.result(
        workers.launch(workerId, {
          commandId: CommandId.make(`board-schedule:${uuid}`),
          threadId,
          workerProjectId: target.workerProjectId,
          title: task.title,
          prompt: task.prompt,
          modelSelection,
          branch,
          previousRuns,
        }),
      );
      if (launched._tag === "Failure") {
        const { message, agentCap } = launched.failure;
        yield* store.setLaunchError(
          threadId,
          agentCap ? `Skipped: ${target.label} at its agent limit` : message,
        );
        return;
      }
      const sent = new Set<string>(candidates.map((run) => run.threadId));
      for (const pruned of launched.success) {
        if (sent.has(pruned)) yield* store.deleteRun(pruned);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Schedule run launch on a worker failed", {
          projectId: row.projectId,
          fileId: row.fileId,
          workerId,
          cause,
        }),
      ),
    );
    yield* deps.retainInBackground ? Effect.forkDetach(launch) : launch;
    return null;
  });

  const run: BoardSchedulesShape["run"] = Effect.fn("BoardSchedules.run")(function* (task) {
    const row = yield* store
      .rowByTask(task.id)
      .pipe(Effect.mapError((error) => skip(error.message)));
    if (row === null || row.tombstone || row.environmentId === null || row.missing) {
      return yield* skip(SKIPPED_NOT_SCHEDULED);
    }
    const { latestRun, latestState } = yield* latestOf(row).pipe(
      Effect.mapError((error) => skip(error.message)),
    );
    if (
      previousRunStillGoing({
        run: latestRun,
        state: latestState,
        schedule: row.definition.schedule,
        nowMs: yield* Clock.currentTimeMillis,
      })
    ) {
      return yield* skip(SKIPPED_STILL_GOING);
    }
    if (row.environmentId !== deps.serverEnvironmentId) {
      return yield* runOnWorker(row, row.environmentId, task);
    }
    const uuid = yield* deps.uuid;
    const threadId = ThreadId.make(`thread-schedule-${uuid}`);
    // A name of the board's own, so retention deletes exactly this branch and nothing renames it.
    const branch = `${SCHEDULE_RUN_BRANCH_PREFIX}${uuid}`;
    // Recorded before anything launches, so a crash mid-launch still leaves the run.
    yield* store
      .recordRun({
        threadId,
        projectId: row.projectId,
        fileId: row.fileId,
        environmentId: row.environmentId,
        startedAt: yield* nowIso,
        launchError: null,
        branch,
      })
      .pipe(Effect.mapError((error) => skip(error.message)));
    const failLaunch = (message: string) =>
      store
        .setLaunchError(threadId, message)
        .pipe(Effect.ignore, Effect.andThen(Effect.fail(skip(message))));
    const baseRef = yield* deps.defaultBranch(row.projectId);
    if (baseRef === null) {
      return yield* failLaunch("Couldn't resolve the project's default branch.");
    }
    const launched = yield* deps
      .launch({
        // Fresh per run: a reused id with a stored receipt changes which thread comes back.
        commandId: CommandId.make(`board-schedule:${uuid}`),
        threadId,
        projectId: row.projectId,
        title: task.title,
        prompt: task.prompt,
        taskId: row.taskId,
        modelSelection: yield* deps.modelFor(row.projectId),
        baseRef,
        branch,
      })
      .pipe(Effect.catch((error) => failLaunch(error.message)));
    const retention = retain(row.projectId, row.fileId);
    yield* deps.retainInBackground ? Effect.forkDetach(retention) : retention;
    return launched;
  });

  return {
    list,
    setMachine,
    runNow,
    retry,
    managedTasks,
    reconcile,
    previewImport,
    placementRefusal,
    applyImport,
    exportSchedules,
    run,
    retain,
  } satisfies BoardSchedulesShape;
};
