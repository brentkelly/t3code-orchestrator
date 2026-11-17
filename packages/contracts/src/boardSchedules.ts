/**
 * T3o: schedules declared in a project's `t3o.json` (T3O-117). Shapes mirror
 * `scheduledTask.ts`'s rather than import them: that module reaches `board.ts`,
 * which imports this one. A test holds them to upstream's upsert schema.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const BOARD_SCHEDULE_MIN_INTERVAL_MS = 60_000;

const BoardScheduleTimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
);

export const BoardScheduleWhen = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(BOARD_SCHEDULE_MIN_INTERVAL_MS)),
  }),
  Schema.Struct({
    type: Schema.Literal("fixed_time"),
    timeOfDay: BoardScheduleTimeOfDay,
    weekdays: Schema.optional(
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
    ),
  }),
]);
export type BoardScheduleWhen = typeof BoardScheduleWhen.Type;

/** One entry of the file's `schedules` block, after decoding. */
export const T3oFileSchedule = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  schedule: BoardScheduleWhen,
  enabled: Schema.Boolean,
  prompt: TrimmedNonEmptyString,
});
export type T3oFileSchedule = typeof T3oFileSchedule.Type;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** Monday first, as people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const padTime = (timeOfDay: string) => {
  const [hours = "0", minutes = "00"] = timeOfDay.split(":");
  return `${hours.padStart(2, "0")}:${minutes}`;
};

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : `${count} ${many}`;

/**
 * The readable "when": "Every 30 min", "Daily at 02:00", "Weekdays at 04:00",
 * "Mon, Thu at 06:30". The UI adds the machine-time suffix.
 */
export function describeScheduleWhen(schedule: BoardScheduleWhen): string {
  if (schedule.type === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % 1440 === 0) return `Every ${plural(minutes / 1440, "day", "days")}`;
    if (minutes % 60 === 0) return `Every ${plural(minutes / 60, "hour", "hours")}`;
    if (minutes > 60) return `Every ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    return `Every ${minutes} min`;
  }
  const at = padTime(schedule.timeOfDay);
  // Upstream runs an empty list every day, like an absent one.
  const days = [...new Set(schedule.weekdays ?? [])];
  if (days.length === 7 || days.length === 0) return `Daily at ${at}`;
  const sorted = WEEKDAY_ORDER.filter((day) => days.includes(day));
  if (sorted.length === 5 && sorted.every((day) => day >= 1 && day <= 5)) {
    return `Weekdays at ${at}`;
  }
  if (sorted.length === 2 && sorted.includes(0) && sorted.includes(6)) return `Weekends at ${at}`;
  return `${sorted.map((day) => WEEKDAY_NAMES[day]).join(", ")} at ${at}`;
}

// ── Import preview ────────────────────────────────────────────────────

export const BoardScheduleImportKind = Schema.Literals(["create", "update", "adopt", "delete"]);
export type BoardScheduleImportKind = typeof BoardScheduleImportKind.Type;

/** One field an update or adoption changes, as `label  from → to`. */
export const BoardScheduleImportChange = Schema.Struct({
  label: TrimmedNonEmptyString,
  from: Schema.String,
  to: Schema.String,
});
export type BoardScheduleImportChange = typeof BoardScheduleImportChange.Type;

/** One schedule an import changes. Unchanged schedules are not listed. */
export const BoardScheduleImportRow = Schema.Struct({
  fileId: TrimmedNonEmptyString,
  kind: BoardScheduleImportKind,
  title: TrimmedNonEmptyString,
  schedule: BoardScheduleWhen,
  enabled: Schema.Boolean,
  /** The file's prompt; for a deletion, the stored one. */
  prompt: Schema.String,
  /** The prompt this replaces, when it changes. */
  previousPrompt: Schema.optional(Schema.String),
  /** Where it runs today: an update's placement, or an adopted task's machine. */
  currentEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
  changes: Schema.Array(BoardScheduleImportChange),
});
export type BoardScheduleImportRow = typeof BoardScheduleImportRow.Type;

export const BoardScheduleImportFailure = Schema.Struct({
  fileId: TrimmedNonEmptyString,
  title: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
  reason: Schema.String,
});
export type BoardScheduleImportFailure = typeof BoardScheduleImportFailure.Type;

export const BoardScheduleImportOutcome = Schema.Struct({
  setUp: NonNegativeInt,
  stopped: NonNegativeInt,
  deleted: NonNegativeInt,
  failures: Schema.Array(BoardScheduleImportFailure),
});
export type BoardScheduleImportOutcome = typeof BoardScheduleImportOutcome.Type;

/** A hand-made task an export linked into the file. */
export const BoardScheduleExportedTask = Schema.Struct({
  taskId: ScheduledTaskId,
  fileId: TrimmedNonEmptyString,
  title: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
});
export type BoardScheduleExportedTask = typeof BoardScheduleExportedTask.Type;

// ── Schedules tab ─────────────────────────────────────────────────────

/**
 * A schedule's last result, worked out when read from its latest run and its
 * timer. `ran` is neutral: a finished turn can't be told apart as a success.
 * `failed-to-start`, `skipped`, `missed` and `schedule-failed` are amber.
 */
export const BoardScheduleLastResultKind = Schema.Literals([
  "never",
  "running",
  "waiting",
  "ran",
  "unknown",
  "failed-to-start",
  "skipped",
  "missed",
  "schedule-failed",
]);
export type BoardScheduleLastResultKind = typeof BoardScheduleLastResultKind.Type;

export const BoardScheduleLastResult = Schema.Struct({
  kind: BoardScheduleLastResultKind,
  at: Schema.NullOr(IsoDateTime),
  threadId: Schema.NullOr(ThreadId),
  /** The reason, for the amber kinds. */
  detail: Schema.NullOr(Schema.String),
});
export type BoardScheduleLastResult = typeof BoardScheduleLastResult.Type;

export const BOARD_SCHEDULE_AMBER_RESULTS: ReadonlySet<BoardScheduleLastResultKind> = new Set([
  "failed-to-start",
  "skipped",
  "missed",
  "schedule-failed",
]);

export const BoardScheduleRow = Schema.Struct({
  projectId: ProjectId,
  fileId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  schedule: BoardScheduleWhen,
  enabled: Schema.Boolean,
  prompt: Schema.String,
  /** Where runs go; null is Not scheduled. */
  environmentId: Schema.NullOr(EnvironmentId),
  taskId: ScheduledTaskId,
  /** Its task was deleted by hand, which stopped it. */
  missing: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  /** The live timer differs from what the board last wrote. */
  editedByHand: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  running: Schema.Boolean,
  lastResult: BoardScheduleLastResult,
});
export type BoardScheduleRow = typeof BoardScheduleRow.Type;

/** A project's scheduled task the file doesn't manage. */
export const BoardScheduleHandMadeTask = Schema.Struct({
  taskId: ScheduledTaskId,
  projectId: ProjectId,
  title: Schema.String,
  /** Null for a task the file can't express (webhook, once, or continuing a thread). */
  schedule: Schema.NullOr(BoardScheduleWhen),
  environmentId: EnvironmentId,
});
export type BoardScheduleHandMadeTask = typeof BoardScheduleHandMadeTask.Type;

export const BoardScheduleListInput = Schema.Struct({
  /** Omitted: every project, for the projects list's chips. */
  projectId: Schema.optional(ProjectId),
});
export type BoardScheduleListInput = typeof BoardScheduleListInput.Type;

export const BoardScheduleListResult = Schema.Struct({
  schedules: Schema.Array(BoardScheduleRow),
  handMade: Schema.Array(BoardScheduleHandMadeTask),
  /** "This server": every schedule's timer lives here, whatever its machine. */
  serverEnvironmentId: EnvironmentId,
  /** The board server's clock, which every `fixed_time` follows. */
  serverUtcOffsetMinutes: Schema.Int,
});
export type BoardScheduleListResult = typeof BoardScheduleListResult.Type;

export const BoardScheduleRef = Schema.Struct({
  projectId: ProjectId,
  fileId: TrimmedNonEmptyString,
});
export type BoardScheduleRef = typeof BoardScheduleRef.Type;

export const BoardScheduleSetMachineInput = Schema.Struct({
  projectId: ProjectId,
  fileId: TrimmedNonEmptyString,
  environmentId: Schema.NullOr(EnvironmentId),
});
export type BoardScheduleSetMachineInput = typeof BoardScheduleSetMachineInput.Type;

export const BoardScheduleRetryInput = Schema.Struct({
  projectId: ProjectId,
  fileIds: Schema.Array(TrimmedNonEmptyString),
});
export type BoardScheduleRetryInput = typeof BoardScheduleRetryInput.Type;

export const BoardScheduleRetryResult = Schema.Struct({
  setUp: NonNegativeInt,
  failures: Schema.Array(BoardScheduleImportFailure),
});
export type BoardScheduleRetryResult = typeof BoardScheduleRetryResult.Type;

export const BoardScheduleRunNowResult = Schema.Struct({
  /** The run's thread, when it launched here. */
  threadId: Schema.NullOr(ThreadId),
});
export type BoardScheduleRunNowResult = typeof BoardScheduleRunNowResult.Type;

/** An upstream task the board manages, for the Scheduled tasks page's marker. */
export const BoardScheduleManagedTask = Schema.Struct({
  environmentId: EnvironmentId,
  taskId: ScheduledTaskId,
  projectId: ProjectId,
  fileId: TrimmedNonEmptyString,
  /** Where runs go; null is Not scheduled. */
  targetEnvironmentId: Schema.NullOr(EnvironmentId),
  editedByHand: Schema.Boolean,
  lastResult: BoardScheduleLastResult,
});
export type BoardScheduleManagedTask = typeof BoardScheduleManagedTask.Type;

export const BoardScheduleManagedTasksResult = Schema.Struct({
  tasks: Schema.Array(BoardScheduleManagedTask),
  /** Project scheduled tasks no file manages; Export brings them into the file. */
  handMade: Schema.Array(BoardScheduleHandMadeTask),
});
export type BoardScheduleManagedTasksResult = typeof BoardScheduleManagedTasksResult.Type;

export class BoardScheduleError extends Schema.TaggedError<BoardScheduleError>()(
  "BoardScheduleError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const BOARD_SCHEDULE_WS_METHODS = {
  list: "board.schedules.list",
  setMachine: "board.schedules.setMachine",
  runNow: "board.schedules.runNow",
  retry: "board.schedules.retry",
  managedTasks: "board.schedules.managedTasks",
} as const;

export const BOARD_SCHEDULE_RPCS = [
  Rpc.make(BOARD_SCHEDULE_WS_METHODS.list, {
    payload: BoardScheduleListInput,
    success: BoardScheduleListResult,
    error: Schema.Union([BoardScheduleError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_SCHEDULE_WS_METHODS.setMachine, {
    payload: BoardScheduleSetMachineInput,
    success: BoardScheduleRow,
    error: Schema.Union([BoardScheduleError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_SCHEDULE_WS_METHODS.runNow, {
    payload: BoardScheduleRef,
    success: BoardScheduleRunNowResult,
    error: Schema.Union([BoardScheduleError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_SCHEDULE_WS_METHODS.retry, {
    payload: BoardScheduleRetryInput,
    success: BoardScheduleRetryResult,
    error: Schema.Union([BoardScheduleError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(BOARD_SCHEDULE_WS_METHODS.managedTasks, {
    payload: Schema.Struct({}),
    success: BoardScheduleManagedTasksResult,
    error: Schema.Union([BoardScheduleError, EnvironmentAuthorizationError]),
  }),
] as const;

/** Spread into `BOARD_RPC_SCOPES`. Moving or running an unattended full-access
    agent is a board write; an import that places one checks the same scope. */
export const BOARD_SCHEDULE_RPC_SCOPES = {
  [BOARD_SCHEDULE_WS_METHODS.list]: AuthOrchestrationReadScope,
  [BOARD_SCHEDULE_WS_METHODS.managedTasks]: AuthOrchestrationReadScope,
  [BOARD_SCHEDULE_WS_METHODS.setMachine]: AuthOrchestrationOperateScope,
  [BOARD_SCHEDULE_WS_METHODS.runNow]: AuthOrchestrationOperateScope,
  [BOARD_SCHEDULE_WS_METHODS.retry]: AuthOrchestrationOperateScope,
} as const;
