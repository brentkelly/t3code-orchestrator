import {
  BOARD_SEED_STAGES,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  EMPTY_BOARD_STATE,
  withBoardProjectConfigVersion,
  EnvironmentId,
  type BoardCiStep,
  type BoardScheduleImportRow,
  type BoardScheduleRow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCiParallelBlock,
  boardCiSharedWorktreeWarnings,
  boardImportFooterText,
  boardImportPrimaryLabel,
  boardImportResultToast,
  boardImportScheduleChips,
  boardImportScheduleReason,
  boardImportScheduleSummary,
  boardImportScheduleVerdict,
  boardImportSummaryChips,
  boardPromptLineDiff,
  boardScheduleLastResultView,
  boardScheduleNeedsAttention,
  boardScheduleRelative,
  boardScheduleWhenText,
  formatBoardUtcOffset,
  orderBoardImportSchedules,
  revealBoardPromptInvisibles,
  boardProjectOverrideEdit,
  boardProjectPlanReviewOverrideEdit,
  boardProjectStageState,
  moveBoardCiStep,
  removeBoardCiStep,
} from "./boardProjectSettings.logic";

const script = (id: string, parallel = false): BoardCiStep => ({
  kind: "script",
  id,
  name: id,
  parallel,
  command: id,
  timeoutMinutes: 30,
});
const agent = (id: string): BoardCiStep => ({
  kind: "agent",
  id,
  name: id,
  parallel: false,
  prompt: id,
  model: null,
  timeoutMinutes: 30,
});

describe("the CI step editor", () => {
  it("allows parallel only on a script after a script", () => {
    const steps = [script("a"), script("b"), agent("c"), script("d")];
    expect(boardCiParallelBlock(steps, 0)).toContain("first step");
    expect(boardCiParallelBlock(steps, 1)).toBeNull();
    expect(boardCiParallelBlock(steps, 2)).toContain("run on their own");
    expect(boardCiParallelBlock(steps, 3)).toContain("run on their own");
  });

  it("clears a parallel flag a move or removal breaks", () => {
    const steps = [script("a"), script("b", true), agent("c")];
    expect(moveBoardCiStep(steps, 1, 0).map((step) => [step.id, step.parallel])).toEqual([
      ["b", false],
      ["a", false],
      ["c", false],
    ]);
    expect(moveBoardCiStep(steps, 0, 2).map((step) => [step.id, step.parallel])).toEqual([
      ["b", false],
      ["c", false],
      ["a", false],
    ]);
    expect(removeBoardCiStep([agent("x"), ...steps.slice(1)], 0)[0]).toMatchObject({
      id: "b",
      parallel: false,
    });
  });

  it("warns once per group of scripts sharing a worktree", () => {
    expect(
      boardCiSharedWorktreeWarnings([
        script("a"),
        script("b", true),
        script("c", true),
        script("d"),
      ]),
    ).toEqual([{ firstIndex: 0, names: ["a", "b", "c"] }]);
  });
});

describe("the Pipeline tab", () => {
  const stage = (id: string) => BOARD_SEED_STAGES.find((candidate) => candidate.stageId === id)!;

  it("locks role stages and the stage before build, and marks switches against the default", () => {
    expect(boardProjectStageState(EMPTY_BOARD_STATE, stage("review"), {}).kind).toBe("always-on");
    expect(boardProjectStageState(EMPTY_BOARD_STATE, stage("ready"), {}).kind).toBe("always-on");
    expect(boardProjectStageState(EMPTY_BOARD_STATE, stage("sprint"), { sprint: false })).toEqual({
      kind: "switchable",
      on: false,
      defaultOn: true,
      switched: true,
    });
    expect(boardProjectStageState(EMPTY_BOARD_STATE, stage("ci"), {})).toMatchObject({
      on: false,
      switched: false,
    });
  });
});

describe("a stage override edit", () => {
  it("keeps the stage's prompt override and waits for the full delta to load", () => {
    const full = withBoardProjectConfigVersion({
      ...EMPTY_BOARD_PROJECT_STAGE_CONFIG,
      overrides: { building: { autoExecute: true, prompt: "Ours." } },
    });
    expect(boardProjectOverrideEdit(null, "building", "autoExecute", false)).toBeNull();
    expect(boardProjectOverrideEdit(full, "building", "autoExecute", false)).toEqual({
      patch: { autoExecute: false, prompt: "Ours." },
      expectedConfigVersion: full.version,
    });
    expect(
      boardProjectOverrideEdit(
        withBoardProjectConfigVersion({
          ...EMPTY_BOARD_PROJECT_STAGE_CONFIG,
          overrides: { building: { autoExecute: true } },
        }),
        "building",
        "autoExecute",
        undefined,
      )?.patch,
    ).toBeNull();
  });
});

describe("import summary chips", () => {
  it("counts stages, CI steps, overrides and ignored entries", () => {
    expect(
      boardImportSummaryChips({
        delta: {
          stageSwitches: { qa: true, ci: true },
          overrides: { review: { rounds: 3 }, building: { prompt: "x" } },
          ci: { steps: [script("a"), script("b"), script("c")] },
          warnings: ["stages.review.round isn't a known setting"],
        },
        createStages: [{ stageId: "qa" as never, label: "QA" }],
        texts: [],
      }),
    ).toEqual(["+1 stage", "1 stage switch", "CI · 3 steps", "2 overrides", "1 ignored entry"]);
  });
});

describe("a plan review override edit", () => {
  it("sets and resets one new-card key, keeping the rest and dropping emptied levels", () => {
    const full = withBoardProjectConfigVersion({
      ...EMPTY_BOARD_PROJECT_STAGE_CONFIG,
      overrides: { planning: { prompt: "Ours.", planReview: { newCards: { rounds: 5 } } } },
    });
    expect(boardProjectPlanReviewOverrideEdit(full, "planning", "unattended", true)?.patch).toEqual(
      { prompt: "Ours.", planReview: { newCards: { rounds: 5, unattended: true } } },
    );
    expect(
      boardProjectPlanReviewOverrideEdit(full, "planning", "rounds", undefined)?.patch,
    ).toEqual({ prompt: "Ours." });
  });
});

describe("t3o.json schedules (T3O-117)", () => {
  const server = EnvironmentId.make("env-server");
  const row = (
    fileId: string,
    kind: BoardScheduleImportRow["kind"],
    current: EnvironmentId | null = null,
  ): BoardScheduleImportRow => ({
    fileId,
    kind,
    title: fileId,
    schedule: { type: "fixed_time", timeOfDay: "02:00" },
    enabled: true,
    prompt: "Run it.",
    currentEnvironmentId: current,
    changes: [],
  });
  const label = (environmentId: EnvironmentId | null) =>
    environmentId === null ? "Not scheduled" : "This server";
  const rows = [
    row("soak", "delete", server),
    row("bench", "create"),
    row("sweep", "adopt", server),
    row("nightly", "update", server),
  ];

  it("orders Updates, Adopts, Creates, then deletions", () => {
    expect(orderBoardImportSchedules(rows).map((entry) => entry.kind)).toEqual([
      "update",
      "adopt",
      "create",
      "delete",
    ]);
  });

  it.each([
    [{}, "Import and stop 2", "No schedules will run · 2 will stop", "None scheduled"],
    [
      { bench: server },
      "Import and schedule 1, stop 2",
      "1 of 3 schedules will run · 2 will stop",
      "1 will run",
    ],
    [
      { bench: server, sweep: server, nightly: server },
      "Import and schedule 3",
      "3 of 3 schedules will run",
      "3 will run",
    ],
  ] as const)("labels the import for placements %j", (placements, primary, footer, live) => {
    const summary = boardImportScheduleSummary(rows, placements);
    expect(boardImportPrimaryLabel(summary)).toBe(primary);
    expect(boardImportFooterText(summary)).toBe(footer);
    expect(boardImportScheduleChips(summary)).toEqual({
      counts: ["3 schedules", "1 removed"],
      live,
    });
  });

  it("reads Replace and import with nothing to place, stop or delete", () => {
    const summary = boardImportScheduleSummary([row("bench", "create")], {});
    expect(boardImportPrimaryLabel(summary)).toBe("Replace and import");
  });

  it("warns in amber when anything runs, and lists each stop and deletion", () => {
    const verdict = boardImportScheduleVerdict({
      summary: boardImportScheduleSummary(rows, { bench: server }),
      placements: { bench: server },
      projectTitle: "mesh",
      machineLabel: label,
    });
    expect(verdict.tone).toBe("warning");
    expect(verdict.text).toBe(
      "1 schedule will run unattended, with full access to the machine: 'bench' on This server.",
    );
    expect(verdict.stops).toHaveLength(2);
    expect(verdict.stops[0]).toContain("With no machine picked, it stops running there.");
    expect(verdict.deletes).toEqual(["'soak' is deleted from This server."]);
    const none = boardImportScheduleVerdict({
      summary: boardImportScheduleSummary(rows, {}),
      placements: {},
      projectTitle: "mesh",
      machineLabel: label,
    });
    expect(none.tone).toBe("neutral");
    expect(none.text).toContain("Nothing will be scheduled.");
  });

  it("gives each schedule its Import tab reason", () => {
    expect(
      boardImportScheduleReason({
        ...row("nightly", "update"),
        changes: [
          { label: "Schedule", from: "Daily at 02:00", to: "Daily at 01:30" },
          { label: "Prompt", from: "", to: "" },
        ],
      }),
    ).toBe("'nightly': schedule: Daily at 02:00 → Daily at 01:30; prompt changed");
    expect(boardImportScheduleReason(row("sweep", "adopt"))).toContain(
      "takes over the hand-made task",
    );
  });

  it("adds the server clock to a time of day, never to an interval", () => {
    expect(boardScheduleWhenText({ type: "fixed_time", timeOfDay: "02:00" }, 60)).toBe(
      "Daily at 02:00, server time (UTC+1)",
    );
    expect(boardScheduleWhenText({ type: "interval", everyMs: 1_800_000 }, 60)).toBe(
      "Every 30 min",
    );
    expect([0, -330, 600].map(formatBoardUtcOffset)).toEqual(["UTC", "UTC-5:30", "UTC+10"]);
  });

  it("diffs a changed prompt by line", () => {
    expect(boardPromptLineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });

  it("shows zero-width and bidi characters", () => {
    expect(revealBoardPromptInvisibles("a\u200Bb\u202Ec")).toBe(
      "a\u27e8U+200B\u27e9b\u27e8U+202E\u27e9c",
    );
  });

  const scheduleRow = (
    lastResult: BoardScheduleRow["lastResult"],
    extra: Partial<BoardScheduleRow> = {},
  ) => ({ lastResult, missing: false, lastError: null, environmentId: server, ...extra });
  const result = (kind: BoardScheduleRow["lastResult"]["kind"], detail: string | null = null) => ({
    kind,
    at: null,
    threadId: null,
    detail,
  });

  it.each([
    [result("ran"), "neutral", "Ran"],
    [result("running"), "running", "Running on This server"],
    [result("waiting"), "attention", "Waiting on you"],
    [result("never"), "muted", "Not run yet"],
    [result("failed-to-start"), "warning", "Failed to start"],
    [
      result("skipped", "Skipped: previous run still going"),
      "warning",
      "Skipped: previous run still going",
    ],
    [result("missed"), "warning", "Missed (server was off)"],
    [
      result("schedule-failed", "refused"),
      "warning",
      "Couldn't be scheduled on This server: refused",
    ],
  ] as const)("shows %j with tone %s, never green", (lastResult, tone, text) => {
    expect(boardScheduleLastResultView(scheduleRow(lastResult), "This server", 0)).toEqual({
      tone,
      text,
    });
  });

  it("calls out a task deleted by hand, and flags the amber results", () => {
    const missing = scheduleRow(result("ran"), { missing: true });
    expect(boardScheduleLastResultView(missing, null, 0).text).toBe(
      "Stopped: its task was deleted by hand",
    );
    expect(boardScheduleNeedsAttention(missing)).toBe(true);
    expect(boardScheduleNeedsAttention(scheduleRow(result("missed")))).toBe(true);
    expect(boardScheduleNeedsAttention(scheduleRow(result("ran")))).toBe(false);
  });

  it("counts down to the next run in minutes", () => {
    expect(boardScheduleRelative(new Date(438 * 60_000).toISOString(), 0)).toBe("in 7 h 18 min");
    expect(boardScheduleRelative(new Date(3 * 60_000).toISOString(), 0)).toBe("in 3 min");
  });

  it("writes the result toast for success, one failure and several", () => {
    const base = { setUp: 2, stopped: 0, deleted: 1 };
    const failure = (title: string) => ({
      fileId: title,
      title,
      environmentId: server,
      reason: "it went offline",
    });
    expect(
      boardImportResultToast({
        projectTitle: "mesh",
        outcome: { ...base, failures: [] },
        machineLabel: label,
      }),
    ).toEqual({
      title: "Imported mesh's t3o.json.",
      description: "2 schedules set up · 1 schedule deleted.",
      failed: false,
    });
    const one = boardImportResultToast({
      projectTitle: "mesh",
      outcome: { ...base, failures: [failure("Weekly")] },
      machineLabel: label,
    });
    expect(one.failed).toBe(true);
    expect(one.title).toBe("Imported; 1 schedule failed on This server: it went offline");
    expect(one.description).toContain("'Weekly' is listed as Not scheduled.");
    expect(
      boardImportResultToast({
        projectTitle: "mesh",
        outcome: { ...base, failures: [failure("A"), failure("B")] },
        machineLabel: label,
      }).title,
    ).toBe("Imported; 2 schedules failed.");
  });
});
