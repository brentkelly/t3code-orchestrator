/**
 * T3o: the board's t3o.json schedules (T3O-117), as plain SQL beside upstream's
 * scheduled tasks. Every upstream task a row links lives on this server, wherever
 * its runs go.
 */
import {
  BoardScheduleError,
  T3oFileSchedule,
  type EnvironmentId,
  type ProjectId,
  type ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The file-owned task fields as the board last wrote them. The schedule is kept
    as stored upstream, which may be a legacy shape the file can't express. */
export interface BoardScheduleApplied {
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly schedule: unknown;
}

export interface BoardScheduleStoreRow {
  readonly projectId: ProjectId;
  readonly fileId: string;
  readonly definition: T3oFileSchedule;
  readonly environmentId: EnvironmentId | null;
  readonly taskId: ScheduledTaskId;
  readonly applied: BoardScheduleApplied | null;
  readonly lastError: string | null;
  readonly missing: boolean;
  /** The entry left the file; the row goes once its task is deleted. */
  readonly tombstone: boolean;
  /** A hand-made task the last export linked, until an import covers it. */
  readonly exportLinked: boolean;
  readonly updatedAt: string;
}

export interface BoardScheduleRun {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly fileId: string;
  readonly environmentId: EnvironmentId;
  readonly startedAt: string;
  readonly launchError: string | null;
}

export interface BoardScheduleStoreShape {
  /** Live rows and tombstones, of one project or all. */
  readonly rows: (
    projectId?: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BoardScheduleStoreRow>, BoardScheduleError>;
  readonly row: (
    projectId: ProjectId,
    fileId: string,
  ) => Effect.Effect<BoardScheduleStoreRow | null, BoardScheduleError>;
  readonly rowByTask: (
    taskId: string,
  ) => Effect.Effect<BoardScheduleStoreRow | null, BoardScheduleError>;
  /** Insert or replace a row whole. */
  readonly put: (row: BoardScheduleStoreRow) => Effect.Effect<void, BoardScheduleError>;
  readonly remove: (projectId: ProjectId, fileId: string) => Effect.Effect<void, BoardScheduleError>;
  readonly recordRun: (run: BoardScheduleRun) => Effect.Effect<void, BoardScheduleError>;
  readonly setLaunchError: (
    threadId: ThreadId,
    error: string,
  ) => Effect.Effect<void, BoardScheduleError>;
  /** A schedule's runs, newest first. */
  readonly runs: (
    projectId: ProjectId,
    fileId: string,
  ) => Effect.Effect<ReadonlyArray<BoardScheduleRun>, BoardScheduleError>;
  readonly runByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardScheduleRun | null, BoardScheduleError>;
  readonly deleteRun: (threadId: ThreadId) => Effect.Effect<void, BoardScheduleError>;
  readonly recordCreatedCard: (input: {
    readonly cardId: string;
    readonly projectId: ProjectId;
    readonly fileId: string;
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) => Effect.Effect<void, BoardScheduleError>;
  /** The cards a schedule's runs created, whichever run made them. */
  readonly createdCards: (
    projectId: ProjectId,
    fileId: string,
  ) => Effect.Effect<ReadonlySet<string>, BoardScheduleError>;
  /** Whether this run thread created or updated a card, which keeps it from retention. */
  readonly threadTouchedCard: (threadId: ThreadId) => Effect.Effect<boolean, BoardScheduleError>;
  readonly recordTouchedCard: (
    threadId: ThreadId,
    cardId: string,
  ) => Effect.Effect<void, BoardScheduleError>;
}

export class BoardScheduleStore extends Context.Service<
  BoardScheduleStore,
  BoardScheduleStoreShape
>()("t3/board/schedules/BoardScheduleStore") {}

const DefinitionJson = Schema.fromJsonString(T3oFileSchedule);
const decodeDefinition = Schema.decodeUnknownOption(DefinitionJson);
const encodeDefinition = Schema.encodeSync(DefinitionJson);

interface RowRecord {
  readonly project_id: string;
  readonly file_id: string;
  readonly definition_json: string;
  readonly environment_id: string | null;
  readonly task_id: string;
  readonly applied_json: string | null;
  readonly last_error: string | null;
  readonly missing: number;
  readonly tombstone: number;
  readonly export_linked: number;
  readonly updated_at: string;
}

interface RunRecord {
  readonly thread_id: string;
  readonly project_id: string;
  readonly file_id: string;
  readonly environment_id: string;
  readonly started_at: string;
  readonly launch_error: string | null;
}

const parseApplied = (json: string | null): BoardScheduleApplied | null => {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as BoardScheduleApplied;
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
};

const toRun = (record: RunRecord): BoardScheduleRun => ({
  threadId: record.thread_id as ThreadId,
  projectId: record.project_id as ProjectId,
  fileId: record.file_id,
  environmentId: record.environment_id as EnvironmentId,
  startedAt: record.started_at,
  launchError: record.launch_error,
});

export const BoardScheduleStoreLive = Layer.effect(
  BoardScheduleStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const failed = (what: string) => (cause: unknown) =>
      new BoardScheduleError({ message: `Couldn't ${what}.`, cause });

    const toRow = (record: RowRecord): Effect.Effect<BoardScheduleStoreRow | null> => {
      const definition = decodeDefinition(record.definition_json);
      if (Option.isNone(definition)) {
        return Effect.logWarning("Skipping an undecodable board schedule", {
          projectId: record.project_id,
          fileId: record.file_id,
        }).pipe(Effect.as(null));
      }
      return Effect.succeed({
        projectId: record.project_id as ProjectId,
        fileId: record.file_id,
        definition: definition.value,
        environmentId: record.environment_id as EnvironmentId | null,
        taskId: record.task_id as ScheduledTaskId,
        applied: parseApplied(record.applied_json),
        lastError: record.last_error,
        missing: record.missing === 1,
        tombstone: record.tombstone === 1,
        exportLinked: record.export_linked === 1,
        updatedAt: record.updated_at,
      });
    };
    const toRows = (records: ReadonlyArray<RowRecord>) =>
      Effect.forEach(records, toRow).pipe(
        Effect.map((rows) => rows.filter((row): row is BoardScheduleStoreRow => row !== null)),
      );

    const rows: BoardScheduleStoreShape["rows"] = (projectId) =>
      (projectId === undefined
        ? sql<RowRecord>`SELECT * FROM boards.project_schedules ORDER BY project_id, file_id`
        : sql<RowRecord>`
            SELECT * FROM boards.project_schedules WHERE project_id = ${projectId}
            ORDER BY file_id
          `
      ).pipe(Effect.mapError(failed("read the schedules")), Effect.flatMap(toRows));

    const firstRow = (records: ReadonlyArray<RowRecord>) =>
      records[0] === undefined ? Effect.succeed(null) : toRow(records[0]);

    const row: BoardScheduleStoreShape["row"] = (projectId, fileId) =>
      sql<RowRecord>`
        SELECT * FROM boards.project_schedules
        WHERE project_id = ${projectId} AND file_id = ${fileId}
      `.pipe(Effect.mapError(failed("read the schedule")), Effect.flatMap(firstRow));

    const rowByTask: BoardScheduleStoreShape["rowByTask"] = (taskId) =>
      sql<RowRecord>`SELECT * FROM boards.project_schedules WHERE task_id = ${taskId}`.pipe(
        Effect.mapError(failed("read the schedule")),
        Effect.flatMap(firstRow),
      );

    const put: BoardScheduleStoreShape["put"] = (value) =>
      sql`
        INSERT INTO boards.project_schedules (
          project_id, file_id, definition_json, environment_id, task_id, applied_json,
          last_error, missing, tombstone, export_linked, updated_at
        ) VALUES (
          ${value.projectId}, ${value.fileId}, ${encodeDefinition(value.definition)},
          ${value.environmentId}, ${value.taskId},
          ${value.applied === null ? null : JSON.stringify(value.applied)},
          ${value.lastError}, ${value.missing ? 1 : 0}, ${value.tombstone ? 1 : 0},
          ${value.exportLinked ? 1 : 0}, ${value.updatedAt}
        )
        ON CONFLICT (project_id, file_id) DO UPDATE SET
          definition_json = excluded.definition_json,
          environment_id = excluded.environment_id,
          task_id = excluded.task_id,
          applied_json = excluded.applied_json,
          last_error = excluded.last_error,
          missing = excluded.missing,
          tombstone = excluded.tombstone,
          export_linked = excluded.export_linked,
          updated_at = excluded.updated_at
      `.pipe(Effect.asVoid, Effect.mapError(failed("save the schedule")));

    const remove: BoardScheduleStoreShape["remove"] = (projectId, fileId) =>
      sql`
        DELETE FROM boards.project_schedules
        WHERE project_id = ${projectId} AND file_id = ${fileId}
      `.pipe(Effect.asVoid, Effect.mapError(failed("remove the schedule")));

    const recordRun: BoardScheduleStoreShape["recordRun"] = (run) =>
      sql`
        INSERT INTO boards.schedule_run_threads (
          thread_id, project_id, file_id, environment_id, started_at, launch_error
        ) VALUES (
          ${run.threadId}, ${run.projectId}, ${run.fileId}, ${run.environmentId},
          ${run.startedAt}, ${run.launchError}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failed("record the run")));

    const setLaunchError: BoardScheduleStoreShape["setLaunchError"] = (threadId, error) =>
      sql`
        UPDATE boards.schedule_run_threads SET launch_error = ${error} WHERE thread_id = ${threadId}
      `.pipe(Effect.asVoid, Effect.mapError(failed("record the launch failure")));

    const runs: BoardScheduleStoreShape["runs"] = (projectId, fileId) =>
      sql<RunRecord>`
        SELECT * FROM boards.schedule_run_threads
        WHERE project_id = ${projectId} AND file_id = ${fileId}
        ORDER BY started_at DESC, thread_id DESC
      `.pipe(
        Effect.map((records) => records.map(toRun)),
        Effect.mapError(failed("read the schedule's runs")),
      );

    const runByThread: BoardScheduleStoreShape["runByThread"] = (threadId) =>
      sql<RunRecord>`SELECT * FROM boards.schedule_run_threads WHERE thread_id = ${threadId}`.pipe(
        Effect.map((records) => (records[0] === undefined ? null : toRun(records[0]))),
        Effect.mapError(failed("read the run")),
      );

    const deleteRun: BoardScheduleStoreShape["deleteRun"] = (threadId) =>
      sql`DELETE FROM boards.schedule_run_threads WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(failed("forget the run")),
      );

    const recordCreatedCard: BoardScheduleStoreShape["recordCreatedCard"] = (input) =>
      sql`
        INSERT INTO boards.schedule_created_cards (card_id, project_id, file_id, thread_id, created_at)
        VALUES (${input.cardId}, ${input.projectId}, ${input.fileId}, ${input.threadId}, ${input.createdAt})
        ON CONFLICT (card_id) DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(failed("record the schedule's card")));

    const createdCards: BoardScheduleStoreShape["createdCards"] = (projectId, fileId) =>
      sql<{ readonly card_id: string }>`
        SELECT card_id FROM boards.schedule_created_cards
        WHERE project_id = ${projectId} AND file_id = ${fileId}
      `.pipe(
        Effect.map((records) => new Set(records.map((record) => record.card_id))),
        Effect.mapError(failed("read the schedule's cards")),
      );

    // A card the thread updated is recorded beside the ones it created, keyed by the thread,
    // so retention keeps the thread either way.
    const recordTouchedCard: BoardScheduleStoreShape["recordTouchedCard"] = (threadId, cardId) =>
      sql`
        INSERT INTO boards.schedule_touched_cards (thread_id, card_id) VALUES (${threadId}, ${cardId})
        ON CONFLICT DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(failed("record the card the run touched")));

    const threadTouchedCard: BoardScheduleStoreShape["threadTouchedCard"] = (threadId) =>
      sql<{ readonly n: number }>`
        SELECT
          (SELECT COUNT(*) FROM boards.schedule_created_cards WHERE thread_id = ${threadId}) +
          (SELECT COUNT(*) FROM boards.schedule_touched_cards WHERE thread_id = ${threadId}) AS n
      `.pipe(
        Effect.map((records) => (records[0]?.n ?? 0) > 0),
        Effect.mapError(failed("read whether the run touched a card")),
      );

    return {
      rows,
      row,
      rowByTask,
      put,
      remove,
      recordRun,
      setLaunchError,
      runs,
      runByThread,
      deleteRun,
      recordCreatedCard,
      createdCards,
      threadTouchedCard,
      recordTouchedCard,
    } satisfies BoardScheduleStoreShape;
  }),
);
