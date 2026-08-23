/**
 * The Code review loop (t3o-16), behind t3o-15's `BoardStageExecutor` seam.
 *
 * Code review is not a stage that runs a prompt; it is a LOOP — review the
 * worktree, triage the findings, adjudicate the fixes, repeat until a review
 * round raises no blocking findings or a round cap stops it (D3). All of it
 * lives here, in one service registered against the `review` role. Nothing else
 * in the codebase learns review is special: the reactor keeps driving threads,
 * slots, worktrees, death detection and recovery exactly as it does for a
 * one-step stage; it only ever asks `planNext` what to run (D1).
 *
 * `planNext` is PURE — no SQL, no git, no thread handles (D1). It reads the
 * card's completion list and decides the next phase to run, or that the loop is
 * done. Each phase is its own step so it can run on its OWN model (D2), and each
 * step id is round-scoped — `review@1`, `triage@1`, `review@2` — so round-1 and
 * round-2 completions never collide under the `(cardId, stepId)` idempotency key
 * (D8). Findings ride the opaque completion payload (D4); the executor returns a
 * prompt, and the AGENT runs `git` in its worktree and records the payload.
 */
import {
  BOARD_REVIEW_PHASE_LABELS,
  BoardReviewPayload,
  composeBoardReviewPhasePrompt,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  effectiveBoardRuntimeMode,
  isBoardReviewBlockingSeverity,
  isBoardReviewStageExecution,
  parseReviewStepId,
  reviewStepId,
  reviewStepLabel,
  type BoardModelSelection,
  type BoardReviewPhaseExecution,
  type BoardReviewPhaseId,
  type BoardStageExecutionReview,
  type BoardStepCompletion,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { BoardStageExecutor, BoardStagePlan, BoardStagePlanInput } from "./stageExecutor.ts";

/**
 * A payload parse result. `absent`/`malformed` are kept distinct from a valid
 * empty findings list: a review round with a VALID empty findings list has
 * converged, while a malformed or missing payload must NEVER be read as "no
 * findings" (D4) — it fails, so the loop cannot converge on a broken reviewer.
 */
export type ParsedPayload<A> = { readonly ok: true; readonly value: A } | { readonly ok: false };

const decodeReview = Schema.decodeUnknownOption(BoardReviewPayload);

function parseJson(payload: string | null): Option.Option<unknown> {
  if (payload === null) return Option.none();
  try {
    return Option.some(JSON.parse(payload));
  } catch {
    return Option.none();
  }
}

// Only the `review` phase's payload gates the loop (convergence is decided by
// review, D3), so the executor parses only that. The triage/adjudicate payloads
// are opaque to the executor — it advances on their *presence* (a succeeded
// completion), and the card-detail view is what decodes them for display.
export function parseReviewPayload(payload: string | null): ParsedPayload<BoardReviewPayload> {
  const decoded = Option.flatMap(parseJson(payload), decodeReview);
  return Option.isSome(decoded) ? { ok: true, value: decoded.value } : { ok: false };
}

/** The convergence rule (D3/D5): a review round converges when its payload is
    valid AND carries no blocking (critical/improvement) finding. A valid empty
    list, or a nitpick-only list, converges; a malformed payload does not. */
export function reviewRoundConverged(payload: ParsedPayload<BoardReviewPayload>): boolean {
  return (
    payload.ok && !payload.value.findings.some((f) => isBoardReviewBlockingSeverity(f.severity))
  );
}

/** A card's succeeded review-loop completions, keyed by their `<phase>@<round>`
    step id, so the executor decides the next phase purely from what has landed. */
function succeededReviewSteps(
  completions: ReadonlyArray<BoardStepCompletion>,
): Map<string, BoardStepCompletion> {
  const map = new Map<string, BoardStepCompletion>();
  for (const completion of completions) {
    if (completion.outcome !== "succeeded") continue;
    if (parseReviewStepId(completion.stepId) === null) continue;
    map.set(completion.stepId, completion);
  }
  return map;
}

function resolvePhaseModel(
  phase: BoardReviewPhaseExecution,
  fallback: BoardModelSelection,
): BoardModelSelection {
  return phase.model ?? fallback;
}

/**
 * The pure loop state machine (D1/D3/D8): a completions array in, a decision
 * out. Walks rounds from 1; the first round whose phase sequence is incomplete
 * yields the next phase to run. A review phase with no blocking findings ends
 * the loop `succeeded`; a review phase with a malformed payload escalates rather
 * than converging (D4); running out of rounds ends the loop `blocked` (D8).
 */
export function reviewLoopDecision(input: {
  readonly review: BoardStageExecutionReview;
  readonly config: BoardStagePlanInput["config"];
  readonly completions: ReadonlyArray<BoardStepCompletion>;
}): BoardStagePlan {
  const { review, config } = input;
  const rounds = review.rounds;
  const done = succeededReviewSteps(input.completions);

  const runPhase = (phase: BoardReviewPhaseId, round: number): BoardStagePlan => {
    const phaseConfig = review.phases[phase];
    return {
      kind: "run",
      round,
      stepId: reviewStepId(phase, round),
      // A genuine step identity (t3o-19, D4): the review loop is the one stage
      // that runs several, so its prompts keep the full step vocabulary and
      // state the step id outright.
      stepLabel: reviewStepLabel(phase, round),
      prompt: composeBoardReviewPhasePrompt({
        phase,
        round,
        rounds: review.rounds,
        prompt: phaseConfig.prompt,
      }),
      model: resolvePhaseModel(phaseConfig, config.model),
      // The review stage is always build-mode (resolveBoardStageExecution forces
      // it), so an unset phase access level defaults to `auto` (t3o-21).
      runtimeMode: effectiveBoardRuntimeMode(phaseConfig.runtimeMode, "build"),
      timeoutMs: phaseConfig.timeoutMs,
      maxAttempts: phaseConfig.maxAttempts,
    };
  };

  for (let round = 1; round <= rounds; round++) {
    const reviewStep = done.get(reviewStepId("review", round));
    if (reviewStep === undefined) return runPhase("review", round);

    const reviewPayload = parseReviewPayload(reviewStep.payload);
    if (!reviewPayload.ok) {
      // A malformed/absent review payload must never be read as "no findings"
      // (D4). The healthy path is the agent completing the phase `failed`, which
      // the reactor's recovery ladder retries and, on exhaustion, escalates. But
      // a phase that recorded `succeeded` with an unreadable payload is a broken
      // reviewer whose completion is idempotently pinned — it can neither be
      // re-run nor be trusted — so the loop terminates `blocked` (the card stays
      // in Code review with the unreadable round visible, D9) rather than either
      // converging on unreviewed code or re-escalating forever on every re-plan.
      return { kind: "complete", outcome: "blocked" };
    }
    if (reviewRoundConverged(reviewPayload)) {
      return { kind: "complete", outcome: "succeeded" };
    }

    // Blocking findings — run triage then adjudicate, then the next round.
    if (done.get(reviewStepId("triage", round)) === undefined) return runPhase("triage", round);
    if (done.get(reviewStepId("adjudicate", round)) === undefined) {
      return runPhase("adjudicate", round);
    }
    // Round complete without converging; fall through to the next round's review.
  }

  // Every round ran without a clean review pass (D8): the stage completes
  // `blocked`, the card stays in Code review and its open findings stay visible.
  return { kind: "complete", outcome: "blocked" };
}

// The phase prompt composition (D6/D7) — round header, prior-payload pointer,
// the user's per-phase intent, then the loop protocol — lives in contracts
// (`boardEnvelope.ts`, `composeBoardReviewPhasePrompt`) so the settings UI
// shows each phase exactly the system text that wraps its editable prompt.

/**
 * The review-loop executor (D1). Resolves the review-loop config from the
 * frozen stage execution the reactor passes on `config.execution`, then defers
 * to the pure `reviewLoopDecision`. Registered against the `review` role in the
 * stage-executor registry — the single edit that teaches the pipeline about
 * review without touching the reactor.
 */
export const ReviewLoopExecutor: BoardStageExecutor = {
  planNext(input: BoardStagePlanInput): BoardStagePlan {
    const execution = input.config.execution;
    const review = isBoardReviewStageExecution(execution)
      ? execution
      : DEFAULT_BOARD_REVIEW_STAGE_EXECUTION;
    return reviewLoopDecision({ review, config: input.config, completions: input.completions });
  },
};
