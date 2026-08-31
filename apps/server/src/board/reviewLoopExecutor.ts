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
  boardReviewRoundsStarted,
  BoardReviewPayload,
  composeBoardReviewPhasePrompt,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  effectiveBoardReviewRounds,
  effectiveBoardRuntimeMode,
  isBoardReviewBlockingSeverity,
  isBoardReviewStageExecution,
  parseReviewStepId,
  reviewStepId,
  reviewStepLabel,
  type BoardCardReviewOverrides,
  type BoardModelSelection,
  type BoardReviewPhaseExecution,
  type BoardReviewRoundOverride,
  type RuntimeMode,
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

/**
 * The model a phase runs on: its own configured model, else the stage's
 * resolved fallback — UNLESS the card has overridden this round's REVIEW model
 * (t3o-22, D4).
 *
 * The override applies to the `review` phase alone. It exists to escalate the
 * reviewer when a loop will not converge — a sharper pair of eyes on the same
 * branch — and re-modelling the triager is a different decision entirely, since
 * that changes who is writing the code. Bundling both into one dropdown would
 * make "put round 4 on Opus" quietly mean more than it says.
 */
function resolvePhaseModel(input: {
  readonly phase: BoardReviewPhaseId;
  readonly phaseConfig: BoardReviewPhaseExecution;
  readonly fallback: BoardModelSelection;
  readonly roundOverride: BoardReviewRoundOverride | undefined;
}): BoardModelSelection {
  if (input.phase === "review" && input.roundOverride !== undefined) {
    const { instanceId, model, options } = input.roundOverride;
    return { instanceId, model, ...(options === undefined ? {} : { options }) };
  }
  return input.phaseConfig.model ?? input.fallback;
}

/**
 * The access level a phase runs under: the round override's when this is the
 * review phase and the override names one, else the phase config's. The
 * review stage is always build-mode (resolveBoardStageExecution forces it), so
 * an unset level defaults to `auto` (t3o-21).
 */
function resolvePhaseRuntimeMode(input: {
  readonly phase: BoardReviewPhaseId;
  readonly phaseConfig: BoardReviewPhaseExecution;
  readonly roundOverride: BoardReviewRoundOverride | undefined;
}): RuntimeMode {
  const override = input.phase === "review" ? input.roundOverride?.runtimeMode : undefined;
  return effectiveBoardRuntimeMode(override ?? input.phaseConfig.runtimeMode, "build");
}

/**
 * The pure loop state machine (D1/D3/D8): a completions array in, a decision
 * out. Walks rounds from 1; the first round whose phase sequence is incomplete
 * yields the next phase to run. Within a round, any findings at all run one
 * triage pass, and only blocking findings run adjudication. At the END of the
 * round the executor — never the agent — applies the loop check: another round
 * runs only when the round raised a blocking (critical/improvement) finding
 * AND rounds remain. Only the CONVERGENCE arm ends `succeeded`, so only a loop
 * that actually passed may auto-advance (t3o-22, D1); running out of rounds, a
 * user's stop, and a malformed payload all terminate `blocked` and leave the
 * card in Code review with its findings.
 */
export function reviewLoopDecision(input: {
  readonly review: BoardStageExecutionReview;
  readonly config: BoardStagePlanInput["config"];
  readonly completions: ReadonlyArray<BoardStepCompletion>;
  /** The card's own review-loop settings (t3o-22, D2), or null for a card that
      never touched them — in which case the stage config governs outright. */
  readonly overrides: BoardCardReviewOverrides | null;
  /** The card's in-flight step id, so the budget floor counts a round that has
      STARTED but not yet recorded anything (D3). */
  readonly liveStepId: string | null;
}): BoardStagePlan {
  const { review, config, overrides } = input;
  const done = succeededReviewSteps(input.completions);
  // The budget the loop actually runs to (D3): the card's override when it has
  // one, floored at the highest round already started so a since-lowered budget
  // can never strand a round mid-flight, and capped at the ceiling.
  const rounds = effectiveBoardReviewRounds({
    configured: review.rounds,
    overrides,
    roundsStarted: boardReviewRoundsStarted({
      completions: input.completions,
      liveStepId: input.liveStepId,
    }),
  });

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
        // The EFFECTIVE budget, not the stage setting: the prompt tells the
        // agent which round of how many it is running, and a card whose budget
        // was extended must not be told it is on the last round.
        rounds,
        prompt: phaseConfig.prompt,
      }),
      model: resolvePhaseModel({
        phase,
        phaseConfig,
        fallback: config.model,
        roundOverride: overrides?.roundModels[String(round)],
      }),
      runtimeMode: resolvePhaseRuntimeMode({
        phase,
        phaseConfig,
        roundOverride: overrides?.roundModels[String(round)],
      }),
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
    // finding AND rounds remain. A non-blocking round CONVERGED — the one exit
    // that is a verdict, so it alone completes `succeeded` and lets the stage
    // auto-advance.
    if (!blocking) {
      return { kind: "complete", outcome: "succeeded" };
    }
    // The user asked the loop to hold after this round (t3o-22, D5). Checked
    // BEFORE the budget because a stop is a decision someone made and outranks
    // rounds that merely remain. Terminates like the cap: the card stays in
    // Code review with its findings, and nothing advances.
    if (overrides?.stopAfterRound === round) {
      return { kind: "complete", outcome: "blocked" };
    }
    // Blocking findings and rounds remain: the next round's review re-reads
    // the branch with the triage fixes on it.
  }

  // The ROUND CAP (t3o-22, D1). Every round ran and none closed clean, so the
  // loop is out of budget with blocking findings still open. This is NOT a
  // converged loop wearing the same round counts: no reviewer signed anything
  // off, and the code is exactly as unreviewed as it was. It completes
  // `blocked` — the card holds in Code review with its findings visible, and
  // `advanceStage` (gated on `succeeded`) never runs, whatever the stage's
  // `autoAdvance` says. Extending the budget from the pane re-enters the loop.
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
    return reviewLoopDecision({
      review,
      config: input.config,
      completions: input.completions,
      // The card's own loop settings (t3o-22, D2) ride the card the reactor
      // already passes, so the seam needs no new input field.
      overrides: input.card.reviewOverrides,
      liveStepId: input.runState.liveStepId,
    });
  },
};
