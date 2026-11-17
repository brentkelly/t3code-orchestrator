/**
 * T3o: the pure decisions behind t3o.json schedules (T3O-117): what changed, what a
 * schedule's last result is, whether a run still overlaps, and which runs retention drops.
 */
import {
  describeScheduleWhen,
  scheduledTaskThreadMode,
  type BoardScheduleImportChange,
  type BoardScheduleLastResult,
  type BoardScheduleWhen,
  type ScheduledTask,
  type T3oFileSchedule,
  ThreadId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import type { BoardThreadState, UnknownThreadState } from "../ThreadGateway.ts";
import type { BoardScheduleApplied, BoardScheduleRun } from "./BoardScheduleStore.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Upstream skips a fixed-time run delayed past this. */
const MISSED_GRACE_MS = 10 * MINUTE_MS;
const RETENTION_KEEP_RECENT = 3;
const RETENTION_WINDOW_MS = 7 * DAY_MS;
/** A frequent interval schedule keeps no more runs than this, however recent. */
const RETENTION_KEEP_MAX = 20;
const OVERLAP_CAP_MS = 6 * HOUR_MS;
/** How long a run with no thread yet and no launch error counts as still launching. */
const LAUNCH_GRACE_MS = 5 * MINUTE_MS;

/** Every schedule run's branch starts so; a worker prunes no other branch for a board. */
const SCHEDULE_RUN_BRANCH_PREFIX = "t3o/schedule-run-";
const SCHEDULE_RUN_THREAD_PREFIX = "thread-schedule-";

/** A run's thread id and branch share one UUID, so either names the other. */
export const scheduleRunThreadId = (uuid: string) =>
  ThreadId.make(`${SCHEDULE_RUN_THREAD_PREFIX}${uuid}`);
export const scheduleRunBranch = (uuid: string) => `${SCHEDULE_RUN_BRANCH_PREFIX}${uuid}`;
/** The only branch a run with this thread id may have, or null when it isn't a run's thread. */
export const scheduleRunBranchOf = (threadId: ThreadId): string | null =>
  threadId.startsWith(SCHEDULE_RUN_THREAD_PREFIX)
    ? scheduleRunBranch(threadId.slice(SCHEDULE_RUN_THREAD_PREFIX.length))
    : null;

export const SKIPPED_NOT_SCHEDULED = "Skipped: not scheduled";
export const SKIPPED_STILL_GOING = "Skipped: previous run still going";
export const SKIPPED_PROJECT_DELETED = "Skipped: the project was deleted";

/** The task fields the file owns, as the board would write them. */
export const desiredFields = (definition: T3oFileSchedule): BoardScheduleApplied => ({
  title: definition.title,
  prompt: definition.prompt,
  enabled: definition.enabled,
  schedule: definition.schedule,
});

export const appliedFromTask = (task: ScheduledTask): BoardScheduleApplied => ({
  title: task.title,
  prompt: task.prompt,
  enabled: task.enabled,
  schedule: task.schedule,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** One key per schedule as upstream compares them: padded hours and an
    every-day weekday list are the same schedule. */
export function scheduleKey(schedule: unknown): string {
  if (!isRecord(schedule)) return "?";
  if (schedule.type === "interval") return `interval:${String(schedule.everyMs)}`;
  if (schedule.type === "fixed_time" && typeof schedule.timeOfDay === "string") {
    const [hours = "", minutes = ""] = schedule.timeOfDay.trim().split(":");
    const weekdays = Array.isArray(schedule.weekdays)
      ? [...new Set(schedule.weekdays as ReadonlyArray<number>)].toSorted((a, b) => a - b)
      : [];
    const days = weekdays.length === 0 || weekdays.length === 7 ? "daily" : weekdays.join(",");
    return `fixed:${Number(hours)}:${minutes}:${days}`;
  }
  return JSON.stringify(schedule);
}

export const sameFields = (a: BoardScheduleApplied, b: BoardScheduleApplied): boolean =>
  a.title === b.title &&
  a.prompt === b.prompt &&
  a.enabled === b.enabled &&
  scheduleKey(a.schedule) === scheduleKey(b.schedule);

export const sameDefinition = (a: T3oFileSchedule, b: T3oFileSchedule): boolean =>
  a.id === b.id && sameFields(desiredFields(a), desiredFields(b));

/** Only interval and fixed-time tasks with a new thread each run fit the file. */
export function fileScheduleOf(task: ScheduledTask): BoardScheduleWhen | null {
  if (task.schedule.type === "interval") {
    return task.schedule.everyMs >= MINUTE_MS ? task.schedule : null;
  }
  if (task.schedule.type === "fixed_time") return task.schedule;
  return null;
}

export const isAdoptable = (task: ScheduledTask): boolean =>
  task.schedule.type === "interval" || task.schedule.type === "fixed_time";

const whenText = (schedule: unknown): string => {
  if (!isRecord(schedule)) return "unknown";
  if (schedule.type === "interval" || schedule.type === "fixed_time") {
    return describeScheduleWhen(schedule as BoardScheduleWhen);
  }
  return String(schedule.type);
};

const wordCount = (text: string) => text.split(/\s+/).filter((word) => word.length > 0).length;

/** Lines added and removed from `before` to `after`, by longest common subsequence. */
export function lineDiffCounts(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const common = lengths[0]![0]!;
  return { added: b.length - common, removed: a.length - common };
}

const promptChange = (before: string, after: string): BoardScheduleImportChange => {
  const { added, removed } = lineDiffCounts(before, after);
  return {
    label: "Prompt",
    from: `${wordCount(before)} words`,
    to: `${wordCount(after)} words · ${added} line${added === 1 ? "" : "s"} added, ${removed} removed`,
  };
};

const enabledText = (enabled: boolean) => (enabled ? "Runs" : "Paused");

/** What importing `definition` changes on a task now carrying `live` fields. */
export function fieldChanges(
  live: BoardScheduleApplied,
  definition: T3oFileSchedule,
  options: { readonly pausedByHand: boolean },
): ReadonlyArray<BoardScheduleImportChange> {
  const changes: BoardScheduleImportChange[] = [];
  if (live.title !== definition.title) {
    changes.push({ label: "Title", from: live.title, to: definition.title });
  }
  if (scheduleKey(live.schedule) !== scheduleKey(definition.schedule)) {
    changes.push({
      label: "Schedule",
      from: whenText(live.schedule),
      to: describeScheduleWhen(definition.schedule),
    });
  }
  if (live.prompt !== definition.prompt) changes.push(promptChange(live.prompt, definition.prompt));
  if (live.enabled !== definition.enabled) {
    changes.push(
      options.pausedByHand && definition.enabled
        ? { label: "Enabled", from: "Paused by hand", to: "Resumes (paused by hand)" }
        : {
            label: "Enabled",
            from: enabledText(live.enabled),
            to: enabledText(definition.enabled),
          },
    );
  }
  return changes;
}

const workspaceText = (strategy: ScheduledTask["workspaceStrategy"]) =>
  strategy.type === "root"
    ? "project folder"
    : strategy.type === "existing_worktree"
      ? `worktree ${strategy.worktreePath}`
      : `fresh worktree off ${strategy.startFromOrigin === true ? "origin/" : ""}${strategy.baseRef}`;

/**
 * An adoption's changes: the file and the board's run settings against the live
 * task on every field, so taking a task over can't quietly raise its privileges.
 */
export function adoptChanges(
  task: ScheduledTask,
  definition: T3oFileSchedule,
): ReadonlyArray<BoardScheduleImportChange> {
  const changes = [...fieldChanges(appliedFromTask(task), definition, { pausedByHand: false })];
  if (task.runtimeMode !== "full-access") {
    changes.push({ label: "Access", from: task.runtimeMode, to: "full access" });
  }
  if (task.interactionMode !== "default") {
    changes.push({ label: "Mode", from: task.interactionMode, to: "default" });
  }
  const threadMode = scheduledTaskThreadMode(task);
  if (threadMode !== "new_thread") {
    changes.push({
      label: "Thread",
      from:
        task.threadId === null
          ? `${threadMode === "continue" ? "continues" : "reuses"} its first thread`
          : `${threadMode === "continue" ? "continues" : "reuses"} thread ${task.threadId}`,
      to: "a new thread each run",
    });
  }
  const strategy = task.workspaceStrategy;
  if (strategy.type !== "worktree" || strategy.startFromOrigin !== true) {
    changes.push({
      label: "Workspace",
      from: workspaceText(strategy),
      to: "fresh worktree off origin",
    });
  }
  return changes;
}

/** The file id export gives a hand-made task: its title slugged, `-2`, `-3` on a collision. */
export function slugScheduleId(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56)
      .replace(/-+$/g, "") || "schedule";
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The latest due time of a fixed-time schedule at or before `now`, in `now`'s zone
    (the server's, as upstream fires them), or null for any other schedule. */
export function previousFixedTimeDue(schedule: unknown, now: DateTime.DateTime): number | null {
  if (!isRecord(schedule) || schedule.type !== "fixed_time") return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(schedule.timeOfDay).trim());
  if (match === null) return null;
  const weekdays =
    Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays as ReadonlyArray<number>)
      : null;
  const nowMs = DateTime.toEpochMillis(now);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.subtract(now, { days: offset }), {
      hour: Number(match[1]),
      minute: Number(match[2]),
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) > nowMs) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return DateTime.toEpochMillis(candidate);
  }
  return null;
}

type RunState = BoardThreadState | UnknownThreadState | null;

const isLiveState = (state: RunState): state is BoardThreadState =>
  state !== null && typeof state === "object" && !state.deleted;

const awaitingHuman = (state: BoardThreadState) =>
  state.awaitingUserInput || state.awaitingPermission;

/** The cap past which a run that still looks busy no longer holds the next one back. */
const overlapCapMs = (schedule: unknown): number =>
  isRecord(schedule) && schedule.type === "interval" && typeof schedule.everyMs === "number"
    ? 2 * schedule.everyMs
    : OVERLAP_CAP_MS;

/** Whether the previous run is still actively turning, or still launching (recorded with no
    thread yet). A run awaiting a human, one whose state is unknown, and one past the cap all
    count as settled, so none can skip every tick. */
export function previousRunStillGoing(input: {
  readonly run: BoardScheduleRun | undefined;
  readonly state: RunState;
  readonly schedule: unknown;
  readonly nowMs: number;
}): boolean {
  const { run, state } = input;
  if (run === undefined || run.launchError !== null) return false;
  const age = input.nowMs - Date.parse(run.startedAt);
  if (state === null) return age < LAUNCH_GRACE_MS;
  if (!isLiveState(state)) return false;
  if (state.activeTurnRef === null || awaitingHuman(state)) return false;
  return age < overlapCapMs(input.schedule);
}

/** Runs past the newest three that are older than seven days or past the newest twenty, the
    ones retention may drop. */
export function retentionCandidates(
  runs: ReadonlyArray<BoardScheduleRun>,
  nowMs: number,
): ReadonlyArray<BoardScheduleRun> {
  const newestFirst = runs.toSorted((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return newestFirst
    .filter(
      (run, index) =>
        index >= RETENTION_KEEP_MAX ||
        (index >= RETENTION_KEEP_RECENT &&
          nowMs - Date.parse(run.startedAt) > RETENTION_WINDOW_MS),
    )
    .filter((run) => !run.workspaceRemoved);
}

/**
 * Whether retention must leave a run alone whatever its age. A settled run that touched a card
 * keeps its thread but still loses its worktree and branch.
 */
export const retentionKeeps = (state: RunState): boolean =>
  state === "unknown" ||
  (isLiveState(state) && (state.activeTurnRef !== null || awaitingHuman(state)));

const result = (
  kind: BoardScheduleLastResult["kind"],
  at: string | null,
  extra: { readonly threadId?: ThreadId; readonly detail?: string } = {},
): BoardScheduleLastResult => ({
  kind,
  at,
  threadId: extra.threadId ?? null,
  detail: extra.detail ?? null,
});

/**
 * The schedule's last result, worked out when read from its latest run, its timer
 * and its last reconcile, so nothing is lost across restarts.
 */
export function deriveLastResult(input: {
  readonly lastError: string | null;
  readonly scheduled: boolean;
  readonly task: ScheduledTask | null;
  /** When the board last changed the schedule's row: its definition, machine or adoption. */
  readonly rowUpdatedAt: string;
  readonly latestRun: BoardScheduleRun | undefined;
  readonly latestState: RunState;
  readonly now: DateTime.DateTime;
}): BoardScheduleLastResult {
  const { task, latestRun } = input;
  const nowMs = DateTime.toEpochMillis(input.now);
  if (input.lastError !== null) return result("schedule-failed", null, { detail: input.lastError });
  const runAt = latestRun === undefined ? null : Date.parse(latestRun.startedAt);
  if (task !== null && input.scheduled && task.enabled) {
    const due = previousFixedTimeDue(task.schedule, input.now);
    const lastRunAt = task.lastRunAt === null ? null : Date.parse(task.lastRunAt);
    if (
      due !== null &&
      nowMs - due > MISSED_GRACE_MS &&
      Date.parse(task.createdAt) < due &&
      // A schedule changed, resumed or placed after its due time never owed that run.
      Date.parse(input.rowUpdatedAt) < due &&
      (lastRunAt === null || lastRunAt < due) &&
      (runAt === null || runAt < due)
    ) {
      return result("missed", DateTime.formatIso(DateTime.makeUnsafe(due)), {
        detail: "Missed (server was off)",
      });
    }
  }
  if (
    task !== null &&
    task.lastRunStatus === "failed" &&
    task.lastRunAt !== null &&
    (runAt === null || Date.parse(task.lastRunAt) > runAt)
  ) {
    const reason = task.lastRunError ?? "The run failed.";
    return result(reason.startsWith("Skipped") ? "skipped" : "failed-to-start", task.lastRunAt, {
      detail: reason,
    });
  }
  if (latestRun === undefined) {
    return task?.lastRunStatus === "running"
      ? result("running", task.lastRunAt)
      : result("never", null);
  }
  if (latestRun.launchError !== null) {
    // A worker that couldn't take the run (its agent cap) skipped it, as a timer skip does.
    const kind = latestRun.launchError.startsWith("Skipped") ? "skipped" : "failed-to-start";
    return result(kind, latestRun.startedAt, {
      threadId: latestRun.threadId,
      detail: latestRun.launchError,
    });
  }
  const state = input.latestState;
  const at = latestRun.startedAt;
  const threadId = latestRun.threadId;
  if (state === "unknown") return result("unknown", at, { threadId });
  if (state === null) return result("unknown", at, { threadId });
  if (state.deleted) return result("ran", at, { threadId });
  if (awaitingHuman(state)) return result("waiting", at, { threadId });
  if (state.activeTurnRef !== null) return result("running", at, { threadId });
  return result("ran", at, { threadId });
}
