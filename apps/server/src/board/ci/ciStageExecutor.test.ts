/**
 * The CI stage's executor and CI records (T3O-44), pure: what follows entry,
 * a failed pass and a fix agent's report, and how each record changes the
 * card and its pass rows.
 */
import {
  BOARD_CI_SHELL_FINDING_MAX,
  BoardCardId,
  BoardStageId,
  DEFAULT_BOARD_CI_STAGE_EXECUTION,
  ProviderInstanceId,
  boardCiFixStepId,
  boardStepPayloadDefect,
  type BoardCard,
  type BoardCardCi,
  type BoardCardRecordCiCommand,
  type BoardStepCompletion,
  CommandId,
  boardCiStepsFromLegacy,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeBoardCard } from "../supervisorHarness.testkit.ts";
import type { BoardCiFailure, BoardStagePlanInput } from "../stageExecutor.ts";
import { decideBoardCiRecord } from "./ciRecord.ts";
import { CiStageExecutor } from "./ciStageExecutor.ts";

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
  readonly ciFailure?: BoardCiFailure | null;
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
      ciFailure: input.ciFailure ?? null,
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
    const next = plan({ card: cardInCi(ci()), ciFailure: failure });
    expect(next.kind).toBe("run");
    if (next.kind !== "run") return;
    expect(next.stepId).toBe(boardCiFixStepId(2, 1));
    expect(next.stepLabel).toBe("CI fix 1 of 2");
    expect(next.prompt).toContain("Fix small things.");
    expect(next.prompt).toContain('CI step "Test" failed: `vp test` exited with code 2');
    expect(next.prompt).toContain("FAIL thing.test.ts");
    expect(next.prompt).toContain("/wt/.t3/ci/run-1/1.log");
    expect(next.prompt).toContain('"return-to-review"');
  });

  it("sends the card back once the entry's fixes are used", () => {
    const next = plan({ card: cardInCi(ci({ fixAttempts: 2 })), ciFailure: failure });
    expect(next).toMatchObject({ kind: "ci-return", stepName: "Test" });
    if (next.kind !== "ci-return") return;
    expect(next.finding).toContain("exited with code 2");
    expect(next.finding).toContain("FAIL thing.test.ts");
  });

  it("re-runs every step after a fix, and returns to review when told to", () => {
    const step = boardCiFixStepId(2, 1);
    expect(
      plan({
        card: cardInCi(ci({ phase: "fixing", fixAttempts: 1 })),
        settledStepId: step,
        completions: [completion(step, { verdict: "fixed", finding: "" })],
      }),
    ).toEqual({ kind: "ci-pass" });
    expect(
      plan({
        card: cardInCi(ci({ phase: "fixing", fixAttempts: 1 })),
        settledStepId: step,
        completions: [completion(step, { verdict: "return-to-review", finding: "Too big." })],
      }),
    ).toEqual({ kind: "ci-return", stepName: null, finding: "Too big." });
  });

  it("treats a fix with no readable verdict as a return to review", () => {
    const step = boardCiFixStepId(2, 1);
    const next = plan({
      card: cardInCi(ci({ phase: "fixing", fixAttempts: 1 })),
      settledStepId: step,
      completions: [completion(step, null)],
    });
    expect(next.kind).toBe("ci-return");
    expect(boardStepPayloadDefect({ stepId: step, payload: null })).toContain("verdict");
    expect(
      boardStepPayloadDefect({
        stepId: step,
        payload: JSON.stringify({ verdict: "fixed", finding: "" }),
      }),
    ).toBeNull();
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
