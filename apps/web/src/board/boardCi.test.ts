import {
  boardCiFixStepId,
  type BoardCardCi,
  type BoardCardCiStep,
  type BoardCiPassStep,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCiFace,
  boardCiFixRow,
  boardCiLastOutcomeFace,
  boardCiPaneStatus,
  boardCiPassOutcomeChip,
  boardCiPassSummary,
  boardCiSegments,
  boardCiSentBackBanner,
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
    expect(face.fixSegment).toBe("fixing");
    // T3O-57: with an issue count, the fix leads with it.
    const counted = (fixIssues: number) =>
      boardCiFace(ci({ phase: "fixing", fixAttempts: 1, fixIssues, steps: [] }), NOW_MS).detail;
    expect(counted(3)).toBe("Fix 1 of 2 · 3 issues");
    expect(counted(1)).toBe("Fix 1 of 2 · 1 issue");
  });

  it("leads with failures so far while a pass runs on, and outlines the fix to come", () => {
    const face = boardCiFace(
      ci({
        steps: [
          step("Build", "failed"),
          step("Lint", "timed-out"),
          step("Panel", "running", "2026-01-01T00:06:00.000Z"),
          step("Browser", "pending"),
        ],
      }),
      NOW_MS,
    );
    expect(face.detail).toBe("2 failed · running Panel · 4m");
    expect(face.fixSegment).toBe("pending");
    expect(
      boardCiFace(ci({ steps: [step("Build", "running", "2026-01-01T00:06:00.000Z")] }), NOW_MS)
        .fixSegment,
    ).toBeNull();
  });

  it("is a violet Needs you chip when CI stopped for a human, and amber when it can't run", () => {
    const stopped = boardCiFace(
      ci({
        phase: "stopped",
        stopReason: "CI still failing after 3 fixes: Test.",
        steps: [step("Test", "failed")],
      }),
      NOW_MS,
    );
    expect(stopped.chip).toEqual({ label: "Needs you", tone: "attention" });
    expect(stopped.detail).toBe("CI still failing after 3 fixes: Test.");
    expect(stopped.fixSegment).toBe("stopped");
    const held = boardCiFace(ci({ phase: "held", steps: [step("Test", "cancelled")] }), NOW_MS);
    expect(held.chip).toEqual({ label: "Can't run", tone: "warning" });
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
});

describe("a failed pass's fix row (T3O-57)", () => {
  const passStep = (name: string, status: BoardCiPassStep["status"]): BoardCiPassStep => ({
    name,
    command: "x",
    timeoutMinutes: 5,
    status,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    tail: "",
  });
  const pass = {
    runId: "run-2",
    entry: 1,
    ordinal: 2,
    steps: [passStep("Build", "failed"), passStep("Lint", "passed"), passStep("Test", "failed")],
  };
  const completion = (payload: unknown) => ({
    stepId: boardCiFixStepId(1, 2),
    payload: JSON.stringify(payload),
  });

  it("is absent on a pass with no failure", () => {
    expect(
      boardCiFixRow({
        pass: { ...pass, steps: [passStep("Lint", "passed")] },
        completions: [],
        ci: null,
      }),
    ).toBeNull();
  });

  it("matches pass N to fix N, open while the fix runs, outcomes once it reports", () => {
    const running = boardCiFixRow({
      pass,
      completions: [],
      ci: { runId: "run-2", phase: "fixing", fixAttempts: 2, maxFixAttempts: 3 },
    });
    expect(running).toMatchObject({ state: "running", headline: "Fix 2 of 3 · 2 issues" });
    expect(running?.issues.map((issue) => issue.status)).toEqual(["open", "open"]);

    // Fix 1 reports for pass 1, not this one.
    const other = { stepId: boardCiFixStepId(1, 1), payload: JSON.stringify({ verdict: "fixed" }) };
    expect(boardCiFixRow({ pass, completions: [other], ci: null })).toMatchObject({
      state: "not-run",
      headline: "Not run",
    });

    const reported = boardCiFixRow({
      pass,
      completions: [
        completion({
          verdict: "cannot-fix",
          finding: "Needs a database.",
          fixedSha: "abcdef1234",
          issues: [
            { id: "s0", status: "resolved" },
            { id: "s2", status: "cannot-fix", note: "needs Postgres" },
          ],
        }),
      ],
      ci: null,
    });
    expect(reported).toMatchObject({
      state: "reported",
      headline: "1 of 2 resolved",
      fixedSha: "abcdef1234",
    });
    expect(reported?.issues.map((issue) => [issue.id, issue.status, issue.note])).toEqual([
      ["s0", "resolved", null],
      ["s2", "cannot-fix", "needs Postgres"],
    ]);
  });

  it("counts a pass's failures in its headline when there is more than one", () => {
    expect(boardCiPassSummary({ outcome: null, steps: pass.steps })).toBe("2 of 3 steps failed");
    expect(
      boardCiPassSummary({
        outcome: null,
        steps: [passStep("Build", "failed"), passStep("Lint", "passed")],
      }),
    ).toBe("Build failed");
  });
});
