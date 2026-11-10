import {
  BOARD_CI_STOPPED_BY_YOU_REASON,
  type BoardCardCi,
  type BoardCardCiStep,
  type BoardCiPass,
  type BoardCiPassStep,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCiFace,
  boardCiLastOutcomeFace,
  boardCiPaneHeadline,
  boardCiPaneStatus,
  boardCiPassOutcomeChip,
  boardCiSegments,
  boardCiSentBackBanner,
  boardCiLogFileName,
  boardCiProgressFraction,
  boardCiSilenceLabel,
  boardCiStepLimit,
  boardCiTailMeta,
  formatBoardCiDuration,
  formatBoardCiTimer,
} from "./boardCi";

const NOW_MS = Date.parse("2026-01-01T00:10:00.000Z");

const step = (
  name: string,
  status: BoardCardCiStep["status"],
  startedAt: string | null = null,
): BoardCardCiStep => ({ name, status, startedAt, finishedAt: null });

const ci = (overrides: Partial<BoardCardCi>): BoardCardCi => ({
  runId: "run-1",
  entry: 1,
  fixAttempts: 0,
  maxFixAttempts: 2,
  phase: "running",
  steps: [],
  ...overrides,
});

describe("boardCiSegments", () => {
  it("colours a failure blue while it is being fixed and amber once it is terminal", () => {
    const steps = [
      step("Typecheck", "passed"),
      step("Lint", "failed"),
      step("Test", "pending"),
      step("Build", "cancelled"),
    ];
    expect(boardCiSegments(ci({ phase: "fixing", steps })).map((s) => s.state)).toEqual([
      "passed",
      "fixing",
      "pending",
      "cancelled",
    ]);
    expect(boardCiSegments(ci({ phase: "running", steps }))[1]?.state).toBe("failed");
    expect(boardCiSegments(ci({ steps: [step("Test", "timed-out")] }))[0]?.state).toBe("failed");
  });
});

describe("boardCiFace", () => {
  it("names the running step with whole elapsed minutes", () => {
    const face = boardCiFace(
      ci({
        steps: [
          step("Typecheck", "passed"),
          step("Lint", "running", "2026-01-01T00:06:30.000Z"),
          step("Test", "pending"),
        ],
      }),
      NOW_MS,
    );
    expect(face.chip).toEqual({ label: "Running", tone: "info" });
    expect(face.count).toBe("1/3");
    expect(face.detail).toBe("Lint · 3m");
  });

  it("shows a running script's progress instead of its timer (T3O-60)", () => {
    const progress = { message: "Running unit tests", at: "2026-01-01T00:09:00.000Z" };
    const running = (extra: Partial<BoardCardCiStep>) =>
      boardCiFace(
        ci({ steps: [{ ...step("Test", "running", "2026-01-01T00:06:30.000Z"), ...extra }] }),
        NOW_MS,
      ).detail;
    expect(running({ progress: { ...progress, done: 128, total: 212 } })).toBe("Test · 128 / 212");
    expect(running({ progress: { ...progress, done: null, total: null } })).toBe(
      "Test · Running unit tests",
    );
    // A line with nothing showable falls back to the timer.
    expect(running({ progress: { ...progress, message: null, done: null, total: null } })).toBe(
      "Test · 3m",
    );
  });

  it("says under a minute for a step that just started", () => {
    const face = boardCiFace(
      ci({ steps: [step("Lint", "running", "2026-01-01T00:09:30.000Z")] }),
      NOW_MS,
    );
    expect(face.detail).toBe("Lint · under 1m");
  });

  it("counts the fix attempt while fixing", () => {
    const face = boardCiFace(
      ci({
        phase: "fixing",
        fixAttempts: 1,
        steps: [step("Typecheck", "passed"), step("Check", "failed"), step("Test", "pending")],
      }),
      NOW_MS,
    );
    expect(face.chip).toEqual({ label: "Fixing", tone: "info" });
    expect(face.detail).toBe("Check failed · fix 1 of 2");
  });

  it("is a violet Needs you chip when CI stopped for a human, and amber when it can't run", () => {
    const stopped = boardCiFace(
      ci({
        phase: "stopped",
        stopReason: "CI failed at Test after 3 round trips to review.",
        steps: [step("Test", "failed")],
      }),
      NOW_MS,
    );
    expect(stopped.chip).toEqual({ label: "Needs you", tone: "attention" });
    expect(stopped.detail).toBe("CI failed at Test after 3 round trips to review.");
    const held = boardCiFace(ci({ phase: "held", steps: [step("Test", "cancelled")] }), NOW_MS);
    expect(held.chip).toEqual({ label: "Can't run", tone: "warning" });
    expect(held.detail).toBe("CI couldn't finish this pass");
    // T3O-59: a held pass says why, and a machine problem says so.
    const machine = boardCiFace(
      ci({
        phase: "held",
        stopReason: "Disk nearly full on z5: 0.4 GiB free. Retry CI, or Skip CI.",
        machine: true,
        steps: [step("Test", "cancelled")],
      }),
      NOW_MS,
    );
    expect(machine.chip).toEqual({ label: "Machine problem", tone: "warning" });
    expect(machine.detail).toBe("Disk nearly full on z5: 0.4 GiB free. Retry CI, or Skip CI.");
    const stoppedByYou = boardCiFace(
      ci({
        phase: "held",
        stopReason: BOARD_CI_STOPPED_BY_YOU_REASON,
        steps: [step("Test", "cancelled")],
      }),
      NOW_MS,
    );
    expect(stoppedByYou.chip).toEqual({ label: "Stopped", tone: "warning" });
  });

  it("T3O-61: a failed, fixing or held pass says what failed and why; held is amber", () => {
    const headline = {
      what: "panel → lint",
      why: "No files matching the pattern",
      machine: false,
      logLine: 4,
      logOffset: 80,
      source: "pattern" as const,
    };
    const steps = [step("panel", "failed")];
    const failed = boardCiFace(ci({ phase: "running", headline, steps }), NOW_MS);
    expect(failed.detail).toBe("panel → lint: No files matching the pattern");
    expect(failed.detailTone).toBeUndefined();
    const fixing = boardCiFace(ci({ phase: "fixing", fixAttempts: 1, headline, steps }), NOW_MS);
    expect(fixing.detail).toBe("fix 1 of 2 · panel → lint: No files matching the pattern");
    const held = boardCiFace(
      ci({
        phase: "held",
        machine: true,
        stopReason: "Machine problem on box: Missing system library: libnspr4.so. Then Retry CI.",
        headline: { ...headline, what: "panel", why: "Missing system library: libnspr4.so" },
        steps,
      }),
      NOW_MS,
    );
    expect(held.chip).toEqual({ label: "Machine problem", tone: "warning" });
    expect(held.detail).toBe("panel: Missing system library: libnspr4.so");
    expect(held.detailTone).toBe("warning");
    expect(held.tooltip).toContain("Then Retry CI.");
    const heldForAnotherReason = boardCiFace(
      ci({ phase: "held", stopReason: "The CI result was lost.", headline, steps }),
      NOW_MS,
    );
    expect(heldForAnotherReason.detail).toBe("The CI result was lost.");
  });

  it("is a neutral Queued chip while waiting for a slot", () => {
    const face = boardCiFace(ci({ phase: "queued", steps: [step("Check", "pending")] }), NOW_MS);
    expect(face.chip).toEqual({ label: "Queued", tone: "neutral" });
    expect(face.count).toBe("0/1");
  });
});

describe("boardCiLastOutcomeFace", () => {
  it("says which step sent the card back and how many fixes it used, outside CI only", () => {
    const outcome = { kind: "sent-back", stepName: "Test", fixAttemptsUsed: 2 } as const;
    expect(boardCiLastOutcomeFace({ inCi: false, outcome })).toMatchObject({
      kind: "sent-back",
      line: "Test still failing after 2 fix attempts",
    });
    expect(boardCiLastOutcomeFace({ inCi: true, outcome })).toBeNull();
    expect(
      boardCiLastOutcomeFace({
        inCi: false,
        outcome: { kind: "sent-back", stepName: "Test", fixAttemptsUsed: 0 },
      }),
    ).toMatchObject({ line: "Test failed" });
  });

  it("names who skipped CI", () => {
    expect(
      boardCiLastOutcomeFace({ inCi: false, outcome: { kind: "skipped", actor: "Brent" } }),
    ).toMatchObject({ kind: "skipped", label: "CI skipped by Brent" });
  });
});

describe("boardCiSentBackBanner", () => {
  it("carries the finding and the fixes used, and nothing for a skip", () => {
    expect(
      boardCiSentBackBanner({
        inCi: false,
        outcome: {
          kind: "sent-back",
          stepName: "Check",
          fixAttemptsUsed: 1,
          finding: "The migration test needs a real fix.",
        },
      }),
    ).toEqual({
      title: "Sent back from CI · Check still failing after 1 fix attempt",
      reason: "The migration test needs a real fix.",
      meta: "1 fix attempt used · the failure is a must-fix finding in this review round",
    });
    expect(
      boardCiSentBackBanner({ inCi: false, outcome: { kind: "skipped", actor: "Brent" } }),
    ).toBeNull();
  });
});

describe("pass and pane status", () => {
  it("labels a finished pass by its outcome and the live pass by the entry's phase", () => {
    expect(boardCiPassOutcomeChip({ runId: "a", outcome: "fixed-in-place" }, null)).toEqual({
      label: "Fixed in place",
      tone: "neutral",
    });
    expect(
      boardCiPassOutcomeChip({ runId: "a", outcome: null }, { runId: "a", phase: "fixing" }),
    ).toEqual({ label: "Fixing", tone: "info" });
  });

  it("reads the step in flight, the fix, or how the card left", () => {
    expect(
      boardCiPaneStatus({
        ci: ci({ steps: [step("A", "passed"), step("B", "running")] }),
        lastOutcome: null,
        lastPass: undefined,
      }),
    ).toEqual({ label: "Step 2 of 2", tone: "info" });
    expect(
      boardCiPaneStatus({
        ci: ci({ phase: "fixing", steps: [step("Check", "failed")] }),
        lastOutcome: null,
        lastPass: undefined,
      }),
    ).toEqual({ label: "Fixing Check", tone: "info" });
    expect(
      boardCiPaneStatus({
        ci: null,
        lastOutcome: { kind: "sent-back" },
        lastPass: { outcome: "sent-back" },
      }),
    ).toEqual({ label: "Sent back to review", tone: "neutral" });
  });
});

describe("formatting", () => {
  it("formats durations, timers and the tail header", () => {
    expect(formatBoardCiDuration(46_000)).toBe("46s");
    expect(formatBoardCiDuration(124_000)).toBe("2m 04s");
    expect(formatBoardCiTimer(14_900)).toBe("0:14");
    expect(formatBoardCiTimer(72_000)).toBe("1:12");
    expect(boardCiTailMeta("a\nb\n")).toBe("Output tail · last 200 lines (2 captured)");
  });

  it("reads a step's time against its limit, its silence, progress and log file name (T3O-60)", () => {
    const startedAt = "2026-01-01T00:00:00.000Z";
    expect(boardCiStepLimit({ startedAt, timeoutMinutes: 60 }, NOW_MS)).toEqual({
      elapsed: 10,
      limit: 60,
      over: false,
    });
    expect(boardCiStepLimit({ startedAt, timeoutMinutes: 5 }, NOW_MS).over).toBe(true);
    expect(boardCiSilenceLabel("2026-01-01T00:02:00.000Z", NOW_MS)).toBe("No output for 8 min");
    expect(boardCiSilenceLabel(undefined, NOW_MS)).toBeNull();
    expect(boardCiProgressFraction({ done: 53, total: 212 })).toBe(0.25);
    expect(boardCiProgressFraction({ done: 300, total: 212 })).toBe(1);
    expect(boardCiProgressFraction({ done: 3, total: 0 })).toBeNull();
    expect(boardCiLogFileName("T3-185", "Unit tests (web)", 2)).toBe(
      "T3-185-unit-tests-web-pass2.log",
    );
  });
});

describe("boardCiPaneHeadline", () => {
  const headline = {
    what: "panel",
    why: "Missing system library: libnspr4.so",
    machine: true,
    logLine: 3,
    logOffset: 90,
    source: "machine" as const,
  };
  const passStep = (status: BoardCiPassStep["status"], extra: Partial<BoardCiPassStep> = {}) =>
    ({
      name: "panel",
      command: "./ci.sh",
      timeoutMinutes: 30,
      status,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      tail: "",
      ...extra,
    }) satisfies BoardCiPassStep;
  const pass = (steps: ReadonlyArray<BoardCiPassStep>) => ({ steps }) as unknown as BoardCiPass;

  it("heads with the first failing step that has one, by its index", () => {
    expect(
      boardCiPaneHeadline({
        pass: pass([passStep("passed"), passStep("failed", { headline })]),
        ci: null,
        live: false,
      }),
    ).toEqual({ headline, index: 1 });
  });

  it("falls back to the card's headline only on the live pass", () => {
    const card = ci({ phase: "held", headline });
    const steps = pass([passStep("cancelled")]);
    expect(boardCiPaneHeadline({ pass: steps, ci: card, live: true })).toEqual({
      headline,
      index: null,
    });
    expect(boardCiPaneHeadline({ pass: steps, ci: card, live: false })).toBeNull();
  });
});
