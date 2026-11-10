/**
 * The CI stage's executor and CI records (T3O-44/57), pure: what follows entry,
 * a failed pass and a fix agent's report, and how each record changes the
 * card and its pass rows.
 */
import {
  BOARD_CI_SHELL_FINDING_MAX,
  BoardCardId,
  BoardStageId,
  DEFAULT_BOARD_CI_STAGE_EXECUTION,
  ProviderInstanceId,
  boardCiFixIssues,
  boardCiFixStepId,
  boardStepPayloadDefect,
  type BoardCard,
  type BoardCardCi,
  type BoardCardRecordCiCommand,
  type BoardStepCompletion,
  CommandId,
  ThreadId,
  boardCiStepsFromLegacy,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeBoardCard } from "../supervisorHarness.testkit.ts";
import type { BoardCiFailure, BoardStagePlanInput } from "../stageExecutor.ts";
import { decideBoardCiRecord } from "./ciRecord.ts";
import { CiStageExecutor, boardCiSendBackFinding } from "./ciStageExecutor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ci = (overrides: Partial<BoardCardCi> = {}): BoardCardCi => ({
  runId: "run-1",
  entry: 2,
  fixAttempts: 0,
  maxFixAttempts: 2,
  phase: "running",
  steps: [
    { name: "Lint", status: "passed", startedAt: NOW, finishedAt: NOW },
    { name: "Test", status: "failed", startedAt: NOW, finishedAt: NOW },
  ],
  ...overrides,
});
const cardInCi = (state: BoardCardCi | null): BoardCard => ({
  ...makeBoardCard({ id: "c", stage: "ci", orderKey: "m" }),
  ci: state,
});
const failure: BoardCiFailure = {
  runId: "run-1",
  stepName: "Test",
  command: "vp test",
  status: "failed",
  exitCode: 2,
  tail: "FAIL thing.test.ts",
  logPath: "/wt/.t3/ci/run-1/1.log",
};

const plan = (input: {
  readonly card: BoardCard;
  readonly settledStepId?: string | null;
  readonly ciFailures?: ReadonlyArray<BoardCiFailure> | null;
  readonly completions?: ReadonlyArray<BoardStepCompletion>;
}) =>
  CiStageExecutor.planNext({
    card: input.card,
    config: {
      stepId: "ci",
      stageLabel: "Continuous integration",
      prompt: "Fix small things.",
      model: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
      runtimeMode: "full-access",
      cardOverride: null,
      timeoutMs: 60_000,
      maxAttempts: 3,
      execution: DEFAULT_BOARD_CI_STAGE_EXECUTION,
    } satisfies BoardStagePlanInput["config"],
    completions: input.completions ?? [],
    runState: {
      round: 1,
      completedStepIds: [],
      liveStepId: null,
      settledStepId: input.settledStepId ?? null,
      baseStale: false,
      baseRetargetedTo: null,
      ciFailures: input.ciFailures ?? null,
      ciIssues: boardCiFixIssues(
        (input.ciFailures ?? []).map((entry) => ({
          name: entry.stepName,
          status: entry.status,
          ...(entry.result == null ? {} : { result: entry.result }),
        })),
      ),
    },
  });

const completion = (stepId: string, payload: unknown): BoardStepCompletion => ({
  cardId: BoardCardId.make("c"),
  stepId,
  outcome: "succeeded",
  summary: "",
  payload: payload === null ? null : JSON.stringify(payload),
  threadId: null,
  completedAt: NOW,
});

describe("CiStageExecutor", () => {
  it("runs the steps on entry", () => {
    expect(plan({ card: cardInCi(null) })).toEqual({ kind: "ci-pass" });
  });

  it("gives a failed pass a fix agent that is told what failed", () => {
    const next = plan({ card: cardInCi(ci()), ciFailures: [failure] });
    expect(next.kind).toBe("run");
    if (next.kind !== "run") return;
    expect(next.stepId).toBe(boardCiFixStepId(2, 1));
    expect(next.stepLabel).toBe("CI fix 1 of 2");
    expect(next.prompt).toContain("Fix small things.");
    expect(next.prompt).toContain('CI step "Test" failed.');
    expect(next.prompt).toContain("`vp test` exited with code 2");
    expect(next.prompt).toContain("FAIL thing.test.ts");
    expect(next.prompt).toContain("/wt/.t3/ci/run-1/1.log");
    expect(next.prompt).toContain('"cannot-fix"');
  });

  it("hands every failure of a pass to one fix agent, each issue by id in order", () => {
    const lint: BoardCiFailure = {
      ...failure,
      stepName: "Lint",
      command: "vp lint",
      tail: "lint said no",
      result: {
        summary: "2 problems",
        failures: [
          { title: "unused import", file: "src/a.ts", line: 3 },
          { title: "no-explicit-any", file: "src/b.ts", line: 9 },
        ],
      },
    };
    const next = plan({ card: cardInCi(ci()), ciFailures: [lint, failure] });
    if (next.kind !== "run") throw new Error(`expected a fix step, got ${next.kind}`);
    expect(next.prompt).toContain('2 CI steps failed: "Lint", "Test".');
    const ids = [
      "[s0-1] Lint: unused import (src/a.ts:3)",
      "[s0-2] Lint: no-explicit-any",
      "[s1] Test: Test failed",
    ];
    const at = ids.map((id) => next.prompt.indexOf(id));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(next.prompt).toContain("lint said no");
    expect(next.prompt).toContain("Later failures may be caused by earlier ones.");
  });

  it("stops for a human once the entry's fixes are used", () => {
    const next = plan({
      card: cardInCi(ci({ fixAttempts: 2 })),
      ciFailures: [failure, { ...failure, stepName: "Build" }],
    });
    expect(next).toEqual({
      kind: "ci-stop",
      stepName: "Test",
      reason: "CI still failing after 2 fixes: Test, Build.",
    });
    expect(
      plan({ card: cardInCi(ci({ fixAttempts: 1, maxFixAttempts: 1 })), ciFailures: [failure] }),
    ).toMatchObject({
      reason: "CI still failing after 1 fix: Test.",
    });
    expect(
      plan({ card: cardInCi(ci({ maxFixAttempts: 0 })), ciFailures: [failure] }),
    ).toMatchObject({
      kind: "ci-stop",
      reason: "CI failed: Test.",
    });
  });

  it("re-runs every step after a fix, and stops when the agent can't fix something", () => {
    const step = boardCiFixStepId(2, 1);
    const fixing = cardInCi(ci({ phase: "fixing", fixAttempts: 1 }));
    expect(
      plan({
        card: fixing,
        settledStepId: step,
        completions: [completion(step, { verdict: "fixed", finding: "" })],
      }),
    ).toEqual({ kind: "ci-pass" });
    // A `fixed` report with no `finding` and no issues still decodes.
    expect(
      plan({
        card: fixing,
        settledStepId: step,
        completions: [completion(step, { verdict: "fixed" })],
      }),
    ).toEqual({ kind: "ci-pass" });
    const cannotFix = {
      verdict: "cannot-fix",
      finding: "The tests need a database this worktree doesn't have.",
      issues: [
        { id: "s0", status: "resolved" },
        { id: "s1", status: "cannot-fix", note: "needs Postgres" },
      ],
    };
    expect(
      plan({ card: fixing, settledStepId: step, completions: [completion(step, cannotFix)] }),
    ).toEqual({
      kind: "ci-stop",
      stepName: "Test",
      reason:
        "The fix agent couldn't fix Test: The tests need a database this worktree doesn't have.",
    });
    // The T3O-44 word means the same.
    expect(
      plan({
        card: fixing,
        settledStepId: step,
        completions: [completion(step, { ...cannotFix, verdict: "return-to-review" })],
      }),
    ).toMatchObject({ kind: "ci-stop", stepName: "Test" });
    expect(
      plan({
        card: fixing,
        settledStepId: step,
        completions: [completion(step, { verdict: "cannot-fix", finding: "Too big." })],
      }),
    ).toEqual({
      kind: "ci-stop",
      stepName: null,
      reason: "The fix agent couldn't fix something: Too big.",
    });
  });

  it("stops on a fix with no readable verdict", () => {
    const step = boardCiFixStepId(2, 1);
    const next = plan({
      card: cardInCi(ci({ phase: "fixing", fixAttempts: 1 })),
      settledStepId: step,
      completions: [completion(step, null)],
    });
    expect(next).toEqual({
      kind: "ci-stop",
      stepName: null,
      reason: "The CI fix agent finished without a readable verdict.",
    });
    expect(boardStepPayloadDefect({ stepId: step, payload: null })).toContain("verdict");
    expect(
      boardStepPayloadDefect({
        stepId: step,
        payload: JSON.stringify({ verdict: "fixed", finding: "" }),
      }),
    ).toBeNull();
    expect(
      boardStepPayloadDefect({
        stepId: step,
        payload: JSON.stringify({ verdict: "cannot-fix", finding: "No.", issues: [] }),
      }),
    ).toBeNull();
  });

  it("a human's send-back finding names every failed step and fits the shell", () => {
    const loud = {
      ...failure,
      tail: Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n"),
    };
    const finding = boardCiSendBackFinding([loud, { ...loud, stepName: "Build" }]);
    expect(finding.startsWith("CI failed at Test, Build.")).toBe(true);
    expect(finding).toContain('CI step "Build"');
    expect(finding.length).toBeLessThanOrEqual(BOARD_CI_SHELL_FINDING_MAX);
    expect(finding).toContain("line 199");
  });
});

const record = (card: BoardCard, action: BoardCardRecordCiCommand["action"]) =>
  decideBoardCiRecord(card, {
    type: "board.card.record-ci",
    commandId: CommandId.make("cmd"),
    cardId: card.id,
    action,
    createdAt: NOW,
  });

describe("decideBoardCiRecord", () => {
  const steps = boardCiStepsFromLegacy([
    { name: "Lint", command: "vp lint", timeoutMinutes: 30 },
    { name: "Test", command: "vp test", timeoutMinutes: 30 },
  ]);
  const start = (fixThreadId: string | null = null) =>
    ({
      kind: "start-pass",
      runId: "run-2",
      entry: 2,
      ordinal: 2,
      steps,
      maxFixAttempts: 2,
      logDir: null,
      queued: false,
      fixThreadId,
    }) as BoardCardRecordCiCommand["action"];

  it("starts a pass, settling a fixed one as fixed in place", () => {
    const result = record(cardInCi(ci({ phase: "fixing", fixAttempts: 1 })), start("thread-fix"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.card.ci).toMatchObject({
      runId: "run-2",
      fixAttempts: 1,
      phase: "running",
    });
    expect(result.payload.settled).toEqual([
      { runId: "run-1", outcome: "fixed-in-place", finishedAt: NOW, fixThreadId: "thread-fix" },
    ]);
    expect(result.payload.started?.steps.map((step) => step.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(result.payload.activity).toEqual({
      kind: "card-ci-pass-finished",
      ciOutcome: "fixed-in-place",
    });
  });

  it("settles a pass a restart cut off as interrupted", () => {
    const result = record(cardInCi(ci()), start());
    expect(result.ok && result.payload.settled).toEqual([
      { runId: "run-1", outcome: "interrupted", finishedAt: NOW },
    ]);
  });

  it("settles a pass a human restarted while fixing as interrupted, not fixed", () => {
    const result = record(cardInCi(ci({ phase: "fixing", fixAttempts: 2 })), start());
    expect(result.ok && result.payload.settled).toEqual([
      { runId: "run-1", outcome: "interrupted", finishedAt: NOW },
    ]);
    expect(result.ok && result.payload.activity).toBeNull();
  });

  it("holds a live pass that could not run, its unfinished steps cancelled", () => {
    const running = ci({
      phase: "running",
      steps: [
        { name: "Lint", status: "passed", startedAt: NOW, finishedAt: NOW },
        { name: "Test", status: "running", startedAt: NOW, finishedAt: null },
        { name: "Build", status: "pending", startedAt: null, finishedAt: null },
      ],
    });
    const result = record(cardInCi(running), {
      kind: "finish-pass",
      runId: "run-1",
      result: "interrupted",
    });
    expect(result.ok && result.payload.card.ci?.phase).toBe("held");
    expect(result.ok && result.payload.card.ci?.steps.map((step) => step.status)).toEqual([
      "passed",
      "cancelled",
      "cancelled",
    ]);
    // A restart from held does not settle the already-settled row again.
    const held = result.ok ? result.payload.card : cardInCi(null);
    expect(record(held, start())).toMatchObject({ ok: true, payload: { settled: [] } });
  });

  it("freezes Stop on failure on the pass, and counts a fix's issues", () => {
    const started = record(cardInCi(null), {
      ...start(),
      continueOnFailure: true,
    } as BoardCardRecordCiCommand["action"]);
    expect(started.ok && started.payload.card.ci?.continueOnFailure).toBe(true);
    const plain = record(cardInCi(null), start());
    expect(plain.ok && plain.payload.card.ci?.continueOnFailure).toBeUndefined();
    const began = record(cardInCi(ci({ continueOnFailure: true })), {
      kind: "begin-fix",
      runId: "run-1",
      fixIssues: 3,
    });
    expect(began.ok && began.payload.card.ci).toMatchObject({
      phase: "fixing",
      fixIssues: 3,
      continueOnFailure: true,
    });
    // The next pass starts clean: no issue count carried over.
    const next = record(began.ok ? began.payload.card : cardInCi(null), start("thread-fix"));
    expect(next.ok && next.payload.card.ci?.fixIssues).toBeUndefined();
    expect(next.ok && next.payload.card.ci?.continueOnFailure).toBeUndefined();
  });

  it("stops a card in CI with its fix thread on the pass row", () => {
    const stopped = record(cardInCi(ci({ phase: "fixing", fixAttempts: 2 })), {
      kind: "stop",
      runId: "run-1",
      reason: "CI still failing after 2 fixes: Test.",
      finding: "",
      fixThreadId: ThreadId.make("thread-fix"),
    });
    expect(stopped.ok && stopped.payload.card.ci).toMatchObject({
      phase: "stopped",
      stopReason: "CI still failing after 2 fixes: Test.",
    });
    expect(stopped.ok && stopped.payload.settled).toEqual([
      { runId: "run-1", outcome: "stopped", finishedAt: NOW, fixThreadId: "thread-fix" },
    ]);
  });

  it("refuses a pass for a card outside CI, and a fix past the cap", () => {
    const outside = { ...cardInCi(null), stage: BoardStageId.make("review") };
    expect(record(outside, start()).ok).toBe(false);
    expect(record(cardInCi(ci({ fixAttempts: 2 })), { kind: "begin-fix", runId: "run-1" }).ok).toBe(
      false,
    );
  });

  it("records a send-back and a skip on the card", () => {
    const sent = record(cardInCi(ci({ fixAttempts: 1 })), {
      kind: "send-back",
      runId: "run-1",
      stepName: null,
      finding: "Broken.",
      round: 2,
      fixThreadId: null,
    });
    expect(sent.ok && sent.payload.card.ciLastOutcome).toEqual({
      kind: "sent-back",
      stepName: "Test",
      fixAttemptsUsed: 1,
      finding: "Broken.",
      round: 2,
    });
    expect(sent.ok && sent.payload.card.ci).toBeNull();

    const long = record(cardInCi(ci()), {
      kind: "send-back",
      runId: "run-1",
      stepName: null,
      finding: "x".repeat(BOARD_CI_SHELL_FINDING_MAX * 10),
      round: 2,
      fixThreadId: null,
    });
    const shellFinding = long.ok ? (long.payload.card.ciLastOutcome?.finding ?? "") : "";
    expect(shellFinding.length).toBe(BOARD_CI_SHELL_FINDING_MAX);

    const skipped = record(cardInCi(ci()), { kind: "skip", actor: "Brent" });
    expect(skipped.ok && skipped.payload.card.ciLastOutcome).toEqual({
      kind: "skipped",
      actor: "Brent",
    });
    expect(skipped.ok && skipped.payload.settled).toEqual([
      { runId: "run-1", outcome: "skipped", finishedAt: NOW },
    ]);
  });
});
