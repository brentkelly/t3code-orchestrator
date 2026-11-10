/**
 * The CI stage's executor (T3O-44/57). Pure, like every executor: it decides
 * what follows CI entry, a failed pass, or a fix agent's report. CI never
 * sends a card back to review by itself: it fixes, re-runs, and stops for a
 * human when it can't get further.
 *
 * - Entry, or a restart: run every step from the top (`ci-pass`).
 * - A failed pass with fixes left this entry: one fix agent step in the
 *   card's worktree, told every failure the pass reported.
 * - A failed pass with no fixes left: stop for a human (`ci-stop`).
 * - A fix agent's `fixed`: every step again, from the top, so a pass always
 *   means the whole list passed on one commit.
 * - A fix agent's `cannot-fix` (or the older `return-to-review`), or no
 *   readable verdict: stop for a human, with why.
 */
import {
  BOARD_CI_SHELL_FINDING_MAX,
  boardCiFixStepId,
  boardCiShellFinding,
  boardModelSelectionOfOverride,
  composeBoardCiFixPrompt,
  decodeBoardCiAgentStepPayload,
  decodeBoardCiFixPayload,
  isBoardCiStageExecution,
  parseBoardCiAgentStepId,
  parseBoardCiFixStepId,
  type BoardCardCi,
  type BoardCiFixPayload,
} from "@t3tools/contracts";

import type {
  BoardCiFailure,
  BoardStageExecutor,
  BoardStagePlan,
  BoardStagePlanInput,
} from "../stageExecutor.ts";

/** How much of a failing step's output a send-back finding quotes. */
const FINDING_TAIL_LINES = 40;

function boardCiFailureFinding(failure: BoardCiFailure, tailLines: number): string {
  const ended =
    failure.status === "timed-out"
      ? "timed out"
      : `exited with code ${failure.exitCode ?? "unknown"}`;
  const tail =
    tailLines <= 0 ? "" : failure.tail.split("\n").slice(-tailLines).join("\n").trim();
  return [
    `CI step "${failure.stepName}" (\`${failure.command}\`) ${ended}.`,
    ...(tail.length === 0 ? [] : ["Last lines of its output:", "```", tail, "```"]),
  ].join("\n");
}

/**
 * A human's "Send back to review anyway" finding (T3O-57): a line naming
 * every failed step, then each failure with as much of its tail as lets the
 * whole fit `BOARD_CI_SHELL_FINDING_MAX`.
 */
export function boardCiSendBackFinding(failures: ReadonlyArray<BoardCiFailure>): string {
  const names = [...new Set(failures.map((failure) => failure.stepName))];
  const head = `CI failed at ${names.join(", ")}.`;
  const compose = (tailLines: number) =>
    [head, ...failures.map((failure) => boardCiFailureFinding(failure, tailLines))].join("\n\n");
  for (let lines = FINDING_TAIL_LINES; lines > 0; lines = Math.floor(lines / 2)) {
    const finding = compose(lines);
    if (finding.length <= BOARD_CI_SHELL_FINDING_MAX) return finding;
  }
  return boardCiShellFinding(compose(0));
}

/** The step an issue id (`s<index>` or `s<index>-<n>`) belongs to. */
function issueStepName(ci: BoardCardCi | null, issueId: string): string | null {
  const match = /^s(\d+)(?:-\d+)?$/.exec(issueId);
  if (match === null || ci === null) return null;
  return ci.steps[Number(match[1])]?.name ?? null;
}

function cannotFixStop(ci: BoardCardCi | null, verdict: BoardCiFixPayload): BoardStagePlan {
  const issue = verdict.issues?.find((entry) => entry.status === "cannot-fix");
  const stepName = issue === undefined ? null : issueStepName(ci, issue.id);
  const finding = verdict.finding.trim().replace(/\.$/, "");
  const why = finding.length > 0 ? finding : issue?.note?.trim().replace(/\.$/, "") || "";
  const what = stepName === null ? "something" : stepName;
  return {
    kind: "ci-stop",
    stepName,
    reason: why.length > 0 ? `The fix agent couldn't fix ${what}: ${why}.` : `The fix agent couldn't fix ${what}.`,
  };
}

function exhaustedReason(failures: ReadonlyArray<BoardCiFailure>, used: number): string {
  const names = [...new Set(failures.map((failure) => failure.stepName))].join(", ");
  if (used === 0) return `CI failed: ${names}.`;
  return `CI still failing after ${used} ${used === 1 ? "fix" : "fixes"}: ${names}.`;
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
      if (verdict === null) {
        return {
          kind: "ci-stop",
          stepName: null,
          reason: "The CI fix agent finished without a readable verdict.",
        };
      }
      return cannotFixStop(card.ci, verdict);
    }

    const failures = runState.ciFailures ?? null;
    if (failures === null || failures.length === 0) return { kind: "ci-pass" };

    const ci = card.ci;
    const exec = config.execution;
    const maxFixAttempts =
      ci?.maxFixAttempts ?? (isBoardCiStageExecution(exec) ? exec.maxFixAttempts : 0);
    const used = ci?.fixAttempts ?? 0;
    if (ci === null || used >= maxFixAttempts) {
      return {
        kind: "ci-stop",
        stepName: failures[0]!.stepName,
        reason: exhaustedReason(failures, used),
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
        failures,
        issues: runState.ciIssues ?? [],
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
