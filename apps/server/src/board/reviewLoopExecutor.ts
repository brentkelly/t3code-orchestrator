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
  BoardAdjudicatePayload,
  BoardReviewPayload,
  BoardTriagePayload,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  isBoardReviewBlockingSeverity,
  isBoardReviewStageExecution,
  type BoardModelSelection,
  type BoardReviewPhaseExecution,
  type BoardReviewPhaseId,
  type BoardStageExecutionReview,
  type BoardStepCompletion,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { BoardStageExecutor, BoardStagePlan, BoardStagePlanInput } from "./stageExecutor.ts";

/** The round-scoped step id scheme (D8): `<phase>@<round>`. The one place the
    id shape is minted and parsed, so the completion key and the executor's view
    of loop progress can never drift. */
export function reviewStepId(phase: BoardReviewPhaseId, round: number): string {
  return `${phase}@${round}`;
}

const REVIEW_STEP_ID = /^(review|triage|adjudicate)@(\d+)$/;

interface ParsedReviewStep {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
}

export function parseReviewStepId(stepId: string): ParsedReviewStep | null {
  const match = REVIEW_STEP_ID.exec(stepId);
  if (match === null) return null;
  const round = Number.parseInt(match[2]!, 10);
  if (!Number.isInteger(round) || round < 1) return null;
  return { phase: match[1] as BoardReviewPhaseId, round };
}

/**
 * A payload parse result. `absent`/`malformed` are kept distinct from a valid
 * empty findings list: a review round with a VALID empty findings list has
 * converged, while a malformed or missing payload must NEVER be read as "no
 * findings" (D4) — it fails, so the loop cannot converge on a broken reviewer.
 */
export type ParsedPayload<A> = { readonly ok: true; readonly value: A } | { readonly ok: false };

const decodeReview = Schema.decodeUnknownOption(BoardReviewPayload);
const decodeTriage = Schema.decodeUnknownOption(BoardTriagePayload);
const decodeAdjudicate = Schema.decodeUnknownOption(BoardAdjudicatePayload);

function parseJson(payload: string | null): Option.Option<unknown> {
  if (payload === null) return Option.none();
  try {
    return Option.some(JSON.parse(payload));
  } catch {
    return Option.none();
  }
}

export function parseReviewPayload(payload: string | null): ParsedPayload<BoardReviewPayload> {
  const decoded = Option.flatMap(parseJson(payload), decodeReview);
  return Option.isSome(decoded) ? { ok: true, value: decoded.value } : { ok: false };
}

export function parseTriagePayload(payload: string | null): ParsedPayload<BoardTriagePayload> {
  const decoded = Option.flatMap(parseJson(payload), decodeTriage);
  return Option.isSome(decoded) ? { ok: true, value: decoded.value } : { ok: false };
}

export function parseAdjudicatePayload(
  payload: string | null,
): ParsedPayload<BoardAdjudicatePayload> {
  const decoded = Option.flatMap(parseJson(payload), decodeAdjudicate);
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
      label: `${BOARD_REVIEW_PHASE_LABELS[phase]} · round ${round}`,
      prompt: composePhasePrompt({ phase, round, phaseConfig, review }),
      model: resolvePhaseModel(phaseConfig, config.model),
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
      // (D4). The healthy path is the agent completing the phase `failed` (the
      // reactor's recovery ladder then retries); a `succeeded` completion with
      // an unreadable payload is a broken reviewer, so escalate rather than
      // converge on unreviewed code.
      return {
        kind: "escalate",
        question: `Code review round ${round} completed without a readable findings payload; a human should inspect the reviewer before the loop can proceed.`,
      };
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

/**
 * Compose the phase's agent prompt (D6/D7). The executor owns the loop protocol
 * — the round-scoped step id, the payload shape, how to read priors — and wraps
 * the user's per-phase prompt with it. Pure: it names the `git` commands but
 * never runs them; the agent does, in its worktree.
 */
function composePhasePrompt(input: {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
  readonly phaseConfig: BoardReviewPhaseExecution;
  readonly review: BoardStageExecutionReview;
}): string {
  const { phase, round, phaseConfig, review } = input;
  const stepId = reviewStepId(phase, round);
  const priorContext =
    round > 1 || phase !== "review"
      ? "Call board_get_card_context first and read the `steps` payloads: they carry every prior phase's findings, dispositions and verdicts for this card. "
      : "";
  const base = phaseConfig.prompt.trim().length > 0 ? phaseConfig.prompt.trim() : "";

  const protocol = (() => {
    switch (phase) {
      case "review":
        return [
          "Diff this card's branch against its base ref (its worktree base) and review only what changed.",
          "Record the exact commit you reviewed as `reviewedSha`.",
          "Report every problem as a finding with a stable `id`, a `severity` of `critical`, `improvement` or `nitpick`, the `file` and `line`, a `title` and a `detail`.",
          "Critical and improvement findings block the round; nitpicks never do — if there are no blocking findings the loop ends here.",
          `Complete this step by calling board_complete_step with stepId "${stepId}", a succeeded outcome, and a JSON payload { reviewedSha, findings: [...] }.`,
          "If you cannot produce a valid findings payload, complete the step with outcome failed instead — never complete succeeded with an empty or malformed payload.",
        ].join(" ");
      case "triage":
        return [
          "For each blocking finding from this round's review, either FIX it in the worktree or REJECT it with a specific reason.",
          "Make the smallest correct change and run the project's checks before finishing.",
          "Record the commit you produced as `fixedSha`.",
          `Complete this step by calling board_complete_step with stepId "${stepId}", a succeeded outcome, and a JSON payload { fixedSha, dispositions: [{ findingId, action: "fixed" | "rejected", note }] }.`,
        ].join(" ");
      case "adjudicate":
        return [
          "Rule on this round's triage. Scope yourself to exactly what changed between the review's `reviewedSha` and the triage's `fixedSha`.",
          "For each finding, decide whether a claimed fix holds and whether a rejection is justified.",
          "You cannot see problems a fix introduced — only the next review can — so do not re-review the whole branch.",
          `Complete this step by calling board_complete_step with stepId "${stepId}", a succeeded outcome, and a JSON payload { verdicts: [{ findingId, verdict, note }] } where verdict is one of fix-upheld, fix-incomplete, fix-absent, rejection-justified, rejection-unjustified.`,
        ].join(" ");
    }
  })();

  return [
    `Code review — ${BOARD_REVIEW_PHASE_LABELS[phase]}, round ${round} of up to ${review.rounds}.`,
    priorContext + base,
    protocol,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

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
