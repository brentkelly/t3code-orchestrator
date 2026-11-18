/** The pure decisions behind t3o.json schedules (T3O-117). */
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { deletedThreadState, type BoardThreadState } from "../ThreadGateway.ts";
import type { BoardScheduleRun } from "./BoardScheduleStore.ts";
import {
  deriveLastResult,
  lineDiffCounts,
  previousFixedTimeDue,
  previousRunStillGoing,
  retentionCandidates,
  scheduleKey,
  slugScheduleId,
} from "./scheduleLogic.ts";

const projectId = ProjectId.make("project-a");
const HOUR = 60 * 60 * 1000;
/** A Monday, 12:00 UTC. */
const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const now = (ms = NOW) => DateTime.makeZonedUnsafe(ms, { timeZone: "UTC" });
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const run = (startedAt: number, launchError: string | null = null): BoardScheduleRun => ({
  threadId: ThreadId.make("thread-run"),
  projectId,
  fileId: "nightly",
  environmentId: EnvironmentId.make("env-board"),
  startedAt: iso(startedAt),
  launchError,
  branch: null,
  worktreePath: null,
  workspaceRemoved: false,
});

const state = (over: Partial<BoardThreadState> = {}): BoardThreadState => ({
  ...deletedThreadState(ThreadId.make("thread-run"), projectId),
  deleted: false,
  ...over,
});

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: ScheduledTaskId.make("task-1"),
  title: "Nightly",
  prompt: "Run.",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "02:00" },
  projectId,
  threadId: null,
  threadMode: "new_thread",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "system",
  creationSource: "server",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...over,
});

describe("previousRunStillGoing", () => {
  const turning = state({ activeTurnRef: "turn-1" });
  it.each([
    ["an active turn under the cap", turning, NOW - HOUR, undefined, true],
    ["an active turn past the 6 hour cap", turning, NOW - 7 * HOUR, undefined, false],
    [
      "an interval run past twice its interval",
      turning,
      NOW - 61 * 60_000,
      { type: "interval", everyMs: 30 * 60_000 },
      false,
    ],
    [
      "a run awaiting a human",
      state({ activeTurnRef: "turn-1", awaitingUserInput: true }),
      NOW - HOUR,
      undefined,
      false,
    ],
    ["a settled run", state(), NOW - HOUR, undefined, false],
    ["a run whose state is unknown", "unknown" as const, NOW - HOUR, undefined, false],
    ["a run still launching, with no thread yet", null, NOW - 60_000, undefined, true],
    ["a run whose thread never appeared", null, NOW - HOUR, undefined, false],
  ] as const)("%s → %s", (_name, current, startedAt, schedule, going) => {
    assert.strictEqual(
      previousRunStillGoing({
        run: run(startedAt),
        state: current,
        schedule: schedule ?? { type: "fixed_time", timeOfDay: "02:00" },
        nowMs: NOW,
      }),
      going,
    );
  });
});

describe("previousFixedTimeDue", () => {
  it("is the latest due time at or before now, on the schedule's weekdays", () => {
    assert.strictEqual(
      previousFixedTimeDue({ type: "fixed_time", timeOfDay: "02:00" }, now()),
      Date.parse("2026-03-02T02:00:00.000Z"),
    );
    // Monday noon: the last Thursday 06:30 was four days ago.
    assert.strictEqual(
      previousFixedTimeDue({ type: "fixed_time", timeOfDay: "6:30", weekdays: [4] }, now()),
      Date.parse("2026-02-26T06:30:00.000Z"),
    );
    assert.isNull(previousFixedTimeDue({ type: "interval", everyMs: HOUR }, now()));
  });
});

describe("deriveLastResult", () => {
  const base = {
    lastError: null,
    scheduled: true,
    rowUpdatedAt: "2026-02-01T00:00:00.000Z",
    latestRun: undefined,
    latestState: null,
    now: now(),
  };

  it("reports a fixed-time run the server missed while it was off", () => {
    const result = deriveLastResult({
      ...base,
      task: task({ lastRunAt: "2026-03-01T02:00:05.000Z", lastRunStatus: "succeeded" }),
      latestRun: run(Date.parse("2026-03-01T02:00:06.000Z")),
      latestState: state(),
    });
    assert.strictEqual(result.kind, "missed");
    assert.strictEqual(result.at, "2026-03-02T02:00:00.000Z");
  });

  it("isn't missed inside upstream's grace, nor for a task made or a schedule changed after the due time", () => {
    const justDue = deriveLastResult({
      ...base,
      task: task(),
      now: now(Date.parse("2026-03-02T02:05:00.000Z")),
    });
    assert.strictEqual(justDue.kind, "never");
    const newer = deriveLastResult({
      ...base,
      task: task({ createdAt: "2026-03-02T03:00:00.000Z" }),
    });
    assert.strictEqual(newer.kind, "never");
    // Changed, resumed or placed after the due time: upstream's own reschedule bumps the
    // task's updatedAt too, so only the board row's time tells the two apart.
    const changed = deriveLastResult({
      ...base,
      rowUpdatedAt: "2026-03-02T03:00:00.000Z",
      task: task(),
    });
    assert.strictEqual(changed.kind, "never");
  });

  it.each([
    ["a settled run", state(), "ran"],
    ["a turning run", state({ activeTurnRef: "turn-1" }), "running"],
    ["a run waiting on a human", state({ awaitingPermission: true }), "waiting"],
    ["a run on a machine that can't be reached", "unknown" as const, "unknown"],
  ] as const)("reads %s as %s", (_name, latestState, kind) => {
    const result = deriveLastResult({
      ...base,
      task: task({ schedule: { type: "interval", everyMs: HOUR } }),
      latestRun: run(NOW - HOUR),
      latestState,
    });
    assert.strictEqual(result.kind, kind);
    assert.strictEqual(result.threadId, "thread-run");
  });

  it("shows upstream's failed reason when it is newer than the latest run", () => {
    const skipped = deriveLastResult({
      ...base,
      task: task({
        schedule: { type: "interval", everyMs: HOUR },
        lastRunAt: iso(NOW - 10 * 60_000),
        lastRunStatus: "failed",
        lastRunError: "Skipped: previous run still going",
      }),
      latestRun: run(NOW - HOUR),
      latestState: state({ activeTurnRef: "turn-1" }),
    });
    assert.deepStrictEqual(
      [skipped.kind, skipped.detail],
      ["skipped", "Skipped: previous run still going"],
    );
    const failedToStart = deriveLastResult({
      ...base,
      task: task({ schedule: { type: "interval", everyMs: HOUR } }),
      latestRun: run(NOW - HOUR, "No such base ref."),
    });
    assert.strictEqual(failedToStart.kind, "failed-to-start");
    const notSetUp = deriveLastResult({
      ...base,
      lastError: "Policy refused full access.",
      task: null,
    });
    assert.strictEqual(notSetUp.kind, "schedule-failed");
  });
});

describe("retentionCandidates", () => {
  it("drops runs past the newest twenty even inside the seven-day window", () => {
    const runs = Array.from({ length: 25 }, (_, index) => ({
      ...run(NOW - index * HOUR),
      threadId: ThreadId.make(`run-${index}`),
    }));
    assert.deepStrictEqual(
      retentionCandidates(runs, NOW).map((candidate) => candidate.threadId),
      ["run-20", "run-21", "run-22", "run-23", "run-24"],
    );
  });
});

describe("helpers", () => {
  it("slugs an export id from the title, numbering collisions", () => {
    assert.strictEqual(
      slugScheduleId("Weekly changelog draft", new Set()),
      "weekly-changelog-draft",
    );
    assert.strictEqual(
      slugScheduleId("Weekly changelog draft!", new Set(["weekly-changelog-draft"])),
      "weekly-changelog-draft-2",
    );
    assert.strictEqual(slugScheduleId("🙂", new Set()), "schedule");
  });

  it("compares schedules the way upstream does", () => {
    assert.strictEqual(
      scheduleKey({ type: "fixed_time", timeOfDay: "2:00", weekdays: [] }),
      scheduleKey({ type: "fixed_time", timeOfDay: "02:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }),
    );
    assert.notStrictEqual(
      scheduleKey({ type: "fixed_time", timeOfDay: "02:00", weekdays: [1] }),
      scheduleKey({ type: "fixed_time", timeOfDay: "02:00" }),
    );
  });

  it("counts a prompt's added and removed lines", () => {
    assert.deepStrictEqual(lineDiffCounts("a\nb\nc", "a\nc\nd\ne"), { added: 2, removed: 1 });
  });
});
