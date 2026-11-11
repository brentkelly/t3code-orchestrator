/**
 * The Code review loop: review, triage, adjudicate, repeat until a round raises nothing
 * blocking or a round cap stops it. `planNext` is pure (no SQL, git or thread handles);
 * each phase is its own step, and step ids are round-scoped (`review@1`, `triage@1`) so
 * completions never collide under the `(cardId, stepId)` idempotency key.
 */
import {
  boardReviewDismissals,
  boardReviewRoundResolution,
  composeBoardReviewFollowUpPrompt,
  isBoardReviewStuckRoundWaived,
  type BoardReviewFollowUpFinding,
  type BoardReviewFollowUpPhase,
  boardReviewRoundsStarted,
  boardStepPayloadDefect,
  composeBoardReviewPhasePrompt,
  composeBoardSyncPhasePrompt,
  DEFAULT_BOARD_REVIEW_STAGE_EXECUTION,
  effectiveBoardReviewRounds,
  effectiveBoardRuntimeMode,
  isBoardReviewStageExecution,
  parseReviewStepId,
  reviewStepId,
  reviewStepLabel,
  type BoardCardReviewOverrides,
  type BoardModelSelection,
  type BoardReviewPhaseExecution,
  type BoardReviewRoundOverride,
  type BoardCardStageModelOverride,
  boardModelSelectionOfOverride,
  type RuntimeMode,
  type BoardReviewPhaseId,
  type BoardStageExecutionReview,
  type BoardStepCompletion,
} from "@t3tools/contracts";

import type { BoardStageExecutor, BoardStagePlan, BoardStagePlanInput } from "./stageExecutor.ts";

/**
 * A payload parse result. `absent`/`malformed` are kept distinct from a valid
 * empty findings list: a review round with a VALID empty findings list has
 * converged, while a malformed or missing payload must NEVER be read as "no
 * findings" — it fails, so the loop cannot converge on a broken reviewer.
 */
export type ParsedPayload<A> = { readonly ok: true; readonly value: A } | { readonly ok: false };

/** Whether a recorded phase's payload is one nothing can read — the executor's
    half of the walk's identical check. */
function unreadableStep(completion: BoardStepCompletion): boolean {
  return (
    boardStepPayloadDefect({ stepId: completion.stepId, payload: completion.payload }) !== null
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

/**
 * The model a phase runs on: its own, else the stage's fallback. A card's review-model
 * override applies to the `review` phase alone: escalating the reviewer must not also
 * re-model the triager, which changes who writes the code.
 */
function resolvePhaseModel(input: {
  readonly phase: BoardReviewPhaseId;
  readonly phaseConfig: BoardReviewPhaseExecution;
  readonly fallback: BoardModelSelection;
  readonly roundOverride: BoardReviewRoundOverride | undefined;
  readonly cardOverride: BoardCardStageModelOverride | null;
}): BoardModelSelection {
  if (input.phase === "review") {
    // Narrowest first: the round the user named, then the card's
    // standing choice, then the configured phase model. The card override sits
    // BELOW the round override so escalating one round still wins, and ABOVE
    // the phase config so setting it on the card actually takes effect.
    if (input.roundOverride !== undefined) {
      return boardModelSelectionOfOverride(input.roundOverride);
    }
    if (input.cardOverride !== null) {
      return boardModelSelectionOfOverride(input.cardOverride);
    }
  }
  return input.phaseConfig.model ?? input.fallback;
}

/**
 * The access level a phase runs under: the round override's when this is the
 * review phase and the override names one, else the phase config's. The
 * review stage is always build-mode (resolveBoardStageExecution forces it), so
 * an unset level defaults to `auto`.
 */
function resolvePhaseRuntimeMode(input: {
  readonly phase: BoardReviewPhaseId;
  readonly phaseConfig: BoardReviewPhaseExecution;
  readonly roundOverride: BoardReviewRoundOverride | undefined;
  readonly cardOverride: BoardCardStageModelOverride | null;
}): RuntimeMode {
  // Same ladder as the model, and independently resolved: an
  // override that names a model but no access level inherits the level from
  // the next rung down rather than dragging its own absence with it.
  const override =
    input.phase === "review"
      ? (input.roundOverride?.runtimeMode ?? input.cardOverride?.runtimeMode)
      : undefined;
  return effectiveBoardRuntimeMode(override ?? input.phaseConfig.runtimeMode, "build");
}

/**
 * The pure loop state machine: completions in, a decision out. Only the convergence
 * exit ends `succeeded`, so only a loop that passed may auto-advance; a stuck round,
 * running out of rounds, a user's stop and a malformed payload all end `blocked`.
 * Round rules live in contracts (`boardReviewRoundResolution`).
 */
function reviewLoopDecision(input: {
  readonly review: BoardStageExecutionReview;
  readonly config: BoardStagePlanInput["config"];
  readonly completions: ReadonlyArray<BoardStepCompletion>;
  /** The card's own review-loop settings, or null for a card that
      never touched them — in which case the stage config governs outright. */
  readonly overrides: BoardCardReviewOverrides | null;
  /** The card's in-flight step id, so the budget floor counts a round that has
      STARTED but not yet recorded anything. */
  readonly liveStepId: string | null;
  /**
   * Whether the card's base moved since `baseTipAtRoundStart` (always false for a top-level
   * card). A converged round over a stale base plans the sync step instead of completing,
   * so merge is never reached with an unreviewed combined diff.
   */
  readonly baseStale: boolean;
  /** The card's recorded base branch, for the sync prompt; null when the card
      has no worktree slice (in which case `baseStale` is false anyway). */
  readonly baseRefName: string | null;
  /** The base a human RETARGETED the card at, when that differs
      from `baseRefName`; null for the ordinary tip-moved staleness. Read only
      to word the sync prompt — the rebase mechanics are identical either way. */
  readonly baseRetargetedTo: string | null;
  /** The failure CI sent the card back with, surfaced as must-fix
      in the round the send-back opened and no other. */
  readonly ciFinding?: {
    readonly stepName: string | null;
    readonly finding: string;
    readonly round: number;
  } | null;
}): BoardStagePlan {
  const { review, config, overrides } = input;
  const done = succeededReviewSteps(input.completions);
  // The budget the loop actually runs to: the card's override when it has
  // one, floored at the highest round already started so a since-lowered budget
  // can never strand a round mid-flight, and capped at the ceiling.
  const rounds = effectiveBoardReviewRounds({
    configured: review.rounds,
    overrides,
    roundsStarted: boardReviewRoundsStarted({
      completions: input.completions,
      liveStepId: input.liveStepId,
    }),
    completions: input.completions,
  });
  const carriedFindings = overrides?.carriedFindings ?? {};

  const runPhase = (
    phase: BoardReviewPhaseId,
    round: number,
    carried: ReadonlyArray<BoardReviewFollowUpFinding>,
  ): BoardStagePlan => {
    const phaseConfig = review.phases[phase];
    return {
      kind: "run",
      round,
      stepId: reviewStepId(phase, round),
      // A genuine step identity: the review loop is the one stage
      // that runs several, so its prompts keep the full step vocabulary and
      // state the step id outright.
      stepLabel: reviewStepLabel(phase, round),
      prompt: composeBoardReviewPhasePrompt({
        phase,
        round,
        // The EFFECTIVE budget, not the stage setting, so an extended card is not told it is on
        // its last round. A gate round runs past the budget, so the header floors at the round.
        rounds: Math.max(rounds, round),
        prompt: phaseConfig.prompt,
        draftPullRequests: review.draftPullRequests,
        // A card CI sent back carries the failure into the round it
        // opened only, so later rounds can converge once triage fixed it.
        ciFinding: input.ciFinding?.round === round ? input.ciFinding : null,
        carried,
        dismissals: boardReviewDismissals(carriedFindings, round),
      }),
      model: resolvePhaseModel({
        phase,
        phaseConfig,
        fallback: config.model,
        roundOverride: overrides?.roundModels[String(round)],
        cardOverride: config.cardOverride,
      }),
      runtimeMode: resolvePhaseRuntimeMode({
        phase,
        phaseConfig,
        roundOverride: overrides?.roundModels[String(round)],
        cardOverride: config.cardOverride,
      }),
      timeoutMs: phaseConfig.timeoutMs,
      maxAttempts: phaseConfig.maxAttempts,
      // Only a review phase STARTS a round: the reactor records
      // the base tip fresh when it starts and carries it forward for the
      // round's later steps.
      recordBaseTip: phase === "review",
    };
  };

  // A follow-up pass: re-triage or re-adjudicate inside the round,
  // on just the findings the adjudicator overruled. Machinery like sync, but
  // it runs as the phase it follows up — that phase's prompt, model and
  // limits — since it is the same job asked again.
  const runFollowUp = (
    phase: BoardReviewFollowUpPhase,
    round: number,
    findings: ReadonlyArray<BoardReviewFollowUpFinding>,
  ): BoardStagePlan => {
    const basePhase: BoardReviewPhaseId = phase === "retriage" ? "triage" : "adjudicate";
    const phaseConfig = review.phases[basePhase];
    return {
      kind: "run",
      round,
      stepId: reviewStepId(phase, round),
      stepLabel: reviewStepLabel(phase, round),
      prompt: composeBoardReviewFollowUpPrompt({
        phase,
        round,
        rounds: Math.max(rounds, round),
        prompt: phaseConfig.prompt,
        findings,
        dismissals: boardReviewDismissals(carriedFindings, round),
        draftPullRequests: review.draftPullRequests,
      }),
      model: resolvePhaseModel({
        phase: basePhase,
        phaseConfig,
        fallback: config.model,
        roundOverride: undefined,
        cardOverride: config.cardOverride,
      }),
      runtimeMode: resolvePhaseRuntimeMode({
        phase: basePhase,
        phaseConfig,
        roundOverride: undefined,
        cardOverride: config.cardOverride,
      }),
      timeoutMs: phaseConfig.timeoutMs,
      maxAttempts: phaseConfig.maxAttempts,
      recordBaseTip: false,
    };
  };

  // The sync-base step is machinery, not a configured phase: it runs on the stage's model
  // with a compiled-in prompt and records no tip of its own (the gate round that follows
  // re-measures).
  const runSync = (round: number): BoardStagePlan => ({
    kind: "run",
    round,
    stepId: reviewStepId("sync", round),
    stepLabel: reviewStepLabel("sync", round),
    prompt: composeBoardSyncPhasePrompt({
      round,
      baseRefName: input.baseRefName,
      retargetedTo: input.baseRetargetedTo,
      draftPullRequests: review.draftPullRequests,
    }),
    model: config.model,
    runtimeMode: config.runtimeMode,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    recordBaseTip: false,
  });

  // Every arm that ends a round without another review goes through here, so each honours
  // the same holds in order: a sync that ran owes its gate round unconditionally, a stale
  // base plans a sync unless the user's stop holds, then a human-requested round outranks
  // the exit.
  const convergeExit = (round: number, passed: boolean): BoardStagePlan | "continue" => {
    const syncStep = done.get(reviewStepId("sync", round));
    if (syncStep !== undefined) {
      // A sync whose `{ rebasedSha }` cannot be read leaves the gate round
      // with no recorded tip to have been rebased onto.
      if (unreadableStep(syncStep)) return { kind: "complete", outcome: "blocked" };
      return "continue";
    }
    if (input.baseStale) {
      if (overrides?.stopAfterRound === round) return { kind: "complete", outcome: "blocked" };
      return runSync(round);
    }
    if (round < (overrides?.runThroughRound ?? 0)) return "continue";
    // Only a round that actually passed completes `succeeded` and may
    // auto-advance. A waived stuck round ends `advanced`, which never does:
    // the human already moved the card, and dragging it back must not start a
    // paid round by itself.
    return { kind: "complete", outcome: passed ? "succeeded" : "blocked" };
  };

  for (let round = 1; ; round++) {
    // A gate round is owed by the previous round's recorded sync
    // step and runs whatever the budget says — it is a gate, not a negotiation
    // — so only a budget round is stopped by the cap.
    const gateRound = round > 1 && done.get(reviewStepId("sync", round - 1)) !== undefined;
    if (round > rounds && !gateRound) break;
    // The round's phases, second pass and stuck rule live in contracts so the
    // walk, the completion handler and this executor share one definition.
    // A malformed record is never read as "no findings": it halts the
    // loop `blocked`, where the pane offers the Reopen that repairs it.
    const resolution = boardReviewRoundResolution({ round, done, carriedFindings });
    switch (resolution.kind) {
      case "run":
        return resolution.phase === "retriage" || resolution.phase === "readjudicate"
          ? runFollowUp(resolution.phase, round, resolution.findings)
          : runPhase(resolution.phase, round, resolution.findings);
      case "unreadable":
        return { kind: "complete", outcome: "blocked" };
      case "continue":
        // The user asked the loop to hold after this round,
        // checked before the budget because a stop outranks rounds that merely
        // remain. Otherwise the next round re-reads the branch.
        if (overrides?.stopAfterRound === round) return { kind: "complete", outcome: "blocked" };
        continue;
      case "stuck": {
        // A dispute survived the second pass: stop for a human,
        // ahead of the stop and the budget, until a human passes the round.
        if (!isBoardReviewStuckRoundWaived(overrides?.stuckWaivedThrough, round)) {
          return { kind: "complete", outcome: "blocked" };
        }
        const exit = convergeExit(round, false);
        if (exit === "continue") continue;
        return exit;
      }
      case "converge": {
        const exit = convergeExit(round, true);
        if (exit === "continue") continue;
        return exit;
      }
    }
  }

  // The round cap: blocking findings are still open, so this is NOT a converged loop. It
  // completes `blocked` and `advanceStage` (gated on `succeeded`) never runs, whatever
  // `autoAdvance` says. Extending the budget re-enters the loop.
  return { kind: "complete", outcome: "blocked" };
}

// The phase prompt composition — round header, prior-payload pointer,
// the user's per-phase intent, then the loop protocol — lives in contracts
// (`boardEnvelope.ts`, `composeBoardReviewPhasePrompt`) so the settings UI
// shows each phase exactly the system text that wraps its editable prompt.

/**
 * Resolves the review-loop config from the frozen stage execution on `config.execution`,
 * then defers to the pure `reviewLoopDecision`.
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
      // The card's own loop settings ride the card the reactor
      // already passes, so the seam needs no new input field.
      overrides: input.card.reviewOverrides,
      liveStepId: input.runState.liveStepId,
      // Reactor-measured: pure planNext cannot rev-parse.
      baseStale: input.runState.baseStale,
      baseRefName: input.card.worktree?.baseRefName ?? null,
      baseRetargetedTo: input.runState.baseRetargetedTo,
      // A card CI sent back carries the failure into the round the
      // send-back opened.
      ciFinding:
        input.card.ciLastOutcome?.kind === "sent-back" &&
        input.card.ciLastOutcome.round !== undefined
          ? {
              stepName: input.card.ciLastOutcome.stepName ?? null,
              finding: input.card.ciLastOutcome.finding ?? "",
              round: input.card.ciLastOutcome.round,
            }
          : null,
    });
  },
};
