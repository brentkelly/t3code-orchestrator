/**
 * The CI stage's executor (T3O-44). Pure, like every executor: it decides what
 * follows CI entry, a failed pass, or a fix agent's report.
 *
 * - Entry, or a restart: run every step from the top (`ci-pass`).
 * - A failed pass with fixes left this entry: a fix agent step in the card's
 *   worktree, told exactly what failed.
 * - A failed pass with no fixes left: back to review with the failure.
 * - A fix agent's `fixed`: every step again, from the top, so a pass always
 *   means the whole list passed on one commit.
 * - A fix agent's `return-to-review`, or no readable verdict: back to review.
 */
import {
  boardCiFixStepId,
  boardCiHeadlineLead,
  boardModelSelectionOfOverride,
  composeBoardCiFixPrompt,
  decodeBoardCiAgentStepPayload,
  decodeBoardCiFixPayload,
  isBoardCiStageExecution,
  parseBoardCiAgentStepId,
  parseBoardCiFixStepId,
} from "@t3tools/contracts";

import type {
  BoardCiFailure,
  BoardStageExecutor,
  BoardStagePlan,
  BoardStagePlanInput,
} from "../stageExecutor.ts";

/** How much of a failing step's output a send-back finding quotes. */
const FINDING_TAIL_LINES = 40;

function boardCiFailureFinding(failure: BoardCiFailure): string {
  const ended =
    failure.status === "timed-out"
      ? "timed out"
      : `exited with code ${failure.exitCode ?? "unknown"}`;
  const tail = failure.tail.split("\n").slice(-FINDING_TAIL_LINES).join("\n").trim();
  return [
    ...(failure.headline == null ? [] : [boardCiHeadlineLead(failure.headline)]),
    `CI step "${failure.stepName}" (\`${failure.command}\`) ${ended}.`,
    ...(tail.length === 0 ? [] : ["Last lines of its output:", "```", tail, "```"]),
  ].join("\n");
}

export const CiStageExecutor: BoardStageExecutor = {
  planNext(input: BoardStagePlanInput): BoardStagePlan {
    const { card, config, runState } = input;
    const agentStep =
      runState.settledStepId === null ? null : parseBoardCiAgentStepId(runState.settledStepId);
    if (agentStep !== null) {
      const completion = input.completions.findLast(
        (candidate) => candidate.stepId === runState.settledStepId,
      );
      return {
        kind: "ci-agent-done",
        runId: agentStep.runId,
        index: agentStep.index,
        verdict:
          completion?.outcome === "succeeded"
            ? decodeBoardCiAgentStepPayload(completion.payload)
            : null,
      };
    }
    const settled =
      runState.settledStepId === null ? null : parseBoardCiFixStepId(runState.settledStepId);
    if (settled !== null) {
      const completion = input.completions.findLast(
        (candidate) => candidate.stepId === runState.settledStepId,
      );
      const verdict = decodeBoardCiFixPayload(completion?.payload ?? null);
      if (verdict?.verdict === "fixed") return { kind: "ci-pass" };
      return {
        kind: "ci-return",
        stepName: null,
        finding:
          verdict === null
            ? "The CI fix agent finished without a readable verdict, so the failure goes back to review."
            : verdict.finding,
      };
    }

    const failure = runState.ciFailure ?? null;
    if (failure === null) return { kind: "ci-pass" };

    const ci = card.ci;
    const exec = config.execution;
    const maxFixAttempts =
      ci?.maxFixAttempts ?? (isBoardCiStageExecution(exec) ? exec.maxFixAttempts : 0);
    const used = ci?.fixAttempts ?? 0;
    if (ci === null || used >= maxFixAttempts) {
      return {
        kind: "ci-return",
        stepName: failure.stepName,
        finding: boardCiFailureFinding(failure),
      };
    }
    const attempt = used + 1;
    return {
      kind: "run",
      round: runState.round,
      stepId: boardCiFixStepId(ci.entry, attempt),
      stepLabel: `CI fix ${attempt} of ${maxFixAttempts}`,
      prompt: composeBoardCiFixPrompt({
        prompt: config.prompt,
        attempt,
        maxAttempts: maxFixAttempts,
        failure,
      }),
      model:
        config.cardOverride === null
          ? config.model
          : boardModelSelectionOfOverride(config.cardOverride),
      runtimeMode: config.cardOverride?.runtimeMode ?? config.runtimeMode,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      recordBaseTip: false,
    };
  },
};
