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
 * yields the next phase to run. Within a round, any findings at all run one
 * triage pass, and only blocking findings run adjudication. At the END of the
 * round the executor — never the agent — applies the loop check: another round
 * runs only when the round raised a blocking (critical/improvement) finding
 * AND rounds remain. When either condition fails the loop ends `succeeded`, so
 * the stage may auto-advance; a review phase with a malformed payload
 * terminates `blocked` rather than converging (D4).
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
    const findings = reviewPayload.value.findings;
    const blocking = findings.some((f) => isBoardReviewBlockingSeverity(f.severity));

    // Any findings at all — blocking or not — get one triage pass, so even a
    // nitpick-only round gives the author a chance to fix or decline them.
    // A genuinely clean round has nothing to triage and skips straight to the
    // loop check.
    if (findings.length > 0 && done.get(reviewStepId("triage", round)) === undefined) {
      return runPhase("triage", round);
    }
    // Only blocking findings summon the adjudicator — there is no fix/reject
    // dispute to rule on when nothing blocked.
    if (blocking && done.get(reviewStepId("adjudicate", round)) === undefined) {
      return runPhase("adjudicate", round);
    }

    // The round's phases are done. The LOOP CHECK is the executor's, never the
    // agent's: another round runs only when this round raised a blocking
    // finding AND rounds remain. A non-blocking round converges here —
    // `succeeded`, so the stage may auto-advance.
    if (!blocking) {
      return { kind: "complete", outcome: "succeeded" };
    }
    // Blocking findings and rounds remain: the next round's review re-reads
    // the branch with the triage fixes on it.
  }

  // The round cap: the loop check's second condition failed, so the loop ends
  // exactly as a converged one does — `succeeded`, the stage may auto-advance —
  // with every round's findings still on the card for the next stage to see.
  return { kind: "complete", outcome: "succeeded" };
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
